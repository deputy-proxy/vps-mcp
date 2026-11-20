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

The MCP endpoint uses Streamable HTTP at `POST /mcp`. The server is stateless at the MCP transport layer; background execution metadata and logs are persisted under `MCP_DATA_DIR`. Pass absolute paths to filesystem tools and use an allowed directory as the command working directory.

## Authentication

Three modes are available:

- `token`: static bearer token for local development or private integrations. Keep the token secret. It is not a supported authentication method for a directly connected ChatGPT custom MCP server.
- `oauth`: public MCP deployment mode. The server validates OAuth access-token JWTs against the configured issuer and JWKS, checks issuer, audience, expiry and required scopes, and publishes RFC 9728 Protected Resource Metadata.
- `none`: permitted only when the Node listener binds to loopback. Never expose an unauthenticated listener publicly.

### ChatGPT-compatible OAuth provider

This repository implements the MCP **resource server** side of OAuth. The configured external authorization server remains responsible for user sign-in, consent, authorization-code exchange, PKCE, refresh-token issuance and OAuth client registration. This avoids inventing a password database or a home-grown authorization server inside the VPS management process.

The identity provider must be configured to meet the MCP authorization and ChatGPT requirements:

1. Authorization Code grant with PKCE using `S256`; do not enable implicit or client-credentials grants for this connection.
2. Refresh tokens with rotation or equivalent secure refresh-token lifecycle, and offline access where the provider requires it.
3. OAuth resource/audience binding for the exact MCP URL configured in `MCP_PUBLIC_URL`; issued access tokens must contain that audience.
4. A signed JWT access token with a published JWKS endpoint. Opaque access tokens are not supported by this verifier.
5. Client registration compatible with ChatGPT: Client ID Metadata Documents (CIMD), including public-client token exchange with `none` or `private_key_jwt`, or Dynamic Client Registration (DCR).
6. The issuer metadata must advertise `code_challenge_methods_supported: ["S256"]` and the supported token endpoint authentication methods. Configure the provider's allowed redirect URIs according to the ChatGPT custom MCP connection's displayed callback URL.
7. Issue the scope configured in `OAUTH_REQUIRED_SCOPES` (default: `mcp`) and preserve the MCP audience in the access token.

The server publishes `GET /.well-known/oauth-protected-resource/mcp` with the resource URL, issuer and supported scopes. On missing or invalid credentials it responds with a Bearer challenge referencing that metadata document. The OAuth issuer's own RFC 8414/OpenID discovery document must advertise its authorization and token endpoints and the registration capabilities above.

Do not set `MCP_AUTH_MODE=oauth` until the identity provider is configured and its issuer, audience and JWKS URL are known. The existing loopback token-auth deployment remains compatible and is not changed by this code update.

### OAuth environment

See `.env.example` for the complete list. Required values in OAuth mode:

- `MCP_PUBLIC_URL`: canonical public MCP URL, including `/mcp`.
- `OAUTH_ISSUER_URL`: exact issuer identifier from the identity provider.
- `OAUTH_AUDIENCE`: expected audience claim, normally the exact MCP resource URL.
- `OAUTH_JWKS_URL`: optional JWKS URL; defaults to `.well-known/jwks.json` relative to the issuer.
- `OAUTH_REQUIRED_SCOPES`: space- or comma-separated required scopes.

The Node listener should remain bound to `127.0.0.1`; Caddy or Nginx terminates public HTTPS and proxies to port 3000. Do not expose port 3000 directly.

## Security model

- Run as a dedicated, unprivileged Linux account.
- Filesystem tools and command working directories are restricted to `MCP_ALLOWED_ROOTS`.
- Commands run as the service account, not as root.
- No Docker socket, SSH private key or host credential directory is mounted into the service.
- Do not add the service account to the Docker group; Docker access is effectively root access.
- OAuth mode validates signed JWTs on every MCP request and rejects invalid issuer, audience, expiry or missing scopes.
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
npm start
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

3. Create `/etc/vps-mcp/vps-mcp.env` with the existing token-mode settings for a private/local deployment. For a public deployment, configure all OAuth variables from `.env.example` and set `MCP_AUTH_MODE=oauth`. Do not switch the currently running server to OAuth until the issuer, audience and JWKS settings are valid.

4. Install and start the systemd service:

   ```bash
   sudo cp /opt/vps-mcp/systemd/vps-mcp.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now vps-mcp
   sudo systemctl status vps-mcp
   ```

5. Configure DNS for the public hostname and Caddy with `deploy/Caddyfile.example`. Caddy obtains and renews the TLS certificate automatically. Permit inbound TCP 80/443 and keep port 3000 closed to the public internet.

6. Once the OAuth provider is configured, verify the protected-resource metadata endpoint and test that unauthenticated MCP requests receive a `401` Bearer challenge containing its URL. Then complete the ChatGPT OAuth connection and verify that valid, expired, wrong-audience and insufficient-scope tokens behave correctly.

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
| `OAUTH_JWKS_URL` | issuer-relative default | Signing keys used to validate access tokens |
| `OAUTH_REQUIRED_SCOPES` | `mcp` | Required space- or comma-separated scopes |
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
