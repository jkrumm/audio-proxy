import { config } from "./config";
import type { PrepChunk, PrepResult } from "./gemini-tts-core";
import { parsePrepResponse, SAMPLE_RATE_DEFAULT } from "./gemini-tts-core";
import { iuGeminiUrl, iuHeaders, iuUrl } from "./iu";
import { recordUsage } from "./usage";

// Gemini TTS pipeline. The OpenAI-compatible `/audio/speech` route 404s for
// Gemini voice models — TTS only answers on the native `generateContent`
// endpoint with an AUDIO response modality, returning base64 PCM (L16, 24 kHz,
// mono). We (1) rewrite the text into Hermes-styled chunks via a cheap prep LLM,
// (2) synthesize each chunk on Gemini, (3) concatenate the raw PCM, and (4)
// transcode to a compressed MP3/Opus via ffmpeg. See modelpick docs/gemini-tts.md.

/** The 30 prebuilt Gemini voices (docs/gemini-tts.md). Requests outside this set fall back to Charon. */
const VOICES = new Set([
  // Male
  "Charon", "Schedar", "Iapetus", "Algieba", "Orus", "Puck", "Enceladus", "Sadachbia",
  "Rasalgethi", "Sadaltager", "Achird", "Umbriel", "Alnilam", "Fenrir", "Algenib", "Zubenelgenubi",
  // Female
  "Sulafat", "Kore", "Leda", "Callirrhoe", "Despina", "Laomedeia", "Gacrux", "Pulcherrima",
  "Vindemiatrix", "Zephyr", "Aoede", "Autonoe", "Erinome", "Achernar",
]);
const DEFAULT_VOICE = "Charon";

const SILENCE_MS = 400;

export interface GeminiSpeechRequest {
  model: string;
  input: string;
  voice: string;
  responseFormat: string;
}

const PREP_SYSTEM_PROMPT = `You prepare text for Gemini text-to-speech in the persona of Hermes — a calm, warm, concise "sharp older friend". No greetings, no filler, substance first.

Your job, in order:
1. Detect the language of the input: "de" (German) or "en" (English).
2. Rewrite numbers, times, dates, units and abbreviations into the spoken form IN that language (German: "Viertel nach neun", "neunzig Kilo", "achtzehn Uhr dreißig"; English: "quarter past nine", "ninety kilos"). Do not translate the text — keep its language.
3. Split the text into chunks of at most ~600 words, breaking only at sentence boundaries, so each chunk is ~2–3 minutes of speech. Short text is a single chunk.
4. For each chunk, write a "style" directive (one short sentence) IN the transcript's language describing the warm, calm Hermes delivery, and embed 1–2 SPARSE inline tags inside the chunk's "text" at natural points. Use only these tags: German [pause] [nachdenklich] [lacht] [seufzt] [begeistert] [bestimmt] [flüsternd]; English [pause] [thoughtful] [chuckles] [sigh] [excited] [firm] [whispers]. Do not over-tag — one or two per chunk. Tags are performance cues, never read aloud.

Return STRICT JSON only, no markdown, no commentary:
{"lang":"de"|"en","chunks":[{"style":"<directive>","text":"<transcript with inline tags>"}]}`;

/** Crude German detection for the no-LLM default path (off / short+long-mode). */
function looksGerman(text: string): boolean {
  if (/[äöüßÄÖÜ]/.test(text)) return true;
  return /\b(der|die|das|und|nicht|ein|eine|ist|mit|für|auch|werden|heute)\b/i.test(text);
}

/** Build a single-chunk PrepResult with a default Hermes style directive — no LLM call. */
function defaultPrep(input: string): PrepResult {
  const de = looksGerman(input);
  const style = de
    ? "Lies als warmer, ruhiger Erzähler, ohne Begrüßung, sachlich und natürlich"
    : "Read as a warm, calm narrator, no greeting, natural and matter-of-fact";
  return { lang: de ? "de" : "en", chunks: [{ style, text: input.trim() }] };
}

interface RawResponse {
  status: number;
  body: string;
}

/** fetch with backoff retry on 503/429 (mirrors modelpick's transient-failure handling). */
async function rawFetch(url: string, init: RequestInit, attempts = 3): Promise<RawResponse> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const res = await fetch(url, init);
    if ((res.status === 503 || res.status === 429) && attempt < attempts) {
      await Bun.sleep(500 * attempt);
      continue;
    }
    return { status: res.status, body: await res.text() };
  }
  throw new Error("unreachable");
}

interface OpenAiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

/** Run the prep LLM (OpenAI dialect) and record a `speech-prep` usage row. */
async function runPrep(input: string): Promise<PrepResult> {
  const isLong = input.length >= config.ttsChunkCharThreshold;
  if (config.ttsPrep === "off") return defaultPrep(input);
  if (config.ttsPrep === "long" && !isLong) return defaultPrep(input);

  const start = Date.now();
  const res = await rawFetch(iuUrl("/chat/completions"), {
    method: "POST",
    headers: iuHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({
      model: config.ttsPrepModel,
      messages: [
        { role: "system", content: PREP_SYSTEM_PROMPT },
        { role: "user", content: input },
      ],
      // Reasoning-capable OpenAI models reject `max_tokens`; the modern field works.
      max_completion_tokens: Math.min(32000, Math.max(2000, input.length + 1000)),
    }),
  });
  const latencyMs = Date.now() - start;

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`TTS prep failed: HTTP ${res.status} ${res.body.slice(0, 300)}`);
  }

  const json = JSON.parse(res.body) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: OpenAiUsage;
  };
  recordUsage({
    endpoint: "speech-prep",
    model: config.ttsPrepModel,
    status: res.status,
    latencyMs,
    inputChars: input.length,
    usageJson: json.usage,
  });

  const content = json.choices?.[0]?.message?.content ?? "";
  return parsePrepResponse(content);
}

