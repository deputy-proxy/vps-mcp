#!/usr/bin/env bash
set -Eeuo pipefail

# Deliberately administrator-run. This script installs prerequisites only; it does
# not edit the public vps-mcp systemd unit or weaken its security policy.
if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root: sudo $0 vps-sandbox" >&2
  exit 2
fi

SERVICE_USER="${1:-vps-sandbox}"
if [[ "${SERVICE_USER}" != "vps-sandbox" ]]; then
  echo "Only the dedicated vps-sandbox identity may be provisioned by this script" >&2
  exit 2
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PREFLIGHT_SOURCE="${SCRIPT_DIR}/rootless-runtime-preflight.mjs"
if [[ ! -f "${PREFLIGHT_SOURCE}" ]]; then
  echo "Missing preflight script: ${PREFLIGHT_SOURCE}" >&2
  exit 2
fi

if [[ "$(. /etc/os-release && echo "${ID}:${VERSION_ID}")" != "ubuntu:24.04" ]]; then
  echo "This provisioning script supports Ubuntu 24.04 only; inspect the ADR before adapting it." >&2
  exit 2
fi

if ! getent group "${SERVICE_USER}" >/dev/null 2>&1; then
  groupadd --system "${SERVICE_USER}"
fi
if ! id "${SERVICE_USER}" >/dev/null 2>&1; then
  useradd --system --gid "${SERVICE_USER}" --create-home --home-dir "/var/lib/${SERVICE_USER}" --shell /usr/sbin/nologin "${SERVICE_USER}"
else
  account="$(getent passwd "${SERVICE_USER}")"
  account_home="$(cut -d: -f6 <<<"${account}")"
  account_shell="$(cut -d: -f7 <<<"${account}")"
  account_group="$(id -gn "${SERVICE_USER}")"
  if [[ "${account_home}" != "/var/lib/${SERVICE_USER}" || "${account_shell}" != "/usr/sbin/nologin" || "${account_group}" != "${SERVICE_USER}" ]]; then
    echo "Existing vps-sandbox account must use /var/lib/vps-sandbox, /usr/sbin/nologin and its private primary group; refusing to alter it" >&2
    exit 2
  fi
fi

touch /etc/subuid /etc/subgid

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends podman uidmap slirp4netns fuse-overlayfs

# Ubuntu's Podman package enables system-level (rootful) units by default.
# This platform uses only the dedicated rootless vps-sandbox context.
ROOTFUL_PODMAN_UNITS=(
  podman.socket
  podman.service
  podman-auto-update.timer
  podman-restart.service
  podman-clean-transient.service
)
for unit in "${ROOTFUL_PODMAN_UNITS[@]}"; do
  if systemctl is-enabled "$unit" 2>/dev/null | grep -qx 'enabled'; then
    systemctl disable "$unit"
  fi
  systemctl stop "$unit" 2>/dev/null || true
  systemctl reset-failed "$unit" 2>/dev/null || true
  if systemctl is-active --quiet "$unit"; then
    echo "Rootful Podman unit remains active: $unit" >&2
    exit 1
  fi
done

# Allocate subordinate IDs only when no range already exists. Never overwrite an
# existing allocation; an administrator must resolve overlaps manually.
find_free_range() {
  local file="$1" start=100000 end candidate
  while :; do
    end=$((start + 65535))
    candidate="${start}-${end}"
    if ! awk -F: -v start="${start}" -v end="${end}" 'NF >= 3 { lo=$2; hi=$2+$3-1; if (start <= hi && end >= lo) found=1 } END { exit found ? 0 : 1 }' "${file}"; then
      printf '%s' "${candidate}"
      return 0
    fi
    start=$((end + 1))
    if (( start > 2147418111 )); then
      echo "No free subordinate ID range available in ${file}" >&2
      return 1
    fi
  done
}

if ! grep -qE "^${SERVICE_USER}:" /etc/subuid; then
  usermod --add-subuids "$(find_free_range /etc/subuid)" "${SERVICE_USER}"
fi
if ! grep -qE "^${SERVICE_USER}:" /etc/subgid; then
  usermod --add-subgids "$(find_free_range /etc/subgid)" "${SERVICE_USER}"
fi

install -d -o "${SERVICE_USER}" -g "${SERVICE_USER}" -m 0700 "/var/lib/${SERVICE_USER}/.local/share/containers"
loginctl enable-linger "${SERVICE_USER}"
SANDBOX_UID="$(id -u "${SERVICE_USER}")"
systemctl start "user@${SANDBOX_UID}.service"
if [[ ! -d "/run/user/${SANDBOX_UID}" ]]; then
  echo "The vps-sandbox runtime directory was not created at /run/user/${SANDBOX_UID}" >&2
  exit 1
fi

# The MCP checkout is private to vps-mcp. Install a read-only preflight copy so
# the dedicated runtime identity can execute it without access to the repository.
install -d -o root -g root -m 0755 /usr/local/libexec/vps-mcp
install -o root -g "${SERVICE_USER}" -m 0640 "${PREFLIGHT_SOURCE}" /usr/local/libexec/vps-mcp/rootless-runtime-preflight.mjs

cat <<REPORT
Prerequisites installed for ${SERVICE_USER}.
The runtime preflight is installed at /usr/local/libexec/vps-mcp/rootless-runtime-preflight.mjs.
No systemd service policy was changed.
Next steps:
  1. Run the installed preflight as ${SERVICE_USER} inside the dedicated transient systemd test unit.
  2. If user namespaces still fail, inspect the host/VPS provider restrictions.
  3. Keep the public vps-mcp.service unchanged; use the dedicated runtime identity for feasibility tests.
  4. Do not add sudo, Docker group membership or broad capabilities.
REPORT
