#!/bin/bash
# Render + (re)load the audio-proxy LaunchAgent. Idempotent.
#
# Secrets are NOT baked in — the start script reads them from the Keychain at
# runtime (see start-audio-proxy.sh), so no 1Password session is needed here.
# Wired into dotfiles `make setup` via the _setup-audio-proxy target.

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.jkrumm.audio-proxy"
LA_DIR="$HOME/Library/LaunchAgents"
PLIST="$LA_DIR/$LABEL.plist"

mkdir -p "$LA_DIR"
chmod +x "$REPO/launchd/start-audio-proxy.sh"
sed "s|__HOME__|$HOME|g" "$REPO/launchd/$LABEL.plist.template" > "$PLIST"

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

echo "audio-proxy LaunchAgent installed and loaded ($LABEL)"
