#!/bin/sh
set -eu

original_command=${SSH_ORIGINAL_COMMAND:-}
case "$original_command" in
  "deploy-development "*) expected_sha=${original_command#deploy-development } ;;
  *) echo "Rejected SSH command. Expected: deploy-development <full-commit-sha>" >&2; exit 64 ;;
esac
case "$expected_sha" in
  *[!0-9a-f]*|'') echo "Rejected deployment commit identifier." >&2; exit 64 ;;
esac
[ "${#expected_sha}" -eq 40 ] || { echo "Rejected deployment commit identifier." >&2; exit 64; }

printf '%s\n' "$expected_sha" | /usr/bin/sudo -n -H /usr/bin/node /usr/local/libexec/vps-mcp-development/deploy-development.mjs