interface GeminiTtsResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string } }> };
  }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

interface ChunkAudio {
  pcm: Uint8Array;
  sampleRate: number;
}

/** Synthesize one chunk on Gemini and record a `speech` usage row. Fails loudly on missing audio. */
async function synthChunk(model: string, voiceName: string, chunk: PrepChunk): Promise<ChunkAudio> {
  const start = Date.now();
  const res = await rawFetch(iuGeminiUrl(`/models/${model}:generateContent`), {
    method: "POST",
    headers: iuHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({
      contents: [{ parts: [{ text: `${chunk.style}: ${chunk.text}` }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        temperature: 1.0,
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
      },
    }),
  });
  const latencyMs = Date.now() - start;

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Gemini TTS failed: HTTP ${res.status} ${res.body.slice(0, 300)}`);
  }

  const parsed = JSON.parse(res.body) as GeminiTtsResponse;
  const inline = parsed.candidates?.[0]?.content?.parts?.[0]?.inlineData;
  if (!inline?.data) {
    throw new Error(`Gemini TTS returned no audio: HTTP ${res.status} ${res.body.slice(0, 300)}`);
  }
  const pcm = Uint8Array.from(Buffer.from(inline.data, "base64"));
  const sampleRate = Number(/rate=(\d+)/.exec(inline.mimeType ?? "")?.[1]) || SAMPLE_RATE_DEFAULT;

  recordUsage({
    endpoint: "speech",
    model,
    status: res.status,
    latencyMs,
    inputTokens: parsed.usageMetadata?.promptTokenCount ?? null,
    outputTokens: parsed.usageMetadata?.candidatesTokenCount ?? null,
    audioSeconds: pcm.byteLength / (2 * sampleRate),
    bytesOut: pcm.byteLength,
  });

  return { pcm, sampleRate };
}

/** Concatenate s16le PCM chunks with SILENCE_MS of silence between them. */
function concatPcm(parts: ChunkAudio[]): { pcm: Uint8Array; sampleRate: number } {
  const sampleRate = parts[0]?.sampleRate ?? SAMPLE_RATE_DEFAULT;
  const silenceBytes = Math.round((SILENCE_MS / 1000) * sampleRate) * 2; // 16-bit mono
  const gaps = Math.max(0, parts.length - 1);
  const total = parts.reduce((n, p) => n + p.pcm.byteLength, 0) + gaps * silenceBytes;
  const out = new Uint8Array(total);
  let offset = 0;
  parts.forEach((p, i) => {
    out.set(p.pcm, offset);
    offset += p.pcm.byteLength;
    if (i < parts.length - 1) offset += silenceBytes; // leave zeroed silence
  });
  return { pcm: out, sampleRate };
}

interface Encoded {
  bytes: ArrayBuffer;
  contentType: string;
}

/** Transcode raw s16le PCM to compressed MP3 (default) or Opus/OGG via ffmpeg. */
async function transcode(pcm: Uint8Array, sampleRate: number, opus: boolean): Promise<Encoded> {
  const codec = opus
    ? ["-c:a", "libopus", "-b:a", "32k", "-f", "ogg"]
    : ["-c:a", "libmp3lame", "-b:a", `${config.ttsBitrateKbps}k`, "-f", "mp3"];
  const proc = Bun.spawn(
    ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "s16le", "-ar", String(sampleRate), "-ac", "1", "-i", "pipe:0", ...codec, "pipe:1"],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  // Read stdout/stderr concurrently with the write so the output pipe never deadlocks.
  const stdout = new Response(proc.stdout).arrayBuffer();
  const stderr = new Response(proc.stderr).text();
  proc.stdin.write(pcm);
  await proc.stdin.end();
  const [bytes, errText, exitCode] = await Promise.all([stdout, stderr, proc.exited]);
  if (exitCode !== 0) {
    throw new Error(`ffmpeg transcode failed (${exitCode}): ${errText.slice(0, 300)}`);
  }
  return { bytes, contentType: opus ? "audio/ogg" : "audio/mpeg" };
}

export async function handleGeminiSpeech(reqBody: GeminiSpeechRequest): Promise<Response> {
  const { model, input, voice, responseFormat } = reqBody;
  if (!config.iuGeminiBaseUrl) {
    throw new Error("IU_GEMINI_BASE_URL is not configured — required for Gemini TTS");
  }
  if (!input.trim()) {
    return Response.json({ error: { message: "input is required", type: "invalid_request_error" } }, { status: 400 });
  }

  const voiceName = VOICES.has(voice) ? voice : DEFAULT_VOICE;
  const prep = await runPrep(input);

  const parts: ChunkAudio[] = [];
  for (const chunk of prep.chunks) {
    parts.push(await synthChunk(model, voiceName, chunk));
  }

  const { pcm, sampleRate } = concatPcm(parts);
  const { bytes, contentType } = await transcode(pcm, sampleRate, responseFormat === "opus");

  return new Response(bytes, { status: 200, headers: { "content-type": contentType } });
}
