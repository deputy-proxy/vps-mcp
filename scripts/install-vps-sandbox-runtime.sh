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
QUOTA_SOCKET_SOURCE="$REPO_DIR/systemd/vps-sandbox-quota-broker.socket"
QUOTA_SERVICE_SOURCE="$REPO_DIR/systemd/vps-sandbox-quota-broker.service"
QUOTA_SOCKET="$SYSTEMD_DIR/vps-sandbox-quota-broker.socket"
QUOTA_SERVICE="$SYSTEMD_DIR/vps-sandbox-quota-broker.service"
QUOTA_SERVICE_DROPIN_DIR="${QUOTA_SERVICE}.d"
QUOTA_DEVICE_ALLOW=()
declare -A SEEN_QUOTA_DEVICES=()
UID_VALUE="$(id -u vps-sandbox)"
RUNTIME_ENV="${ENV_DIR}/runtime.env"
RUNTIME_SERVICE_DROPIN_DIR="${SYSTEMD_DIR}/vps-sandbox-runtime.service.d"

getent passwd vps-sandbox >/dev/null || { echo "Missing vps-sandbox account; provision rootless Podman first." >&2; exit 2; }
getent group vps-mcp >/dev/null || { echo "Missing vps-mcp group." >&2; exit 2; }
[[ -d "/run/user/${UID_VALUE}" ]] || { echo "Missing /run/user/${UID_VALUE}; enable lingering and the vps-sandbox user manager first." >&2; exit 2; }
[[ -S "/run/user/${UID_VALUE}/bus" ]] || { echo "Missing vps-sandbox user D-Bus socket." >&2; exit 2; }
command -v systemd-analyze >/dev/null || { echo "systemd-analyze is required." >&2; exit 2; }
command -v setfacl >/dev/null || { echo "The acl package (setfacl) is required for per-worktree runtime access." >&2; exit 2; }
command -v find >/dev/null || { echo "find is required for inherited worktree ACLs." >&2; exit 2; }

