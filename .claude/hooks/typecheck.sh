#!/usr/bin/env bash
# PostToolUse (Edit|Write): typecheck after any .ts/.tsx change so errors surface now, not three steps later.
# Exit 2 sends the errors back to Claude; anything else stays quiet.
set -u
file=$(jq -r '.tool_input.file_path // .tool_response.filePath // empty')
case "$file" in
  *.ts|*.tsx) ;;
  *) exit 0 ;;
esac
cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}" || exit 0
if ! out=$(COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm -s typecheck 2>&1); then
  echo "pnpm typecheck failed after editing $file:" >&2
  echo "$out" | grep -E "error TS" | head -n 20 >&2
  exit 2
fi
exit 0
