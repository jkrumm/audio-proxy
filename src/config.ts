const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
};

export const config = {
  port: Number(process.env["PORT"] ?? 7716),
  iuApiKey: required("IU_API_KEY"),
  iuBaseUrl: required("IU_OPENAI_BASE_URL").replace(/\/+$/, ""),
  /**
   * IU Gemini (native `generateContent`) base, e.g. `.../gemini/v1beta`. Optional
   * at startup — only a Gemini TTS request needs it, so STT-only deployments boot
   * without it. `gemini-tts.ts` fails loudly when it is missing at request time.
   */
  iuGeminiBaseUrl: (process.env["IU_GEMINI_BASE_URL"] ?? "").replace(/\/+$/, ""),
  usageDb: process.env["USAGE_DB"] ?? "./data/usage.db",
  /** When set, callers must send `Authorization: Bearer <proxyApiKey>`. */
  proxyApiKey: process.env["PROXY_API_KEY"] ?? "",
  /** Default STT `language` (ISO-639-1, e.g. `de`) injected when the client sends none. */
  sttLanguage: process.env["STT_LANGUAGE"] ?? "",
  /** Default STT `prompt` injected when the client sends none — steers expected language. */
  sttPrompt: process.env["STT_PROMPT"] ?? "",
  /** Gemini TTS prep model (OpenAI dialect) that rewrites text into Hermes-styled chunks. */
  ttsPrepModel: process.env["TTS_PREP_MODEL"] ?? "gpt-5.4-mini",
  /** MP3 bitrate (kbps) for the transcoded Gemini TTS output. */
  ttsBitrateKbps: Number(process.env["TTS_MP3_BITRATE"] ?? 64),
  /** Below this input length the prep step short-circuits to a single chunk. */
  ttsChunkCharThreshold: Number(process.env["TTS_CHUNK_THRESHOLD"] ?? 1200),
  /**
   * Prep behaviour for Gemini TTS:
   * - `always` (default): run the LLM prep for every request (short input → one cheap call).
   * - `long`: only run the LLM prep when input >= threshold; short input uses a default style.
   * - `off`: never call the LLM; speak the raw text with a default persona style directive.
   */
  ttsPrep: (process.env["TTS_PREP"] ?? "always") as "always" | "long" | "off",
} as const;
