import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config";

mkdirSync(dirname(config.usageDb), { recursive: true });

const db = new Database(config.usageDb, { create: true });
db.exec("PRAGMA journal_mode = WAL;");
db.exec(`
  CREATE TABLE IF NOT EXISTS usage_record (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    ts              TEXT    NOT NULL,
    endpoint        TEXT    NOT NULL,          -- 'transcriptions' | 'speech' | 'models'
    model           TEXT    NOT NULL,
    status          INTEGER NOT NULL,          -- upstream HTTP status
    latency_ms      INTEGER NOT NULL,
    response_format TEXT,                       -- requested format (STT)
    input_tokens    INTEGER,
    output_tokens   INTEGER,
    audio_tokens    INTEGER,
    audio_seconds   REAL,
    input_chars     INTEGER,                    -- TTS input length
    bytes_out       INTEGER,                    -- TTS audio size
    usage_json      TEXT                        -- raw upstream usage object
  );
`);
db.exec("CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_record (ts);");

export interface UsageRow {
  endpoint: "transcriptions" | "speech" | "models";
  model: string;
  status: number;
  latencyMs: number;
  responseFormat?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  audioTokens?: number | null;
  audioSeconds?: number | null;
  inputChars?: number | null;
  bytesOut?: number | null;
  usageJson?: unknown;
}

const insert = db.prepare(`
  INSERT INTO usage_record
    (ts, endpoint, model, status, latency_ms, response_format,
     input_tokens, output_tokens, audio_tokens, audio_seconds,
     input_chars, bytes_out, usage_json)
  VALUES
    ($ts, $endpoint, $model, $status, $latencyMs, $responseFormat,
     $inputTokens, $outputTokens, $audioTokens, $audioSeconds,
     $inputChars, $bytesOut, $usageJson)
`);

/** Extract OpenAI/Voxtral token counts from an upstream usage object. */
const tokens = (usage: unknown) => {
  const u = (usage ?? {}) as Record<string, unknown>;
  const details = (u["input_token_details"] ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
  return {
    input: num(u["input_tokens"]) ?? num(u["prompt_tokens"]),
    output: num(u["output_tokens"]) ?? num(u["completion_tokens"]),
    audioTokens: num(details["audio_tokens"]),
    audioSeconds: num(u["prompt_audio_seconds"]),
  };
};

export function recordUsage(row: UsageRow): void {
  const t = tokens(row.usageJson);
  insert.run({
    $ts: new Date().toISOString(),
    $endpoint: row.endpoint,
    $model: row.model,
    $status: row.status,
    $latencyMs: row.latencyMs,
    $responseFormat: row.responseFormat ?? null,
    $inputTokens: row.inputTokens ?? t.input,
    $outputTokens: row.outputTokens ?? t.output,
    $audioTokens: row.audioTokens ?? t.audioTokens,
    $audioSeconds: row.audioSeconds ?? t.audioSeconds,
    $inputChars: row.inputChars ?? null,
    $bytesOut: row.bytesOut ?? null,
    $usageJson: row.usageJson ? JSON.stringify(row.usageJson) : null,
  });
}
