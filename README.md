# vps-mcp

An authenticated remote Model Context Protocol (MCP) server for bootstrapping and operating a self-hosted development VPS. The initial release provides system inspection, bounded filesystem access and synchronous/background command execution.

## Current capabilities

| Tool | Purpose |
|---|---|
| `system.health` | Service and data-directory health |
| `system.info` | OS, CPU, memory, load, uptime and filesystem information |
| `terminal.execute` | Execute a bounded Bash command |
| `terminal.start` | Start a detached command with persistent logs |
| `terminal.status` | Inspect a background execution |
| `terminal.logs` | Read recent execution output |
| `terminal.cancel` | Send SIGTERM to an execution process group |
| `filesystem.list` | List an allowed directory |
| `filesystem.read` | Read a UTF-8 file (maximum 2 MiB) |
| `filesystem.write` | Atomically create or replace a UTF-8 file (maximum 2 MiB) |

The MCP endpoint uses Streamable HTTP at `POST /mcp`. The server is stateless at the MCP transport layer; background execution metadata and logs are persisted under `MCP_DATA_DIR`.

## Security model

- All MCP requests require an `Authorization: Bearer <token>` header.
- `MCP_AUTH_TOKEN` must contain at least 32 characters.
- The service should run as a dedicated, unprivileged Linux account.
- Filesystem tools and command working directories are restricted to `MCP_ALLOWED_ROOTS`.
- Commands run as the service account, not as root.
- No Docker socket, SSH private key or host credential directory is mounted into the service.
- The recommended deployment binds to `127.0.0.1` and uses Caddy or Nginx for HTTPS.
- Do not expose port 3000 directly to the public internet.

**Important:** A shell tool is powerful by design. A bearer token grants the holder the ability to run commands with the service account's permissions. Protect the token as a password, use TLS, keep the account unprivileged and do not add the account to the Docker group (Docker access is effectively root access).

The first version uses a static bearer token, not OAuth. Before connecting it to a client that requires OAuth-based MCP authorization, add and validate an OAuth authorization server/resource-server flow rather than weakening authentication.

## Requirements

- Linux (tested deployment target: Ubuntu 24.04 LTS)
- Node.js 22 or newer
- npm
- A dedicated service account
- Caddy or Nginx for public HTTPS termination

## Local development

```bash
cp .env.example .env
# Set MCP_AUTH_TOKEN to a random secret of at least 32 characters.
npm install
npm run typecheck
npm test
npm run build
npm start
```

The default bind address is `127.0.0.1:3000`. Configure `MCP_ALLOWED_ROOTS` to include an existing directory before calling filesystem or terminal tools.

Generate a token:

```bash
openssl rand -hex 32
```

## VPS deployment

The service is intended to run directly on the host (not in a container), so terminal commands operate in the VPS environment.

1. Create the service account and directories:

   ```bash
   sudo useradd --system --create-home --home-dir /var/lib/vps-mcp --shell /usr/sbin/nologin vps-mcp
   sudo install -d -o vps-mcp -g vps-mcp -m 0750 /opt/vps-mcp /srv /var/lib/vps-mcp
   sudo install -d -o root -g vps-mcp -m 0750 /etc/vps-mcp
   ```

2. Clone the repository into `/opt/vps-mcp`, install dependencies and build:

   ```bash
   sudo git clone https://github.com/deputy-proxy/vps-mcp.git /opt/vps-mcp
   sudo chown -R vps-mcp:vps-mcp /opt/vps-mcp
   sudo -u vps-mcp npm install --prefix /opt/vps-mcp
   sudo -u vps-mcp npm run build --prefix /opt/vps-mcp
   ```

3. Create `/etc/vps-mcp/vps-mcp.env`:

   ```bash
   sudo sh -c 'umask 077; cat > /etc/vps-mcp/vps-mcp.env' <<'EOF'
   MCP_HOST=127.0.0.1
   MCP_PORT=3000
   MCP_AUTH_TOKEN=REPLACE_WITH_OUTPUT_OF_OPENSSL_RAND_HEX_32
   MCP_ALLOWED_ROOTS=/srv,/var/lib/vps-mcp
   MCP_DATA_DIR=/var/lib/vps-mcp
   MCP_DEFAULT_COMMAND_TIMEOUT_MS=30000
   MCP_MAX_COMMAND_TIMEOUT_MS=900000
   MCP_MAX_OUTPUT_BYTES=1048576
   EOF
   sudo chown root:vps-mcp /etc/vps-mcp/vps-mcp.env
   sudo chmod 0640 /etc/vps-mcp/vps-mcp.env
   ```

4. Install and start systemd service:

   ```bash
   sudo cp /opt/vps-mcp/systemd/vps-mcp.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now vps-mcp
   sudo systemctl status vps-mcp
   ```

5. Configure Caddy with `deploy/Caddyfile.example`, replacing `mcp.example.com` with a DNS name pointing to the VPS. Permit inbound HTTPS (443) and SSH only; keep port 3000 bound to localhost.

6. Check local health:

   ```bash
   curl http://127.0.0.1:3000/healthz
   ```

7. Test the authenticated MCP endpoint with an MCP client configured for the URL `https://mcp.example.com/mcp` and the bearer token. Do not put the token in shell history or commit it to Git.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `MCP_HOST` | `127.0.0.1` | Bind address |
| `MCP_PORT` | `3000` | HTTP port |
| `MCP_AUTH_TOKEN` | required | Static bearer token, minimum 32 characters |
| `MCP_ALLOWED_ROOTS` | `/srv,$HOME/.local/share/vps-mcp` | Comma-separated allowed filesystem roots |
| `MCP_DATA_DIR` | `$HOME/.local/share/vps-mcp` | Persistent execution metadata and logs |
| `MCP_MAX_REQUEST_BYTES` | `2097152` | Maximum HTTP JSON request size |
| `MCP_DEFAULT_COMMAND_TIMEOUT_MS` | `30000` | Default synchronous command timeout |
| `MCP_MAX_COMMAND_TIMEOUT_MS` | `900000` | Maximum synchronous command timeout |
| `MCP_MAX_OUTPUT_BYTES` | `1048576` | Maximum synchronous command output |

## Known v1 boundaries

- Authentication is a static bearer token; OAuth is not implemented.
- The MCP transport is stateless. Background process metadata and logs persist, but active process supervision is not yet managed by systemd or a dedicated process supervisor.
- Command execution is intentionally unprivileged. Privileged host administration requires a separately designed, narrowly scoped helper; unrestricted sudo must not be granted.
- Repository registry, Git worktree orchestration, concurrency locks, backups and the management GUI are later milestones.
- The server does not yet implement a Railway Sandbox MCP compatibility layer.

## Development checks

```bash
npm run typecheck
npm test
npm run build
```
