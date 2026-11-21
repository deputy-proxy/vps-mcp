#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root: sudo bash $0" >&2
  exit 2
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SOURCE="${SCRIPT_DIR}/vps-sandboxctl.mjs"
HELPER=/usr/local/sbin/vps-sandboxctl
SUDOERS=/etc/sudoers.d/vps-mcp-sandboxctl
TEMP_SUDOERS="$(mktemp)"
trap 'rm -f "${TEMP_SUDOERS}"' EXIT

[[ -f "${SOURCE}" ]] || { echo "Missing helper source: ${SOURCE}" >&2; exit 2; }
getent passwd vps-mcp >/dev/null || { echo "Missing vps-mcp account" >&2; exit 2; }
getent passwd vps-sandbox >/dev/null || { echo "Missing vps-sandbox account; run host provisioning first" >&2; exit 2; }
command -v visudo >/dev/null || { echo "visudo is required" >&2; exit 2; }

install -o root -g root -m 0755 "${SOURCE}" "${HELPER}"

cat > "${TEMP_SUDOERS}" <<SUDOERS_EOF
# Managed by vps-mcp. Only fixed, reviewed rootless runtime checks are allowed.
vps-mcp ALL=(root) NOPASSWD: ${HELPER} preflight, ${HELPER} info, ${HELPER} smoke
SUDOERS_EOF

chmod 0440 "${TEMP_SUDOERS}"
visudo -cf "${TEMP_SUDOERS}"
install -o root -g root -m 0440 "${TEMP_SUDOERS}" "${SUDOERS}"
if ! visudo -c; then
  rm -f "${SUDOERS}"
  echo "Installed sudoers policy failed validation and was removed" >&2
  exit 1
fi

printf 'Installed %s (root:root 0755)\n' "${HELPER}"
printf 'Installed %s (root:root 0440)\n' "${SUDOERS}"
printf '\nAllowed operations for vps-mcp:\n  sudo -n %s preflight\n  sudo -n %s info\n  sudo -n %s smoke\n' "${HELPER}" "${HELPER}" "${HELPER}"
printf '\nNo arbitrary command, shell, Podman arguments, or systemd properties are accepted.\n'
