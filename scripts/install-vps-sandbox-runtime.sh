#!/usr/bin/env bash
set -Eeuo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Run as root: sudo bash scripts/install-vps-sandbox-runtime.sh" >&2
  exit 2
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
LIBEXEC=/usr/local/libexec/vps-mcp
SYSTEMD_DIR=/etc/systemd/system
ENV_DIR=/etc/vps-sandbox
UID_VALUE="$(id -u vps-sandbox)"
RUNTIME_ENV="${ENV_DIR}/runtime.env"

getent passwd vps-sandbox >/dev/null || { echo "Missing vps-sandbox account; provision rootless Podman first." >&2; exit 2; }
getent group vps-mcp >/dev/null || { echo "Missing vps-mcp group." >&2; exit 2; }
[[ -d "/run/user/${UID_VALUE}" ]] || { echo "Missing /run/user/${UID_VALUE}; enable lingering and the vps-sandbox user manager first." >&2; exit 2; }
[[ -S "/run/user/${UID_VALUE}/bus" ]] || { echo "Missing vps-sandbox user D-Bus socket." >&2; exit 2; }
command -v systemd-analyze >/dev/null || { echo "systemd-analyze is required." >&2; exit 2; }

systemd-analyze verify "${REPO_DIR}/systemd/vps-sandbox-runtime.socket" "${REPO_DIR}/systemd/vps-sandbox-runtime.service"
install -d -o root -g root -m 0755 "${LIBEXEC}" "${ENV_DIR}"
install -o root -g root -m 0755 "${SCRIPT_DIR}/vps-sandbox-runtime.mjs" "${LIBEXEC}/vps-sandbox-runtime.mjs"

if [[ ! -e "${RUNTIME_ENV}" ]]; then
  umask 027
  cat > "${RUNTIME_ENV}" <<ENV
XDG_RUNTIME_DIR=/run/user/${UID_VALUE}
DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${UID_VALUE}/bus
VPS_SANDBOX_ALLOWED_WORKSPACE_ROOTS=
ENV
  chown root:vps-sandbox "${RUNTIME_ENV}"
  chmod 0640 "${RUNTIME_ENV}"
else
  echo "Preserving existing ${RUNTIME_ENV}; inspect its D-Bus and workspace-root values manually."
fi

install -o root -g root -m 0644 "${REPO_DIR}/systemd/vps-sandbox-runtime.socket" "${SYSTEMD_DIR}/vps-sandbox-runtime.socket"
install -o root -g root -m 0644 "${REPO_DIR}/systemd/vps-sandbox-runtime.service" "${SYSTEMD_DIR}/vps-sandbox-runtime.service"
systemctl stop vps-sandbox-runtime.socket vps-sandbox-runtime.service 2>/dev/null || true
systemctl daemon-reload
systemctl enable --now vps-sandbox-runtime.socket
systemctl is-active --quiet vps-sandbox-runtime.socket
printf 'Installed rootless workload runtime agent.\n'
printf 'Socket: /run/vps-sandbox-runtime.sock (vps-sandbox:vps-mcp 0660)\n'
printf 'Agent: vps-sandbox, bounded capability set, delegated CPU/memory/PID cgroups.\n'
printf 'No public vps-mcp.service settings were changed.\n'
printf 'Workload creation remains unavailable until the workspace mount roots and live acceptance are approved.\n'
