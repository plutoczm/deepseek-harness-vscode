#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
printf 'export PARENT_MARKER=parent-ok\n' > "$TMP/parent.sh"
printf 'export SESSION_MARKER=session-ok\n' > "$TMP/session_1.sh"
cat > "$TMP/network-instance_1.sh" <<'EOF'
export HTTPS_PROXY='http://127.0.0.1:45678'
export HTTP_PROXY='http://127.0.0.1:45678'
export NO_PROXY='api.deepseek.com,.deepseek.com,127.0.0.1,localhost,::1'
EOF
ACTUAL="$({ env \
  BASH_ENV="$ROOT/harness-plugin/bash-env.sh" \
  DEEPSEEK_HARNESS_PARENT_BASH_ENV="$TMP/parent.sh" \
  DEEPSEEK_HARNESS_SESSION_ENV_DIR="$TMP" \
  DEEPSEEK_HARNESS_REMOTE_INSTANCE='instance/1' \
  DSH_SESSION_ID='session/1' \
  bash -c 'printf "%s|%s|%s|%s" "$PARENT_MARKER" "$SESSION_MARKER" "$HTTPS_PROXY" "$NO_PROXY"'; } )"
[ "$ACTUAL" = 'parent-ok|session-ok|http://127.0.0.1:45678|api.deepseek.com,.deepseek.com,127.0.0.1,localhost,::1' ] || {
  printf 'unexpected BASH_ENV result: %s\n' "$ACTUAL" >&2
  exit 1
}
