#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${VPS_MCP_APP_DIR:-/opt/vps-mcp}"
DATA_DIR="/var/lib/vps-mcp"
ENV_DIR="/etc/vps-mcp"
ENV_FILE="${ENV_DIR}/vps-mcp.env"
SERVICE_NAME="vps-mcp"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log() { printf '[vps-mcp] %s\n' "$*"; }
fail() { printf '[vps-mcp] ERROR: %s\n' "$*" >&2; exit 1; }

[[ "$EUID" -eq 0 ]] || fail "Run this installer as root (sudo ./deploy/install.sh)."
[[ -f "${SOURCE_DIR}/package.json" ]] || fail "Run the installer from a vps-mcp repository checkout."
command -v systemctl >/dev/null 2>&1 || fail "systemd is required."
command -v curl >/dev/null 2>&1 || fail "curl is required."
command -v tar >/dev/null 2>&1 || fail "tar is required."
command -v openssl >/dev/null 2>&1 || fail "openssl is required."
[[ -x /usr/bin/node ]] || fail "Node.js must be installed at /usr/bin/node."
[[ "$(/usr/bin/node -p 'Number(process.versions.node.split(".")[0])')" -ge 22 ]] || fail "Node.js 22 or newer is required."
command -v npm >/dev/null 2>&1 || fail "npm is required."
command -v runuser >/dev/null 2>&1 || fail "runuser is required."

if ! id vps-mcp >/dev/null 2>&1; then
  log "Creating the unprivileged vps-mcp service account."
  useradd --system --create-home --home-dir "$DATA_DIR" --shell /usr/sbin/nologin vps-mcp
fi

install -d -o vps-mcp -g vps-mcp -m 0750 "$APP_DIR" "$DATA_DIR" /srv
install -d -o root -g vps-mcp -m 0750 "$ENV_DIR"

if [[ ! -f "$ENV_FILE" ]]; then
  token="$(openssl rand -hex 32)"
  umask 027
  cat > "$ENV_FILE" <<EOF
MCP_HOST=127.0.0.1
MCP_PORT=3000
MCP_AUTH_MODE=token
MCP_AUTH_TOKEN=$token
MCP_ALLOWED_ROOTS=/srv,$DATA_DIR
MCP_DATA_DIR=$DATA_DIR
EOF
  chmod 0640 "$ENV_FILE"
  chown root:vps-mcp "$ENV_FILE"
  unset token
  log "Created a private token-auth environment file. The token was not printed."
else
  chmod 0640 "$ENV_FILE"
  chown root:vps-mcp "$ENV_FILE"
  grep -q '^MCP_AUTH_MODE=' "$ENV_FILE" || fail "$ENV_FILE exists but has no MCP_AUTH_MODE."
  grep -q '^MCP_AUTH_TOKEN=' "$ENV_FILE" || fail "$ENV_FILE exists but has no MCP_AUTH_TOKEN."
fi

log "Copying application source into $APP_DIR."
tar --exclude=.git --exclude=node_modules --exclude=dist -cf - -C "$SOURCE_DIR" . | tar -xf - -C "$APP_DIR"
chown -R vps-mcp:vps-mcp "$APP_DIR" "$DATA_DIR"

log "Installing dependencies and building production output."
runuser -u vps-mcp -- npm install --prefix "$APP_DIR"
runuser -u vps-mcp -- npm run build --prefix "$APP_DIR"

log "Installing systemd service."
install -o root -g root -m 0644 "$APP_DIR/systemd/vps-mcp.service" "/etc/systemd/system/${SERVICE_NAME}.service"
systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"

log "Waiting for the local health endpoint."
healthy=false
for _ in $(seq 1 20); do
  if curl --fail --silent http://127.0.0.1:3000/healthz >/dev/null; then
    healthy=true
    break
  fi
  sleep 1
done

if [[ "$healthy" != true ]]; then
  systemctl --no-pager --full status "$SERVICE_NAME" || true
  journalctl -u "$SERVICE_NAME" -n 50 --no-pager || true
  fail "Service did not become healthy. See the logs above."
fi

auth_status="$(curl --silent --output /dev/null --write-out '%{http_code}' \
  --header 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  http://127.0.0.1:3000/mcp)"

[[ "$auth_status" == "401" ]] || fail "Expected unauthenticated MCP requests to return 401; received HTTP $auth_status."

log "Installation complete. Health check passed and unauthenticated MCP access is rejected."
log "The service listens on 127.0.0.1:3000. Do not open port 3000 publicly."
log "Next: configure DNS, TLS reverse proxy and an OAuth provider before public client access."
