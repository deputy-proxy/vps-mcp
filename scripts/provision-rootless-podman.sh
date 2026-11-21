#!/usr/bin/env bash
set -Eeuo pipefail

# Deliberately administrator-run. This script installs prerequisites only; it does
# not edit the vps-mcp systemd unit or weaken its security policy.
if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root: sudo $0 [service-user]" >&2
  exit 2
fi

SERVICE_USER="${1:-vps-mcp}"
if ! id "${SERVICE_USER}" >/dev/null 2>&1; then
  echo "Service account '${SERVICE_USER}' does not exist" >&2
  exit 2
fi
if [[ "$(. /etc/os-release && echo "${ID}:${VERSION_ID}")" != "ubuntu:24.04" ]]; then
  echo "This provisioning script supports Ubuntu 24.04 only; inspect the ADR before adapting it." >&2
  exit 2
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends podman uidmap slirp4netns fuse-overlayfs

# Allocate subordinate IDs only when no range already exists. Never overwrite an
# existing allocation; an administrator must resolve overlaps manually.
find_free_range() {
  local file="$1" start=100000 end candidate
  while :; do
    end=$((start + 65535))
    candidate="${start}-${end}"
    if ! awk -F: -v start="$start" -v end="$end" 'NF >= 3 { lo=$2; hi=$2+$3-1; if (start <= hi && end >= lo) found=1 } END { exit found ? 0 : 1 }' "$file"; then
      printf '%s' "$candidate"
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

cat <<REPORT
Prerequisites installed for ${SERVICE_USER}.
No systemd service policy was changed.
Next steps:
  1. Run scripts/rootless-runtime-preflight.mjs as ${SERVICE_USER}.
  2. If user namespaces still fail, inspect the host/VPS provider restrictions.
  3. Prove rootless Podman under the actual vps-mcp.service before enabling it.
  4. Do not remove NoNewPrivileges or add broad capabilities as a workaround.
REPORT
