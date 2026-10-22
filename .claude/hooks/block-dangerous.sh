#!/usr/bin/env bash
# PreToolUse (Bash): refuse force pushes and recursive force deletes. Exit 2 blocks the call.
set -u
cmd=$(jq -r '.tool_input.command // empty')
# Split on shell separators so "cd x && git push -f" is caught too.
while IFS= read -r part; do
  if [[ "$part" =~ (^|[[:space:]])git[[:space:]]+([^;]*[[:space:]])?push([[:space:]]|$) ]] &&
     [[ "$part" =~ [[:space:]](--force|--force-with-lease|-f|-[a-zA-Z]*f[a-zA-Z]*)([[:space:]=]|$)|[[:space:]]\+[^[:space:]]+ ]]; then
    echo "Blocked: force push is not allowed from Claude (.claude/hooks/block-dangerous.sh). Run it yourself if you mean it." >&2
    exit 2
  fi
  # rm with both a recursive flag and a force flag, combined (-rf, -fR) or separate (-r -f, --recursive --force).
  if [[ "$part" =~ (^|[[:space:]])rm[[:space:]] ]] &&
     [[ "$part" =~ [[:space:]](-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)([[:space:]]|$) ]] &&
     [[ "$part" =~ [[:space:]](-[a-zA-Z]*f[a-zA-Z]*|--force)([[:space:]]|$) ]]; then
    echo "Blocked: rm -rf is not allowed from Claude (.claude/hooks/block-dangerous.sh). Delete it yourself or use a narrower command." >&2
    exit 2
  fi
done < <(printf '%s\n' "$cmd" | sed -E 's/(&&|\|\||;|\|)/\n/g')
exit 0