# Resolve the block devices backing approved workspace roots. The quota broker
# uses DevicePolicy=closed and receives access only to these devices.
for workspace_root in /var/lib/vps-mcp/task-workspaces/worktrees /srv/vps-mcp-workspaces; do
  [[ -d "$workspace_root" ]] || continue

  source_device="$(findmnt -n -o SOURCE -T "$workspace_root")"
  [[ "$source_device" == /dev/* && -b "$source_device" ]] || {
    echo "Cannot safely resolve a block device for workspace root: $workspace_root ($source_device)" >&2
    exit 2
  }

  device="$(readlink -f -- "$source_device")"
  [[ -b "$device" ]] || {
    echo "Workspace backing device is not a block device: $device" >&2
    exit 2
  }

  if [[ -z "${SEEN_QUOTA_DEVICES[$device]+x}" ]]; then
    SEEN_QUOTA_DEVICES["$device"]=1
    QUOTA_DEVICE_ALLOW+=("$device")
  fi
done

((${#QUOTA_DEVICE_ALLOW[@]} > 0)) || {
  echo "No approved workspace root has a resolvable block device." >&2
  exit 2
}

systemd-analyze verify "$REPO_DIR/systemd/vps-sandbox-runtime.socket" "$REPO_DIR/systemd/vps-sandbox-runtime.service" "$QUOTA_SOCKET_SOURCE" "$QUOTA_SERVICE_SOURCE"
install -d -o root -g root -m 0755 "${LIBEXEC}" "${ENV_DIR}"
install -d -o root -g vps-sandbox -m 0750 /var/lib/vps-sandbox-mounts
install -o root -g root -m 0755 "${SCRIPT_DIR}/vps-sandbox-runtime.mjs" "${LIBEXEC}/vps-sandbox-runtime.mjs"
install -o root -g root -m 0644 "${SCRIPT_DIR}/executions.mjs" "${LIBEXEC}/executions.mjs"
install -o root -g root -m 0644 "${SCRIPT_DIR}/secret-redaction.mjs" "${LIBEXEC}/secret-redaction.mjs"
install -o root -g root -m 0644 "$SCRIPT_DIR/resource-governance.mjs" "$LIBEXEC/resource-governance.mjs"
install -o root -g root -m 0755 "$SCRIPT_DIR/vps-sandbox-quota-helper.mjs" "$LIBEXEC/vps-sandbox-quota-helper.mjs"
install -o root -g root -m 0755 "$SCRIPT_DIR/vps-sandbox-quota-broker.mjs" "$LIBEXEC/vps-sandbox-quota-broker.mjs"

if [[ ! -e "${RUNTIME_ENV}" ]]; then
  umask 027
  cat > "${RUNTIME_ENV}" <<ENV
XDG_RUNTIME_DIR=/run/user/${UID_VALUE}
DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${UID_VALUE}/bus
VPS_SANDBOX_ALLOWED_WORKSPACE_ROOTS=
VPS_SANDBOX_ALLOWED_IMAGES=
# Resource governance defaults. Blank CPU/memory values use conservative host-derived limits.
VPS_SANDBOX_GLOBAL_CPU_MILLI=
VPS_SANDBOX_GLOBAL_MEMORY_MIB=
VPS_SANDBOX_GLOBAL_PIDS=2048
VPS_SANDBOX_GLOBAL_DISK_MIB=153600
VPS_SANDBOX_MAX_ACTIVE_TASKS=8
VPS_SANDBOX_REPOSITORY_CPU_MILLI=
VPS_SANDBOX_REPOSITORY_MEMORY_MIB=
VPS_SANDBOX_REPOSITORY_PIDS=
VPS_SANDBOX_REPOSITORY_DISK_MIB=102400
VPS_SANDBOX_DISK_WARNING_BYTES=16106127360
VPS_SANDBOX_DISK_RESERVE_BYTES=5368709120
VPS_SANDBOX_TASK_RETENTION_MS=604800000
VPS_SANDBOX_LOCK_TIMEOUT_MS=180000
VPS_SANDBOX_STALE_LOCK_MS=60000
VPS_SANDBOX_TEMP_FILE_RETENTION_MS=600000
# Cleanup is opt-in. Review retention and enable manually after rollout acceptance.
VPS_SANDBOX_CLEANUP_ENABLED=false
ENV
  chown root:vps-sandbox "${RUNTIME_ENV}"
  chmod 0640 "${RUNTIME_ENV}"
else
  echo "Preserving existing ${RUNTIME_ENV}; inspect its D-Bus and workspace-root values manually."
fi

install -o root -g root -m 0644 "$REPO_DIR/systemd/vps-sandbox-runtime.socket" "$SYSTEMD_DIR/vps-sandbox-runtime.socket"
install -o root -g root -m 0644 "$QUOTA_SOCKET_SOURCE" "$QUOTA_SOCKET"
install -o root -g root -m 0644 "$QUOTA_SERVICE_SOURCE" "$QUOTA_SERVICE"

install -d -o root -g root -m 0755 "$QUOTA_SERVICE_DROPIN_DIR"
dropin_tmp="$(mktemp)"
{
  printf '[Service]\n'
  for device in "${QUOTA_DEVICE_ALLOW[@]}"; do
    printf 'DeviceAllow=%s rw\n' "$device"
  done
} > "$dropin_tmp"
install -o root -g root -m 0644 "$dropin_tmp" "$QUOTA_SERVICE_DROPIN_DIR/device-access.conf"
rm -f "$dropin_tmp"
install -o root -g root -m 0644 "${REPO_DIR}/systemd/vps-sandbox-runtime.service" "${SYSTEMD_DIR}/vps-sandbox-runtime.service"

# Podman needs its per-user runtime directory writable inside the service sandbox.
install -d -o root -g root -m 0755 "${RUNTIME_SERVICE_DROPIN_DIR}"
runtime_dropin_tmp="$(mktemp)"
printf '[Service]\nReadWritePaths=/run/user/%s\n' "${UID_VALUE}" > "$runtime_dropin_tmp"
install -o root -g root -m 0644 "$runtime_dropin_tmp" "${RUNTIME_SERVICE_DROPIN_DIR}/runtime-directory.conf"
rm -f "$runtime_dropin_tmp"
systemctl stop vps-sandbox-runtime.socket vps-sandbox-runtime.service vps-sandbox-quota-broker.socket vps-sandbox-quota-broker.service 2>/dev/null || true
systemctl daemon-reload
systemctl enable --now vps-sandbox-runtime.socket vps-sandbox-quota-broker.socket
systemctl is-active --quiet vps-sandbox-quota-broker.socket
systemctl is-active --quiet vps-sandbox-runtime.socket
printf 'Installed rootless workload runtime agent.\n'
printf 'Socket: /run/vps-sandbox-runtime.sock (vps-sandbox:vps-mcp 0660)\n'
printf 'Agent: vps-sandbox, bounded capability set, delegated CPU/memory/PID cgroups.\n'
printf 'No public vps-mcp.service settings were changed.\n'
printf 'Workload creation remains unavailable until the workspace mount roots and live acceptance are approved.\n'
