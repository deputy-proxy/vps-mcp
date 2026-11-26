#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root: sudo bash scripts/provision-development-runtime.sh" >&2
  exit 1
fi

readonly REPO_URL="https://github.com/deputy-proxy/vps-mcp.git"
readonly HOSTNAME="vps.mcp.dev.cr8or.be"
readonly PUBLIC_URL="https://${HOSTNAME}/mcp"
readonly EXPECTED_IP="194.163.133.147"
readonly APP_DIR="/opt/vps-mcp-development"
readonly DATA_DIR="/var/lib/vps-mcp-development"
readonly ENV_DIR="/etc/vps-mcp-development"
readonly ENV_FILE="${ENV_DIR}/vps-mcp-development.env"
readonly SERVICE="vps-mcp-development.service"
readonly CADDYFILE="/etc/caddy/Caddyfile"

for cmd in git node npm systemctl caddy curl getent runuser install; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "Missing required command: $cmd" >&2; exit 1; }
done
[[ -f /etc/vps-mcp/vps-mcp.env ]] || { echo "Production environment file is missing; cannot derive the OAuth issuer." >&2; exit 1; }
[[ -f "$CADDYFILE" ]] || { echo "Caddyfile not found at $CADDYFILE." >&2; exit 1; }
[[ ! -e "$APP_DIR" ]] || { echo "$APP_DIR already exists; refusing to overwrite it." >&2; exit 1; }
[[ ! -e "$ENV_FILE" ]] || { echo "$ENV_FILE already exists; refusing to overwrite it." >&2; exit 1; }
[[ ! -e "/etc/systemd/system/$SERVICE" ]] || { echo "$SERVICE already exists; refusing to overwrite it." >&2; exit 1; }

resolved="$(getent ahostsv4 "$HOSTNAME" | awk '{print $1}' | sort -u || true)"
if ! grep -Fxq "$EXPECTED_IP" <<<"$resolved"; then
  echo "DNS for $HOSTNAME does not yet resolve to $EXPECTED_IP from this server. Current answers: ${resolved:-none}" >&2
  echo "Wait for DNS propagation, then rerun. No changes have been made." >&2
  exit 1
fi

issuer="$(sed -n 's/^OAUTH_ISSUER_URL=//p' /etc/vps-mcp/vps-mcp.env | tail -n 1)"
[[ -n "$issuer" ]] || { echo "OAUTH_ISSUER_URL is not configured in production environment." >&2; exit 1; }
[[ "$issuer" == https://* ]] || { echo "The configured OAuth issuer is not HTTPS." >&2; exit 1; }

if ! getent passwd vps-mcp-development >/dev/null; then
  useradd --system --create-home --home-dir "$DATA_DIR" --shell /usr/sbin/nologin vps-mcp-development
fi
install -d -o vps-mcp-development -g vps-mcp-development -m 0750 "$APP_DIR" "$DATA_DIR"
install -d -o root -g vps-mcp-development -m 0750 "$ENV_DIR"

git clone --branch development --single-branch "$REPO_URL" "$APP_DIR"
chown -R vps-mcp-development:vps-mcp-development "$APP_DIR"

umask 077
cat > "$ENV_FILE" <<EOF
NODE_ENV=production
MCP_HOST=127.0.0.1
MCP_PORT=3001
MCP_AUTH_MODE=oauth
MCP_PUBLIC_URL=$PUBLIC_URL
OAUTH_ISSUER_URL=$issuer
OAUTH_AUDIENCE=$PUBLIC_URL
OAUTH_REQUIRED_SCOPES=
MCP_ALLOWED_ROOTS=$DATA_DIR
MCP_DATA_DIR=$DATA_DIR
VPS_SANDBOX_PROJECT_ENV_ROOT=$DATA_DIR/project-environments
VPS_SANDBOX_PROJECT_ENV_OWNER=vps-mcp-development
MCP_DEFAULT_COMMAND_TIMEOUT_MS=30000
MCP_MAX_COMMAND_TIMEOUT_MS=900000
MCP_MAX_OUTPUT_BYTES=1048576
EOF
chown root:vps-mcp-development "$ENV_FILE"
chmod 0640 "$ENV_FILE"

cat > "/etc/systemd/system/$SERVICE" <<EOF
[Unit]
Description=VPS MCP development server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=vps-mcp-development
Group=vps-mcp-development
SupplementaryGroups=vps-mcp
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/node $APP_DIR/dist/index.js
Restart=on-failure
RestartSec=3
TimeoutStopSec=15
KillMode=mixed
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
RestrictRealtime=true
SystemCallArchitectures=native
CapabilityBoundingSet=
ReadWritePaths=$DATA_DIR

[Install]
WantedBy=multi-user.target
EOF
chmod 0644 "/etc/systemd/system/$SERVICE"

runuser -u vps-mcp-development -- npm ci --prefix "$APP_DIR"
runuser -u vps-mcp-development -- npm run build --prefix "$APP_DIR"

backup="$(mktemp)"
cp -a "$CADDYFILE" "$backup"
restore_caddy() { cp -a "$backup" "$CADDYFILE"; rm -f "$backup"; }
trap restore_caddy ERR

cat >> "$CADDYFILE" <<EOF

$HOSTNAME {
        log {
                output file /var/log/caddy/access.log
        }

        encode zstd gzip

        reverse_proxy 127.0.0.1:3001 {
                header_up Host 127.0.0.1
        }

        header {
                Strict-Transport-Security "max-age=31536000"
                X-Content-Type-Options "nosniff"
                Referrer-Policy "no-referrer"
                -Server
        }
}
EOF

caddy validate --config "$CADDYFILE" --adapter caddyfile
systemctl daemon-reload
systemctl enable --now "$SERVICE"
systemctl reload caddy || systemctl restart caddy
rm -f "$backup"
trap - ERR

for attempt in $(seq 1 20); do
  if [[ "$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 5 http://127.0.0.1:3001/mcp || true)" == "401" ]]; then
    echo "Development MCP service is healthy on 127.0.0.1:3001."
    break
  fi
  if [[ "$attempt" -eq 20 ]]; then
    echo "Development service did not return the expected HTTP 401." >&2
    systemctl status "$SERVICE" --no-pager -l || true
    exit 1
  fi
  sleep 2
done

echo "Development runtime provisioned."
echo "Service: $SERVICE"
echo "Checkout: $APP_DIR (development branch)"
echo "Data: $DATA_DIR"
echo "Endpoint: $PUBLIC_URL"
echo "Production service and production Caddy routes were not modified."
