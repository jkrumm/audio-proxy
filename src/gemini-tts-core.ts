// Pure, config-free transforms for the Gemini TTS pipeline: PCM/WAV framing and
// prep-response parsing. Kept separate from gemini-tts.ts (which boots config,
// fetch and ffmpeg) so these can be unit-tested without any environment.

export const SAMPLE_RATE_DEFAULT = 24000;

export interface PrepChunk {
  /** Natural-language delivery directive, in the transcript's language. Spoken as direction, not aloud. */
  style: string;
  /** The transcript to speak, with sparse inline tags embedded. */
  text: string;
}

export interface PrepResult {
  lang: string;
  chunks: PrepChunk[];
}

/**
 * Wrap raw s16le PCM in a 44-byte WAV header (mono, 16-bit). Not used by the
 * ffmpeg path (which consumes raw `-f s16le`), but kept as a documented
 * single-chunk fallback and exercised by the header unit test.
 */
export function pcmToWav(pcm: Uint8Array, sampleRate = SAMPLE_RATE_DEFAULT, channels = 1, bitsPerSample = 16): ArrayBuffer {
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const buffer = new ArrayBuffer(44 + pcm.byteLength);
  const view = new DataView(buffer);
  const writeStr = (off: number, s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true); // PCM subchunk size
  view.setUint16(20, 1, true); // audio format = PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeStr(36, "data");
  view.setUint32(40, pcm.byteLength, true);
  new Uint8Array(buffer, 44).set(pcm);
  return buffer;
}

/**
 * Parse the prep LLM's reply into a PrepResult. Tolerates markdown code fences
 * and leading/trailing prose by extracting the first balanced JSON object.
 * Throws if no usable `{lang, chunks:[{style,text}]}` shape is present.
 */
export function parsePrepResponse(raw: string): PrepResult {
  const fenced = raw.replace(/```(?:json)?/gi, "").trim();
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`prep returned no JSON object: ${raw.slice(0, 200)}`);
  }
  const parsed = JSON.parse(fenced.slice(start, end + 1)) as {
    lang?: unknown;
    chunks?: unknown;
  };
  if (!Array.isArray(parsed.chunks) || parsed.chunks.length === 0) {
    throw new Error(`prep returned no chunks: ${raw.slice(0, 200)}`);
  }
  const chunks: PrepChunk[] = parsed.chunks.map((c) => {
    const obj = (c ?? {}) as { style?: unknown; text?: unknown };
    const text = typeof obj.text === "string" ? obj.text.trim() : "";
    if (!text) throw new Error("prep chunk missing text");
    return { style: typeof obj.style === "string" ? obj.style.trim() : "", text };
  });
  const lang = typeof parsed.lang === "string" ? parsed.lang : "";
  return { lang, chunks };
}
