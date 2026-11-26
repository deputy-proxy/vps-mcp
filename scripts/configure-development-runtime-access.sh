#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root: sudo bash scripts/configure-development-runtime-access.sh" >&2
  exit 2
fi

readonly SERVICE=vps-mcp-development.service
readonly GROUP=vps-mcp
readonly SOCKETS=(/run/vps-sandboxctl.sock /run/vps-sandbox-runtime.sock)
readonly DROPIN_DIR="/etc/systemd/system/${SERVICE}.d"
readonly DROPIN="${DROPIN_DIR}/runtime-socket-access.conf"

systemctl cat "${SERVICE}" >/dev/null || { echo "Missing ${SERVICE}." >&2; exit 2; }
getent group "${GROUP}" >/dev/null || { echo "Missing ${GROUP} group." >&2; exit 2; }
for socket in "${SOCKETS[@]}"; do
  [[ -S "${socket}" ]] || { echo "Missing runtime socket: ${socket}." >&2; exit 2; }
  [[ "$(stat -c '%G' "${socket}")" == "${GROUP}" ]] || { echo "${socket} is not owned by ${GROUP}." >&2; exit 2; }
  [[ "$(stat -c '%a' "${socket}")" == "660" ]] || { echo "${socket} must have mode 0660." >&2; exit 2; }
done

expected=$'[Service]\nSupplementaryGroups=vps-mcp'
created_dropin=false
if [[ -f "${DROPIN}" ]]; then
  [[ "$(cat "${DROPIN}")" == "${expected}" ]] || { echo "Refusing to overwrite existing ${DROPIN}." >&2; exit 2; }
else
  install -d -o root -g root -m 0755 "${DROPIN_DIR}"
  tmp="$(mktemp)"
  printf '%s\n' "${expected}" > "${tmp}"
  install -o root -g root -m 0644 "${tmp}" "${DROPIN}"
  rm -f "${tmp}"
  created_dropin=true
fi

rollback() {
  if [[ "${created_dropin}" == true ]]; then
    rm -f "${DROPIN}"
    systemctl daemon-reload
    systemctl restart "${SERVICE}" || true
  fi
}
trap rollback ERR
systemctl daemon-reload
systemctl restart "${SERVICE}"
systemctl is-active --quiet "${SERVICE}"

pid="$(systemctl show --property=MainPID --value "${SERVICE}")"
[[ "${pid}" =~ ^[1-9][0-9]*$ ]] || { echo "${SERVICE} has no running main process." >&2; exit 1; }
group_id="$(getent group "${GROUP}" | cut -d: -f3)"
groups="$(awk '/^Groups:/ { sub(/^Groups:[[:space:]]*/, ""); print " " $0 " " }' "/proc/${pid}/status")"
grep -Fq " ${group_id} " <<<"${groups}" || { echo "${SERVICE} process did not receive supplementary group ${GROUP}." >&2; exit 1; }

trap - ERR
printf 'Configured %s with supplementary group %s. Runtime socket access is now available to the development MCP process.\n' "${SERVICE}" "${GROUP}"
