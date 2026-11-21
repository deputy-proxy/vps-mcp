#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root: sudo bash $0" >&2
  exit 2
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
LIBEXEC=/usr/local/libexec/vps-mcp
SYSTEMD_DIR=/etc/systemd/system
HELPER_SOURCE="${SCRIPT_DIR}/vps-sandboxctl.mjs"
BROKER_SOURCE="${SCRIPT_DIR}/vps-sandboxctl-broker.mjs"
ACCEPTANCE_SOURCE="${SCRIPT_DIR}/rootless-runtime-acceptance.mjs"
SOCKET_UNIT_SOURCE="${REPO_DIR}/systemd/vps-sandboxctl-broker.socket"
SERVICE_UNIT_SOURCE="${REPO_DIR}/systemd/vps-sandboxctl-broker.service"
SOCKET_UNIT="${SYSTEMD_DIR}/vps-sandboxctl-broker.socket"
SERVICE_UNIT="${SYSTEMD_DIR}/vps-sandboxctl-broker.service"
LEGACY_HELPER=/usr/local/sbin/vps-sandboxctl
LEGACY_SUDOERS=/etc/sudoers.d/vps-mcp-sandboxctl

[[ -f "${HELPER_SOURCE}" && -f "${BROKER_SOURCE}" && -f "${ACCEPTANCE_SOURCE}" ]] || { echo "Missing runtime helper, broker or acceptance suite" >&2; exit 2; }
[[ -f "${SOCKET_UNIT_SOURCE}" && -f "${SERVICE_UNIT_SOURCE}" ]] || { echo "Missing broker systemd unit files" >&2; exit 2; }
getent passwd vps-mcp >/dev/null || { echo "Missing vps-mcp account" >&2; exit 2; }
getent group vps-mcp >/dev/null || { echo "Missing vps-mcp group" >&2; exit 2; }
getent passwd vps-sandbox >/dev/null || { echo "Missing vps-sandbox account; run host provisioning first" >&2; exit 2; }
command -v systemd-analyze >/dev/null || { echo "systemd-analyze is required" >&2; exit 2; }

systemd-analyze verify "${SOCKET_UNIT_SOURCE}" "${SERVICE_UNIT_SOURCE}"

install -d -o root -g root -m 0755 "${LIBEXEC}"
install -o root -g root -m 0755 "${HELPER_SOURCE}" "${LIBEXEC}/vps-sandboxctl.mjs"
install -o root -g root -m 0755 "${BROKER_SOURCE}" "${LIBEXEC}/vps-sandboxctl-broker.mjs"
install -o root -g root -m 0644 "${ACCEPTANCE_SOURCE}" "${LIBEXEC}/rootless-runtime-acceptance.mjs"
install -o root -g root -m 0644 "${SOCKET_UNIT_SOURCE}" "${SOCKET_UNIT}"
install -o root -g root -m 0644 "${SERVICE_UNIT_SOURCE}" "${SERVICE_UNIT}"

systemctl stop vps-sandboxctl-broker.socket vps-sandboxctl-broker.service 2>/dev/null || true
systemctl daemon-reload
systemctl enable --now vps-sandboxctl-broker.socket
systemctl is-active --quiet vps-sandboxctl-broker.socket

# Remove the obsolete setuid-based bridge only after the socket broker is active.
rm -f "${LEGACY_SUDOERS}" "${LEGACY_HELPER}"
systemctl reset-failed vps-sandboxctl-broker.service 2>/dev/null || true

printf 'Installed root-owned helper, broker and acceptance suite under %s\n' "${LIBEXEC}"
printf 'Installed and activated %s\n' "${SOCKET_UNIT}"
printf 'Broker socket: /run/vps-sandboxctl.sock (root:vps-mcp 0660)\n'
printf 'Public vps-mcp.service hardening is unchanged.\n'
printf 'Legacy sudoers bridge removed.\n'
