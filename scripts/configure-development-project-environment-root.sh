#!/usr/bin/env bash
set -Eeuo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Run as root: sudo bash scripts/configure-development-project-environment-root.sh --apply" >&2
  exit 2
fi

APPLY=false
if [[ "${1:-}" == "--apply" && $# -eq 1 ]]; then
  APPLY=true
elif [[ $# -ne 0 ]]; then
  echo "Usage: $0 [--apply]" >&2
  exit 2
fi

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly ROOTS_JSON='[{"root":"/var/lib/vps-mcp/project-environments","owner":"vps-mcp"},{"root":"/var/lib/vps-mcp-development/project-environments","owner":"vps-mcp-development"}]'
readonly ROOT_CONFIG_HELPER="${SCRIPT_DIR}/project-environment-root-config.mjs"
readonly PRODUCTION_MCP_ENV=/etc/vps-mcp/vps-mcp.env
readonly DEVELOPMENT_MCP_ENV=/etc/vps-mcp-development/vps-mcp-development.env
readonly RUNTIME_ENV=/etc/vps-sandbox/runtime.env
readonly ROOTS=(
  "/var/lib/vps-mcp/project-environments:vps-mcp"
  "/var/lib/vps-mcp-development/project-environments:vps-mcp-development"
)

for file in "${PRODUCTION_MCP_ENV}" "${DEVELOPMENT_MCP_ENV}" "${RUNTIME_ENV}"; do
  [[ -f "${file}" && ! -L "${file}" ]] || { echo "Missing or unsafe environment file: ${file}" >&2; exit 2; }
done

MISSING_ROOTS=()
for entry in "${ROOTS[@]}"; do
  root="${entry%%:*}"
  owner="${entry##*:}"
  getent passwd "${owner}" >/dev/null || { echo "Missing project environment owner account: ${owner}." >&2; exit 2; }
  getent group "${owner}" >/dev/null || { echo "Missing project environment owner group: ${owner}." >&2; exit 2; }

  if [[ -L "${root}" ]]; then
    echo "Project environment root must not be a symlink: ${root}" >&2
    exit 2
  elif [[ -e "${root}" ]]; then
    [[ -d "${root}" ]] || { echo "Project environment root is not a directory: ${root}" >&2; exit 2; }
    [[ "$(stat -c '%U:%G' "${root}")" == "${owner}:${owner}" ]] || {
      echo "Project environment root has unexpected ownership: ${root}" >&2
      exit 2
    }
    [[ "$(stat -c '%a' "${root}")" == "700" ]] || {
      echo "Project environment root must have mode 0700; refusing to change existing data permissions: ${root}" >&2
      exit 2
    }
    [[ "$(realpath -e "${root}")" == "${root}" ]] || {
      echo "Project environment root is not canonical: ${root}" >&2
      exit 2
    }
  else
    MISSING_ROOTS+=("${root}:${owner}")
  fi
done

uid="$(id -u vps-sandbox)"
running_containers="$(runuser -u vps-sandbox -- env HOME=/var/lib/vps-sandbox XDG_RUNTIME_DIR="/run/user/${uid}" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/${uid}/bus" podman ps -q)"
[[ -z "${running_containers}" ]] || {
  echo "Rootless containers are running; stop them before applying the runtime configuration." >&2
  exit 2
}

node --input-type=module -e '
  const { validateProjectEnvironmentRoots } = await import(process.argv[1]);
  validateProjectEnvironmentRoots(process.argv[2]);
' "${ROOT_CONFIG_HELPER}" "${ROOTS_JSON}"

printf 'Project environment root map:\n'
printf '  /var/lib/vps-mcp/project-environments -> vps-mcp\n'
printf '  /var/lib/vps-mcp-development/project-environments -> vps-mcp-development\n'
printf 'Environment files to update:\n  %s\n  %s\n  %s\n' "${PRODUCTION_MCP_ENV}" "${DEVELOPMENT_MCP_ENV}" "${RUNTIME_ENV}"
printf 'The runtime installer will refresh the rootless runtime and quota-broker units.\n'
printf 'Both MCP services will be restarted after the runtime update. No project workload will be created or started.\n'

if [[ "${APPLY}" != true ]]; then
  for entry in "${MISSING_ROOTS[@]}"; do
    printf '  would create %s owned by %s (0700)\n' "${entry%%:*}" "${entry##*:}"
  done
  echo "Dry run only. Re-run with --apply to apply the root map and restart services."
  exit 0
fi

CREATED_ROOTS=()
for entry in "${MISSING_ROOTS[@]}"; do
  root="${entry%%:*}"
  install -d -o "${entry##*:}" -g "${entry##*:}" -m 0700 "${root}"
  CREATED_ROOTS+=("${root}")
done

backup_dir="$(mktemp -d /root/vps-project-environment-roots.XXXXXX)"
chmod 0700 "${backup_dir}"
changed=false
rollback() {
  status=$?
  trap - EXIT
  if [[ "${changed}" == true && $status -ne 0 ]]; then
    echo "Configuration failed; restoring previous environment files and runtime units." >&2
    cp -a "${backup_dir}/production.env" "${PRODUCTION_MCP_ENV}" || true
    cp -a "${backup_dir}/development.env" "${DEVELOPMENT_MCP_ENV}" || true
    cp -a "${backup_dir}/runtime.env" "${RUNTIME_ENV}" || true
    bash "${SCRIPT_DIR}/install-vps-sandbox-runtime.sh" || true
    systemctl restart vps-mcp.service vps-mcp-development.service || true
    for root in "${CREATED_ROOTS[@]}"; do rmdir "${root}" 2>/dev/null || true; done
  fi
  rm -rf "${backup_dir}"
  exit "$status"
}
trap rollback EXIT

cp -a "${PRODUCTION_MCP_ENV}" "${backup_dir}/production.env"
cp -a "${DEVELOPMENT_MCP_ENV}" "${backup_dir}/development.env"
cp -a "${RUNTIME_ENV}" "${backup_dir}/runtime.env"

changed=true
node --input-type=module -e '
  const { updateProjectEnvironmentRootMapFile } = await import(process.argv[1]);
  const roots = process.argv[2];
  for (const file of process.argv.slice(3)) await updateProjectEnvironmentRootMapFile(file, roots);
' "${ROOT_CONFIG_HELPER}" "${ROOTS_JSON}" "${PRODUCTION_MCP_ENV}" "${DEVELOPMENT_MCP_ENV}" "${RUNTIME_ENV}"

bash "${SCRIPT_DIR}/install-vps-sandbox-runtime.sh"
systemctl restart vps-mcp.service vps-mcp-development.service
systemctl is-active --quiet vps-sandbox-runtime.socket
systemctl is-active --quiet vps-sandbox-quota-broker.socket
systemctl is-active --quiet vps-mcp.service
systemctl is-active --quiet vps-mcp-development.service

changed=false
trap - EXIT
rm -rf "${backup_dir}"
echo "Configured both project environment roots and restarted the runtime, production MCP and development MCP services."
echo "Existing project environment data was retained; no project-service workload was created or started."
