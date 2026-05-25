# audio-proxy

An OpenAI-compatible HTTP proxy in front of a unified, multi-provider audio
endpoint. It exposes the standard OpenAI audio routes so any OpenAI client
(MacWhisper, SDKs, `curl`, Hermes) can talk to the upstream unchanged, and it
logs every request to a local SQLite usage table.

It does two jobs:

- **STT** — fixes a concrete incompatibility: the modern `gpt-4o-transcribe`
  family upstream **only supports `response_format=json|text`** and rejects
  `verbose_json` / `srt` / `vtt` with a `503`. Clients like MacWhisper request the
  rich formats and break. This proxy downgrades the upstream call to `json` and
  **synthesizes** the rich envelope the client asked for, so you get
  `gpt-4o-transcribe` text quality through clients that demand timestamps.
- **TTS** — passes standard OpenAI TTS straight through, and adds an expressive
  **Gemini 3.1 Flash TTS** pipeline (default voice `Charon`) for longform
  Hermes-styled speech that the OpenAI `/audio/speech` route can't serve. See
  [TTS behaviour](#tts-behaviour).

## Routes

| Method | Path | Purpose |
|-|-|-|
| `POST` | `/v1/audio/transcriptions` | Speech-to-text (STT) |
| `POST` | `/v1/audio/speech` | Text-to-speech — passthrough, or native Gemini expressive TTS |
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

### Language steering

Without a language hint, `gpt-4o-transcribe` guesses the language and can drift
into the wrong one (Chinese/Dutch) on short or quiet clips. Two env knobs are
injected into the upstream call **only when the client sends none** (client
values always win):

- `STT_LANGUAGE` — hard lock to one language (ISO-639-1, e.g. `de`). Most
  reliable, but wrong-language audio is forced into it. Leave empty to allow more
  than one language.
- `STT_PROMPT` — a soft text bias. Ships defaulting to
  `Die Aufnahme ist auf Deutsch oder Englisch.`, which keeps the model on German
  **or** English without locking to one. This is OpenAI's recommended approach
  for the multi-language case.

Pick `STT_LANGUAGE` when every recording is the same language; keep the
`STT_PROMPT` default when you mix German and English.

## TTS behaviour

- **Standard models** (`tts`, `gpt-4o-mini-tts`, …): straight passthrough to the
  upstream OpenAI `/audio/speech`, returned unchanged.
- **Gemini TTS** (`gemini-*-tts`, e.g. `gemini-3.1-flash-tts-preview`): Gemini
  voices are **not** served on `/audio/speech` (it 404s) — only on the native
  `generateContent` route. So these route to a synth pipeline:
  1. **Prep** — a cheap LLM (`TTS_PREP_MODEL`, default `gpt-5.4-mini`) rewrites
     the text into a Hermes persona: detects DE/EN, rewrites numbers/times to
     spoken form, splits into ~600-word chunks at sentence boundaries, and adds a
     per-chunk style directive plus sparse inline tags (`[pause]`, `[nachdenklich]`, …).
  2. **Synth** — each chunk is generated on Gemini (`temperature 1.0`, voice
     validated against the 30-voice list, default `Charon`).
  3. **Concat** — the raw 24 kHz mono PCM chunks are joined with ~400 ms silences.
  4. **Transcode** — `ffmpeg` compresses to MP3 (`audio/mpeg`, default) or, when
     the client asks `response_format=opus`, Opus/OGG (`audio/ogg`).

  A chunk that returns no audio fails loudly with the upstream status/body — no
  silent partial output. `503`/`429` are retried with backoff. Hermes consumes
  this via its native OpenAI-compatible TTS provider.

> Prep is switchable via `TTS_PREP`: `always` (default), `long` (LLM only above
> the chunk threshold), or `off` (no LLM — speak the raw text with a default
> persona directive). `IU_GEMINI_BASE_URL` is required only when a Gemini TTS
> request actually arrives, so STT-only deployments boot without it.

## Setup

Requires [Bun](https://bun.sh), the `op` CLI (1Password), and `ffmpeg`/`ffprobe`
(`ffmpeg` is required for Gemini TTS transcoding; `ffprobe` gives STT clip duration).

Secrets are never stored in plaintext. `.env.tpl` holds only `op://` references
and is resolved at runtime — there is no committed or local `.env`.

### Dev

```bash
bun install
bun run dev   # op run --env-file=.env.tpl -- bun --watch src/index.ts → http://localhost:7716
```

### Run as a service (macOS LaunchAgent)

```bash
bun run install-agent   # render + load com.jkrumm.audio-proxy, RunAtLoad + KeepAlive
```

This is also wired into dotfiles `make setup` (`_setup-audio-proxy`), so a full
machine setup installs it automatically. Logs: `/tmp/audio-proxy.log` /
`/tmp/audio-proxy.err`.

The LaunchAgent **cannot** use `op` (launchd has no 1Password session), so
`launchd/start-audio-proxy.sh` reads the IU credential from the macOS Keychain
(`claude-sdk-api-key` / `claude-sdk-base-url`, cached by dotfiles `make setup`)
and derives the OpenAI base (`.../openai/v1`) and Gemini base (`.../gemini/v1beta`)
from it. Nothing is written to disk.

### Config

| Var | Default | Notes |
|-|-|-|
| `PORT` | `7716` | Listen port |
| `IU_OPENAI_BASE_URL` | — | Upstream OpenAI-dialect base (`.../openai/v1`) |
| `IU_GEMINI_BASE_URL` | _(empty)_ | Native Gemini base (`.../gemini/v1beta`). Required only for Gemini TTS |
| `IU_API_KEY` | — | Upstream bearer token (reused for OpenAI, Gemini, and prep calls) |
| `USAGE_DB` | `./data/usage.db` | SQLite usage log path |
| `PROXY_API_KEY` | _(empty)_ | If set, callers must send `Authorization: Bearer <it>`. Empty = accept any caller (localhost only). |
| `TTS_PREP` | `always` | Gemini prep mode: `always` \| `long` \| `off` |
| `TTS_PREP_MODEL` | `gpt-5.4-mini` | OpenAI-dialect model used to rewrite text into Hermes chunks |
| `TTS_MP3_BITRATE` | `64` | MP3 output bitrate (kbps) |
| `TTS_CHUNK_THRESHOLD` | `1200` | Below this input length, prep short-circuits to one chunk |

## MacWhisper

In MacWhisper, add a Custom OpenAI-compatible server:

- **Base URL**: `http://localhost:7716/v1` (or your local HTTPS host)
- **API Key**: any non-empty string, or your `PROXY_API_KEY`
- **Model**: `gpt-4o-transcribe` (best text) or `Whisper` (real timestamps)

## Usage tracking

Every request appends a row to `usage_record` (endpoint, model, status, latency,
token/audio usage from the upstream response, TTS input chars + output bytes,
and the raw upstream `usage` JSON). A Gemini TTS request writes one `speech` row
per synthesized chunk (Gemini token counts + audio seconds) plus one
`speech-prep` row for the rewrite call. `usage-tracker` ingests this DB as its
`audio-proxy` source. Query it directly:

```bash
sqlite3 data/usage.db 'SELECT ts, endpoint, model, status, latency_ms FROM usage_record ORDER BY id DESC LIMIT 20;'
```
