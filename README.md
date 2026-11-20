# vps-mcp

An OAuth-protected remote Model Context Protocol (MCP) server for bootstrapping and operating a self-hosted development VPS. It provides system inspection, bounded filesystem access and synchronous/background command execution.

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

## Authentication

Three modes are available:

- `token`: static bearer token for local development or private integrations.
- `oauth`: validates signed OAuth access-token JWTs against the configured issuer and its JWKS, checks issuer, audience, expiry and required scopes, and publishes RFC 9728 Protected Resource Metadata.
- `none`: permitted only when the Node listener binds to loopback.

### OAuth provider requirements

This project implements the MCP **resource server**, not an authorization server. The external identity provider handles sign-in, consent, authorization-code exchange, PKCE, refresh tokens and client registration.

The provider must support Authorization Code with PKCE S256, refresh tokens, audience/resource binding, signed JWT access tokens, and ChatGPT-compatible Client ID Metadata Documents (CIMD) or Dynamic Client Registration (DCR). Configure the provider to issue the exact MCP audience and the scopes listed in `OAUTH_REQUIRED_SCOPES`.

When `OAUTH_JWKS_URL` is omitted, the server reads the provider's OpenID Connect discovery document at `{issuer}/.well-known/openid-configuration`, verifies that its `issuer` exactly matches `OAUTH_ISSUER_URL`, and uses its HTTPS `jwks_uri`. An explicit HTTPS `OAUTH_JWKS_URL` may be supplied for providers without standard OIDC discovery. Discovery is cached after the first successful lookup; a failed lookup returns HTTP 503 rather than incorrectly reporting the client's token as invalid.

The server publishes `GET /.well-known/oauth-protected-resource/mcp`. On missing or invalid credentials it responds with a Bearer challenge referencing that metadata document.

### CORS

Browser access is disabled by default. Set `MCP_CORS_ORIGINS` to a comma-separated list of exact HTTPS origins (or localhost HTTP origins for development). Paths and wildcards are not accepted. Requests without an `Origin` header, such as server-to-server MCP clients, are unaffected. Disallowed browser preflight requests receive HTTP 403.

### OAuth environment

- `MCP_PUBLIC_URL`: canonical public MCP URL, including `/mcp`.
- `OAUTH_ISSUER_URL`: exact issuer identifier from the provider.
- `OAUTH_AUDIENCE`: expected JWT audience, normally the MCP resource URL.
- `OAUTH_JWKS_URL`: optional explicit HTTPS JWKS URL; otherwise discovered through OIDC.
- `OAUTH_REQUIRED_SCOPES`: space- or comma-separated required scopes (default: `mcp`).
- `MCP_CORS_ORIGINS`: optional exact browser origins allowed to access the endpoint.

Do not enable OAuth mode until the provider is configured and its issuer and audience are known. The existing loopback token-auth deployment remains compatible and is not changed by this code update.

## Security model

- Run as a dedicated, unprivileged Linux account.
- Filesystem tools and command working directories are restricted to `MCP_ALLOWED_ROOTS`.
- Commands run as the service account, not as root.
- No Docker socket, SSH private key or host credential directory is mounted into the service.
- Do not add the service account to the Docker group; Docker access is effectively root access.
- OAuth validates signed JWTs on every MCP request and rejects invalid issuer, audience, expiry or missing scopes.
- TLS is mandatory at the public reverse proxy. Keep the Node listener private on loopback.

A shell tool is powerful by design. An authorized user can run commands with the service account's operating-system permissions. Keep the account unprivileged and the allowed filesystem roots narrow.

## Requirements

- Linux (tested deployment target: Ubuntu 24.04 LTS)
- Node.js 22 or newer
- npm
- A dedicated service account

## Local development

```bash
cp .env.example .env
# Keep MCP_AUTH_MODE=token and set MCP_AUTH_TOKEN to a random secret.
npm install
npm run typecheck
npm test
npm run build
```

Generate a token:

```bash
openssl rand -hex 32
```

## VPS deployment

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

3. Keep the current private deployment in token mode. For a public deployment, configure the OAuth provider and environment variables before changing the authentication mode.

4. Install and start the systemd service, then configure DNS and Caddy using `deploy/Caddyfile.example`. Permit inbound TCP 80/443 and keep port 3000 closed to the public internet.

5. Verify protected-resource metadata and test valid, expired, wrong-issuer, wrong-audience and insufficient-scope tokens before connecting a real MCP client.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `MCP_HOST` | `127.0.0.1` | Bind address |
| `MCP_PORT` | `3000` | HTTP port |
| `MCP_AUTH_MODE` | `token` | `token`, `oauth` or loopback-only `none` |
| `MCP_AUTH_TOKEN` | required in token mode | Static bearer token, minimum 32 characters |
| `MCP_PUBLIC_URL` | unset | Canonical public MCP URL, required for OAuth |
| `OAUTH_ISSUER_URL` | unset | OAuth/OIDC issuer URL, required for OAuth |
| `OAUTH_AUDIENCE` | unset | Required JWT audience, required for OAuth |
| `OAUTH_JWKS_URL` | OIDC discovery | Optional explicit signing-key URL |
| `OAUTH_REQUIRED_SCOPES` | `mcp` | Required scopes |
| `MCP_CORS_ORIGINS` | empty | Exact allowed browser origins |
| `MCP_ALLOWED_ROOTS` | `/srv,$HOME/.local/share/vps-mcp` | Comma-separated allowed filesystem roots |
| `MCP_DATA_DIR` | `$HOME/.local/share/vps-mcp` | Persistent execution metadata and logs |
| `MCP_MAX_REQUEST_BYTES` | `2097152` | Maximum HTTP JSON request size |
| `MCP_DEFAULT_COMMAND_TIMEOUT_MS` | `30000` | Default synchronous command timeout |
| `MCP_MAX_COMMAND_TIMEOUT_MS` | `900000` | Maximum synchronous command timeout |
| `MCP_MAX_OUTPUT_BYTES` | `1048576` | Maximum synchronous command output |

## Known boundaries

- OAuth is delegated to an external authorization server; this project is the protected MCP resource server, not an identity provider.
- Only signed JWT access tokens are supported. Opaque-token introspection is not implemented.
- Active background process supervision is not yet managed by systemd or a dedicated process supervisor.
- Privileged host administration requires a separately designed, narrowly scoped helper; unrestricted sudo must not be granted.
- Repository registry, Git worktree orchestration, concurrency locks, backups and management GUI remain later milestones.
- The server does not yet implement a Railway Sandbox MCP compatibility layer.

## Development checks

```bash
npm run typecheck
npm test
npm run build
```
