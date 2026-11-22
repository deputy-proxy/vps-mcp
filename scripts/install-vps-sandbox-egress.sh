#!/usr/bin/env bash
set -Eeuo pipefail
if [[ $EUID -ne 0 ]]; then echo "Run as root: sudo bash scripts/install-vps-sandbox-egress.sh" >&2; exit 2; fi
SCRIPT_DIR="$(cd -- "$(dirname -- "$BASH_SOURCE")" && pwd)"
REPO_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
RUNTIME_ENV=/etc/vps-sandbox/runtime.env
[[ -f "$RUNTIME_ENV" ]] || { echo "Install the rootless runtime before enabling restricted task egress." >&2; exit 2; }
command -v systemd-analyze >/dev/null
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends squid nftables
if systemctl is-active --quiet squid.service; then
  echo "The distribution squid.service is already active; refusing to replace an existing proxy." >&2
  exit 2
fi
if ! getent group vps-egress >/dev/null; then groupadd --system vps-egress; fi
if ! id vps-egress >/dev/null 2>&1; then useradd --system --gid vps-egress --home-dir /var/lib/vps-egress --no-create-home --shell /usr/sbin/nologin vps-egress; fi
install -d -o root -g vps-egress -m 0750 /etc/vps-sandbox/egress
install -d -o vps-egress -g vps-egress -m 0750 /var/log/vps-sandbox-egress
cat > /etc/vps-sandbox/egress/allowed-domains.txt <<'DOMAINS'
^registry\.npmjs\.org$
^registry\.yarnpkg\.com$
^github\.com$
^api\.github\.com$
^codeload\.github\.com$
^raw\.githubusercontent\.com$
^objects\.githubusercontent\.com$
^release-assets\.githubusercontent\.com$
^github\.githubassets\.com$
^repo\.packagist\.org$
^pypi\.org$
^files\.pythonhosted\.org$
^rubygems\.org$
^index\.rubygems\.org$
^api\.rubygems\.org$
^api\.nuget\.org$
^globalcdn\.nuget\.org$
^archive\.ubuntu\.com$
^security\.ubuntu\.com$
^ports\.ubuntu\.com$
^registry-1\.docker\.io$
^auth\.docker\.io$
^production\.cloudflare\.docker\.com$
^quay\.io$
^ghcr\.io$
^pkg-containers\.githubusercontent\.com$
^nodejs\.org$
^getcomposer\.org$
^php\.net$
DOMAINS
cat > /etc/vps-sandbox/egress/squid.conf <<'SQUID'
http_port 127.0.0.1:3128
visible_hostname vps-sandbox-egress
cache_effective_user vps-egress
cache_effective_group vps-egress
cache deny all
cache_store_log none
access_log stdio:/dev/stdout
cache_log stdio:/dev/stderr
pid_filename /run/vps-sandbox-egress/squid.pid
acl localhost src 127.0.0.1/32 ::1/128 10.0.2.0/24
acl CONNECT method CONNECT
acl Safe_ports port 80 443
acl SSL_ports port 443
acl allowed_domains dstdom_regex "/etc/vps-sandbox/egress/allowed-domains.txt"
acl private_dst dst 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.168.0.0/16 198.18.0.0/15 224.0.0.0/4 240.0.0.0/4 ::/128 ::1/128 ::ffff:0:0/96 fc00::/7 fe80::/10 ff00::/8
http_access deny !Safe_ports
http_access deny CONNECT !SSL_ports
http_access deny private_dst
http_access allow localhost allowed_domains
http_access deny all
SQUID
cat > /etc/vps-sandbox/egress/egress.nft <<'NFT'
destroy table inet vps_sandbox_egress
table inet vps_sandbox_egress {
  chain output {
    type filter hook output priority -150; policy accept;
    # Rootless slirp4netns may open host sockets only to the loopback proxy.
    meta skuid vps-sandbox ip daddr 127.0.0.1 tcp dport 3128 accept
    meta skuid vps-sandbox drop

    # Proxy DNS is permitted; proxy connections to local/private/metadata
    # addresses and arbitrary ports are denied before public web egress.
    meta skuid vps-egress udp dport 53 accept
    meta skuid vps-egress tcp dport 53 accept
    meta skuid vps-egress fib daddr type local drop
    meta skuid vps-egress ip daddr { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.168.0.0/16, 198.18.0.0/15, 224.0.0.0/4, 240.0.0.0/4 } drop
    meta skuid vps-egress ip6 daddr { ::/128, ::1/128, ::ffff:0:0/96, fc00::/7, fe80::/10, ff00::/8 } drop
    meta skuid vps-egress tcp dport { 80, 443 } accept
    meta skuid vps-egress drop
  }
}
NFT
chown -R root:vps-egress /etc/vps-sandbox/egress
chmod 0750 /etc/vps-sandbox/egress
chmod 0640 /etc/vps-sandbox/egress/*
systemd-analyze verify "$REPO_DIR/systemd/vps-sandbox-egress-firewall.service" "$REPO_DIR/systemd/vps-sandbox-egress-proxy.service"
/usr/sbin/squid -k parse -f /etc/vps-sandbox/egress/squid.conf
install -o root -g root -m 0644 "$REPO_DIR/systemd/vps-sandbox-egress-firewall.service" /etc/systemd/system/vps-sandbox-egress-firewall.service
install -o root -g root -m 0644 "$REPO_DIR/systemd/vps-sandbox-egress-proxy.service" /etc/systemd/system/vps-sandbox-egress-proxy.service
systemctl disable --now squid.service 2>/dev/null || true
install -d -o root -g root -m 0755 /etc/systemd/system/vps-sandbox-runtime.service.d
cat > /etc/systemd/system/vps-sandbox-runtime.service.d/egress.conf <<'DROPIN'
[Unit]
Requires=vps-sandbox-egress-firewall.service vps-sandbox-egress-proxy.service
After=vps-sandbox-egress-firewall.service vps-sandbox-egress-proxy.service
DROPIN
systemctl daemon-reload
systemctl enable --now vps-sandbox-egress-firewall.service
systemctl is-active --quiet vps-sandbox-egress-firewall.service
systemctl enable --now vps-sandbox-egress-proxy.service
systemctl restart vps-sandbox-egress-proxy.service
systemctl is-active --quiet vps-sandbox-egress-proxy.service
python3 - "$RUNTIME_ENV" <<'PY'
from pathlib import Path
import sys
p=Path(sys.argv[1])
lines=p.read_text().splitlines()
updates={
 'VPS_SANDBOX_EGRESS_ENABLED':'true',
 'VPS_SANDBOX_EGRESS_PROXY_URL':'http://127.0.0.1:3128',
 'VPS_SANDBOX_EGRESS_CONTAINER_PROXY_URL':'http://10.0.2.2:3128',
}
for key,value in updates.items():
 prefix=key+'='
 found=[i for i,line in enumerate(lines) if line.startswith(prefix)]
 if found: lines[found[-1]]=prefix+value
 else: lines.append(prefix+value)
p.write_text(chr(10).join(lines)+chr(10))
PY
chown root:vps-sandbox "$RUNTIME_ENV"
chmod 0640 "$RUNTIME_ENV"
systemctl daemon-reload
systemctl try-restart vps-sandbox-runtime.service
echo "Restricted task egress installed. Direct vps-sandbox UID egress is blocked."
echo "Review /etc/vps-sandbox/egress/allowed-domains.txt before adding further destinations."
