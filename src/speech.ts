import { iuHeaders, iuUrl } from "./iu";
import { recordUsage } from "./usage";

/** TTS: straight proxy of OpenAI's `/audio/speech`, returns the audio stream. */
export async function handleSpeech(req: Request): Promise<Response> {
  const body = await req.text();
  let model = "";
  let inputChars = 0;
  try {
    const json = JSON.parse(body) as Record<string, unknown>;
    model = typeof json["model"] === "string" ? json["model"] : "";
    inputChars = typeof json["input"] === "string" ? json["input"].length : 0;
  } catch {
    // non-JSON body: forward as-is, log what we can
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
