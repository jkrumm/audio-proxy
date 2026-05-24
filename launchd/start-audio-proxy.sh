#!/bin/bash
# audio-proxy wrapper — OpenAI-compatible IU audio proxy on 127.0.0.1:7716.
#
# Started by ~/Library/LaunchAgents/com.jkrumm.audio-proxy.plist via launchd.
#
# launchd cannot run `op` (no biometric/session), so secrets come from the
# Keychain — the same IU credential `make setup` caches for claude offloading
# and the LiteLLM bridge:
#   security find-generic-password -s claude-sdk-api-key
#   security find-generic-password -s claude-sdk-base-url   (…/anthropic transport)
# The OpenAI-compatible base is derived from it. Neither value is written to disk.
#
# For interactive dev use `bun run dev` instead — it resolves the same secrets
# from 1Password via `op run --env-file=.env.tpl`.
#
# launchd needs PID 1 alive for the duration; exec bun in the foreground.

set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"

KEY=$(security find-generic-password -s claude-sdk-api-key -w 2>/dev/null || echo "")
BASE=$(security find-generic-password -s claude-sdk-base-url -w 2>/dev/null || echo "")
BASE="${BASE%/}"

if [ -z "$KEY" ] || [ -z "$BASE" ]; then
  echo "audio-proxy: IU credentials missing in Keychain — run 'make setup' in dotfiles" >&2
  exit 1
fi

# claude-sdk-base-url is the IU Anthropic transport (…/anthropic). Derive the
# OpenAI-compatible transport this proxy forwards to.
export IU_API_KEY="$KEY"
export IU_OPENAI_BASE_URL="${BASE%/anthropic}/openai/v1"
export PORT="${PORT:-7716}"
export USAGE_DB="${USAGE_DB:-$REPO/data/usage.db}"
export STT_LANGUAGE="${STT_LANGUAGE:-}"
export STT_PROMPT="${STT_PROMPT:-Die Aufnahme ist auf Deutsch oder Englisch.}"

cd "$REPO"
exec /opt/homebrew/bin/bun "$REPO/src/index.ts"
