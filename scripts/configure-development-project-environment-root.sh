#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root: sudo bash scripts/configure-development-project-environment-root.sh" >&2
  exit 2
fi

readonly MCP_ENV=/etc/vps-mcp-development/vps-mcp-development.env
readonly RUNTIME_ENV=/etc/vps-sandbox/runtime.env
readonly PROJECT_ENV_ROOT=/var/lib/vps-mcp-development/project-environments
readonly PROJECT_ENV_OWNER=vps-mcp-development
readonly REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

[[ -f "${MCP_ENV}" ]] || { echo "Missing ${MCP_ENV}." >&2; exit 2; }
[[ -f "${RUNTIME_ENV}" ]] || { echo "Missing ${RUNTIME_ENV}; install the rootless runtime first." >&2; exit 2; }
getent passwd "${PROJECT_ENV_OWNER}" >/dev/null || { echo "Missing ${PROJECT_ENV_OWNER} account." >&2; exit 2; }
getent group vps-sandbox >/dev/null || { echo "Missing vps-sandbox group." >&2; exit 2; }

uid="$(id -u vps-sandbox)"
containers="$(runuser -u vps-sandbox -- env HOME=/var/lib/vps-sandbox XDG_RUNTIME_DIR="/run/user/${uid}" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/${uid}/bus" podman ps -aq --filter label=io.cr8or.vps-mcp.type=project-service)"
[[ -z "${containers}" ]] || { echo "Project-service containers already exist; refusing to change their configured data root." >&2; exit 2; }
running_containers="$(runuser -u vps-sandbox -- env HOME=/var/lib/vps-sandbox XDG_RUNTIME_DIR="/run/user/${uid}" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/${uid}/bus" podman ps -q)"
[[ -z "${running_containers}" ]] || { echo "Running rootless containers exist; stop them before changing runtime configuration." >&2; exit 2; }
if [[ -d "${PROJECT_ENV_ROOT}" ]] && [[ -n "$(find "${PROJECT_ENV_ROOT}" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
  echo "${PROJECT_ENV_ROOT} is not empty; refusing to reuse or overwrite existing project-environment data." >&2
  exit 2
fi
if [[ -d /var/lib/vps-sandbox/workloads ]]; then
  project_records="$(find /var/lib/vps-sandbox/workloads -type f -name "record.json" -exec sh -c 'grep -lE '"'"'"workloadType"[[:space:]]*:[[:space:]]*"project-service"'"'"' "$@" || test "$?" -eq 1' sh {} +)"
  [[ -z "${project_records}" ]] || { echo "Project-service workload records already exist; refusing to orphan their mount metadata." >&2; exit 2; }
fi

backup_mcp="$(mktemp)"
backup_runtime="$(mktemp)"
cp -a "${MCP_ENV}" "${backup_mcp}"
cp -a "${RUNTIME_ENV}" "${backup_runtime}"
changed=true
rollback() {
  if [[ "${changed}" == true ]]; then
    install -o root -g vps-mcp-development -m 0640 "${backup_mcp}" "${MCP_ENV}"
    install -o root -g vps-sandbox -m 0640 "${backup_runtime}" "${RUNTIME_ENV}"
    bash "${REPO_DIR}/scripts/install-vps-sandbox-runtime.sh" || true
    systemctl restart vps-mcp-development.service || true
  fi
  rm -f "${backup_mcp}" "${backup_runtime}"
}
trap rollback ERR

update_env() {
  local file="$1" owner_group="$2" key_root="$3" key_owner="$4"
  local temporary
  temporary="$(mktemp)"
  awk -v root_key="${key_root}" -v root_value="${PROJECT_ENV_ROOT}" -v owner_key="${key_owner}" -v owner_value="${PROJECT_ENV_OWNER}" '
    BEGIN { root_done=0; owner_done=0 }
    index($0, root_key "=")==1 { if (!root_done) print root_key "=" root_value; root_done=1; next }
    index($0, owner_key "=")==1 { if (!owner_done) print owner_key "=" owner_value; owner_done=1; next }
    { print }
    END { if (!root_done) print root_key "=" root_value; if (!owner_done) print owner_key "=" owner_value }
  ' "${file}" > "${temporary}"
  install -o root -g "${owner_group}" -m 0640 "${temporary}" "${file}"
  rm -f "${temporary}"
}

update_env "${MCP_ENV}" vps-mcp-development VPS_SANDBOX_PROJECT_ENV_ROOT VPS_SANDBOX_PROJECT_ENV_OWNER
update_env "${RUNTIME_ENV}" vps-sandbox VPS_SANDBOX_PROJECT_ENV_ROOT VPS_SANDBOX_PROJECT_ENV_OWNER
install -d -o "${PROJECT_ENV_OWNER}" -g "${PROJECT_ENV_OWNER}" -m 0700 "${PROJECT_ENV_ROOT}"
bash "${REPO_DIR}/scripts/install-vps-sandbox-runtime.sh"
systemctl restart vps-mcp-development.service
systemctl is-active --quiet vps-mcp-development.service

changed=false
trap - ERR
rm -f "${backup_mcp}" "${backup_runtime}"
printf 'Configured the development MCP and rootless runtime to use %s (owner %s).\n' "${PROJECT_ENV_ROOT}" "${PROJECT_ENV_OWNER}"
printf 'No project-service workloads were present or created.\n'
