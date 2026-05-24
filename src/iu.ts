import { config } from "./config";

/** Absolute IU URL for an OpenAI-dialect path like `/audio/transcriptions`. */
export const iuUrl = (path: string): string => `${config.iuBaseUrl}${path}`;

/** Upstream headers carrying the IU bearer token. */
export const iuHeaders = (extra: Record<string, string> = {}): Record<string, string> => ({
  Authorization: `Bearer ${config.iuApiKey}`,
  ...extra,
});
