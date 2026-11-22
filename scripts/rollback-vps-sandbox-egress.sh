#!/usr/bin/env bash
set -Eeuo pipefail
if [[ $EUID -ne 0 ]]; then echo "Run as root: sudo bash scripts/rollback-vps-sandbox-egress.sh" >&2; exit 2; fi
SANDBOX_UID=$(id -u vps-sandbox)
TASK_CONTAINERS=$(runuser -u vps-sandbox -- env HOME=/var/lib/vps-sandbox XDG_RUNTIME_DIR="/run/user/$SANDBOX_UID" /usr/bin/podman ps -aq --filter label=io.cr8or.vps-mcp.type=task)
if [[ -n "$TASK_CONTAINERS" ]]; then
  echo "Refusing egress rollback while task containers exist. Stop and remove all task sandboxes first; their current network mode would otherwise become unrestricted." >&2
  exit 2
fi
systemctl stop vps-sandbox-runtime.service
python3 - /etc/vps-sandbox/runtime.env <<'PY'
from pathlib import Path
import sys
p=Path(sys.argv[1])
if p.exists():
 keys=('VPS_SANDBOX_EGRESS_ENABLED=','VPS_SANDBOX_EGRESS_PROXY_URL=','VPS_SANDBOX_EGRESS_CONTAINER_PROXY_URL=')
 p.write_text(''.join(line for line in p.read_text().splitlines(keepends=True) if not line.startswith(keys)))
PY
rm -f /etc/systemd/system/vps-sandbox-runtime.service.d/egress.conf
systemctl daemon-reload
systemctl disable --now vps-sandbox-egress-proxy.service vps-sandbox-egress-firewall.service 2>/dev/null || true
/usr/sbin/nft delete table inet vps_sandbox_egress 2>/dev/null || true
systemctl restart vps-sandbox-runtime.service
echo "Restricted egress has been rolled back. No task containers were present during rollback."
