#!/bin/sh
set -eu

# This command is forced by the dedicated SSH public key. Never execute the
# command supplied by the SSH client; accept only a single immutable commit ID.
original_command=${SSH_ORIGINAL_COMMAND:-}
case "$original_command" in
  "deploy "*) expected_sha=${original_command#deploy } ;;
  *) echo "Rejected SSH command. Expected: deploy <full-commit-sha>" >&2; exit 64 ;;
esac
case "$expected_sha" in
  *[!0-9a-f]*|'') echo "Rejected deployment commit identifier." >&2; exit 64 ;;
esac
[ "${#expected_sha}" -eq 40 ] || { echo "Rejected deployment commit identifier." >&2; exit 64; }

printf '%s\n' "$expected_sha" | /usr/bin/sudo -n -H -u vps-mcp /usr/bin/node /usr/local/libexec/vps-mcp/deploy-production.mjs
