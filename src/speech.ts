import { handleGeminiSpeech } from "./gemini-tts";
import { iuHeaders, iuUrl } from "./iu";
import { recordUsage } from "./usage";

/** Models served by the native Gemini `generateContent` route, not OpenAI `/audio/speech`. */
const GEMINI_TTS = /gemini.*tts/i;

/**
 * TTS dispatcher. Gemini TTS models route to the native synth pipeline
 * (`gemini-tts.ts`); everything else is a straight proxy of OpenAI's
 * `/audio/speech`, returning the audio stream unchanged.
 */
export async function handleSpeech(req: Request): Promise<Response> {
  const body = await req.text();
  let model = "";
  let inputChars = 0;
  let input = "";
  let voice = "";
  let responseFormat = "";
  try {
    const json = JSON.parse(body) as Record<string, unknown>;
    model = typeof json["model"] === "string" ? json["model"] : "";
    input = typeof json["input"] === "string" ? json["input"] : "";
    inputChars = input.length;
    voice = typeof json["voice"] === "string" ? json["voice"] : "";
    responseFormat = typeof json["response_format"] === "string" ? json["response_format"] : "";
  } catch {
    // non-JSON body: forward as-is, log what we can
  }

  if (GEMINI_TTS.test(model)) {
    return handleGeminiSpeech({ model, input, voice, responseFormat });
  }

  const start = Date.now();
  const res = await fetch(iuUrl("/audio/speech"), {
    method: "POST",
    headers: iuHeaders({ "content-type": "application/json" }),
    body,
  });
  const latencyMs = Date.now() - start;
  const audio = await res.arrayBuffer();

  recordUsage({
    endpoint: "speech",
    model,
    status: res.status,
    latencyMs,
    inputChars,
    bytesOut: audio.byteLength,
  });

  return new Response(audio, {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "audio/mpeg" },
  });
}
