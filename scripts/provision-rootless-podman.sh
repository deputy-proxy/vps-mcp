#!/usr/bin/env bash
set -Eeuo pipefail

# Deliberately administrator-run. This script installs prerequisites only; it does
# not edit the vps-mcp systemd unit or weaken its security policy.
if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root: sudo $0 [service-user]" >&2
  exit 2
fi

SERVICE_USER="${1:-vps-sandbox}"
if [[ "${SERVICE_USER}" != "vps-sandbox" ]]; then
  echo "Only the dedicated vps-sandbox identity may be provisioned by this script" >&2
  exit 2
fi

if [[ "$(. /etc/os-release && echo "${ID}:${VERSION_ID}")" != "ubuntu:24.04" ]]; then
  echo "This provisioning script supports Ubuntu 24.04 only; inspect the ADR before adapting it." >&2
  exit 2
fi
if ! id "${SERVICE_USER}" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir /var/lib/vps-sandbox --shell /usr/sbin/nologin vps-sandbox
else
  account="$(getent passwd "${SERVICE_USER}")"
  account_home="$(cut -d: -f6 <<<"${account}")"
  account_shell="$(cut -d: -f7 <<<"${account}")"
  if [[ "${account_home}" != "/var/lib/vps-sandbox" || "${account_shell}" != "/usr/sbin/nologin" ]]; then
    echo "Existing vps-sandbox account must use /var/lib/vps-sandbox and /usr/sbin/nologin; refusing to alter it" >&2
    exit 2
  fi
fi

touch /etc/subuid /etc/subgid
chmod 0644 /etc/subuid /etc/subgid

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
  1. Run scripts/rootless-runtime-preflight.mjs as ${SERVICE_USER} inside the dedicated transient systemd test unit.
  2. If user namespaces still fail, inspect the host/VPS provider restrictions.
  3. Keep the public vps-mcp.service unchanged; use the dedicated runtime identity for feasibility tests.
  4. Do not add sudo, Docker group membership or broad capabilities.
REPORT
