const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
};

export const config = {
  port: Number(process.env["PORT"] ?? 7716),
  iuApiKey: required("IU_API_KEY"),
  iuBaseUrl: required("IU_OPENAI_BASE_URL").replace(/\/+$/, ""),
  usageDb: process.env["USAGE_DB"] ?? "./data/usage.db",
  /** When set, callers must send `Authorization: Bearer <proxyApiKey>`. */
  proxyApiKey: process.env["PROXY_API_KEY"] ?? "",
  /** Default STT `language` (ISO-639-1, e.g. `de`) injected when the client sends none. */
  sttLanguage: process.env["STT_LANGUAGE"] ?? "",
  /** Default STT `prompt` injected when the client sends none — steers expected language. */
  sttPrompt: process.env["STT_PROMPT"] ?? "",
} as const;
