# audio-proxy — dev secrets template (safe to commit: only op:// references).
# Resolved at runtime by `bun run dev` / `bun run start`, which wrap the process
# with `op run --account tkrumm --env-file=.env.tpl`. op substitutes only the
# op:// values; plain values pass through unchanged.
#
# The LaunchAgent does NOT use this file — launchd can't run op, so it reads the
# same IU credential from the Keychain instead (see launchd/start-audio-proxy.sh).

PORT=7716

# IU unified audio endpoint, OpenAI dialect.
IU_OPENAI_BASE_URL=op://common/anthropic/OPENAI_BASE_URL
IU_API_KEY=op://common/anthropic/API_KEY

# Local SQLite usage log.
USAGE_DB=./data/usage.db

# Optional: require this bearer token from clients (empty = accept any, localhost only).
PROXY_API_KEY=

# STT language steering, injected only when the client sends none.
# STT_LANGUAGE: hard ISO-639-1 lock (e.g. de). Empty = allow multiple languages.
# STT_PROMPT: soft bias — keeps gpt-4o-transcribe on German or English.
STT_LANGUAGE=
STT_PROMPT=Die Aufnahme ist auf Deutsch oder Englisch.
