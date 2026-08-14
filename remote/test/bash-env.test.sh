#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
printf 'export PARENT_MARKER=parent-ok\n' > "$TMP/parent.sh"
printf 'export SESSION_MARKER=session-ok\n' > "$TMP/session_1.sh"
ACTUAL="$({ env \
  BASH_ENV="$ROOT/harness-plugin/bash-env.sh" \
  DEEPSEEK_HARNESS_PARENT_BASH_ENV="$TMP/parent.sh" \
  DEEPSEEK_HARNESS_SESSION_ENV_DIR="$TMP" \
  DSH_SESSION_ID='session/1' \
  bash -c 'printf "%s|%s" "$PARENT_MARKER" "$SESSION_MARKER"'; } )"
[ "$ACTUAL" = 'parent-ok|session-ok' ] || {
  printf 'unexpected BASH_ENV result: %s\n' "$ACTUAL" >&2
  exit 1
}
