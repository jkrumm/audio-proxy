import { config } from "./config";
import { iuHeaders, iuUrl } from "./iu";
import { handleSpeech } from "./speech";
import { handleTranscriptions } from "./transcriptions";

/** Optional bearer-token gate. No-op when PROXY_API_KEY is unset. */
const authorized = (req: Request): boolean => {
  if (!config.proxyApiKey) return true;
  return req.headers.get("authorization") === `Bearer ${config.proxyApiKey}`;
};

async function handleModels(): Promise<Response> {
  const res = await fetch(iuUrl("/models"), { headers: iuHeaders() });
  return new Response(await res.text(), {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
  });
}

const server = Bun.serve({
  port: config.port,
  idleTimeout: 255, // transcription of longer clips can take a while
  async fetch(req) {
    const path = new URL(req.url).pathname;

    if (req.method === "GET" && path === "/health") {
      return Response.json({ ok: true, service: "audio-proxy" });
    }

    if (!authorized(req)) {
      return Response.json({ error: { message: "unauthorized", type: "invalid_request_error" } }, { status: 401 });
    }

    try {
      // Match regardless of /v1 prefix so OpenAI clients with either base form work.
      if (req.method === "POST" && path.endsWith("/audio/transcriptions")) return await handleTranscriptions(req);
      if (req.method === "POST" && path.endsWith("/audio/speech")) return await handleSpeech(req);
      if (req.method === "GET" && path.endsWith("/models")) return await handleModels();
    } catch (err) {
      const message = err instanceof Error ? err.message : "internal error";
      return Response.json({ error: { message, type: "proxy_error" } }, { status: 500 });
    }

    return Response.json({ error: { message: `no route for ${req.method} ${path}`, type: "not_found" } }, { status: 404 });
  },
});

console.log(`audio-proxy listening on http://localhost:${server.port} → ${config.iuBaseUrl}`);
