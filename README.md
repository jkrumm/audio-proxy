# audio-proxy

An OpenAI-compatible HTTP proxy in front of a unified, multi-provider audio
endpoint. It exposes the standard OpenAI audio routes so any OpenAI client
(MacWhisper, SDKs, `curl`) can talk to the upstream unchanged, and it logs every
request to a local SQLite usage table.

It exists to solve one concrete incompatibility: the modern `gpt-4o-transcribe`
family upstream **only supports `response_format=json|text`** and rejects
`verbose_json` / `srt` / `vtt` with a `503`. Clients like MacWhisper request the
rich formats and break. This proxy downgrades the upstream call to `json` and
**synthesizes** the rich envelope the client asked for, so you get
`gpt-4o-transcribe` text quality through clients that demand timestamps.

## Routes

| Method | Path | Purpose |
|-|-|-|
| `POST` | `/v1/audio/transcriptions` | Speech-to-text (STT) |
| `POST` | `/v1/audio/speech` | Text-to-speech (TTS) |
| `GET`  | `/v1/models` | Upstream model list (passthrough) |
| `GET`  | `/health` | Liveness |

The `/v1` prefix is optional — routes match on the suffix so clients with either
base-URL form work.

## STT behaviour

- **`gpt-4o-transcribe`, `gpt-4o-mini-transcribe`, `gpt-4o-transcribe-diarize`**
  (anything matching `/transcribe/i`): upstream is called with
  `response_format=json`; if the client asked for `verbose_json`/`srt`/`vtt`, the
  proxy wraps the text in a **single segment** spanning the whole clip. Clip
  length comes from `ffprobe` (best-effort; `0` if `ffprobe` is absent).
- **`Whisper`**: supports the rich formats natively (real per-segment timing), so
  the response is passed through untouched.

> Known limitation: synthesized timing is a single block — `gpt-4o-transcribe`
> does not emit word/segment timestamps, so accurate subtitles require `Whisper`.
> This proxy is aimed at getting the best transcript **text** into such clients.

## Setup

Requires [Bun](https://bun.sh) and (optionally) `ffmpeg`/`ffprobe` for STT clip
duration.

```bash
cp .env.example .env   # fill IU_OPENAI_BASE_URL + IU_API_KEY (see your secret manager)
bun install
bun run dev            # http://localhost:7716
```

### Config

| Var | Default | Notes |
|-|-|-|
| `PORT` | `7716` | Listen port |
| `IU_OPENAI_BASE_URL` | — | Upstream OpenAI-dialect base (`.../openai/v1`) |
| `IU_API_KEY` | — | Upstream bearer token |
| `USAGE_DB` | `./data/usage.db` | SQLite usage log path |
| `PROXY_API_KEY` | _(empty)_ | If set, callers must send `Authorization: Bearer <it>`. Empty = accept any caller (localhost only). |

Secrets are never committed — `.env` is git-ignored and `.env.example` ships
placeholders only.

## MacWhisper

In MacWhisper, add a Custom OpenAI-compatible server:

- **Base URL**: `http://localhost:7716/v1` (or your local HTTPS host)
- **API Key**: any non-empty string, or your `PROXY_API_KEY`
- **Model**: `gpt-4o-transcribe` (best text) or `Whisper` (real timestamps)

## Usage tracking

Every request appends a row to `usage_record` (endpoint, model, status, latency,
token/audio usage from the upstream response, TTS input chars + output bytes,
and the raw upstream `usage` JSON). Query it directly:

```bash
sqlite3 data/usage.db 'SELECT ts, endpoint, model, status, latency_ms FROM usage_record ORDER BY id DESC LIMIT 20;'
```
