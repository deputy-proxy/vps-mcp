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

## MCP transport

The server exposes MCP Streamable HTTP at `/mcp` in stateless request/response mode. MCP requests use POST; GET, DELETE and PATCH return 405. The server does not issue session IDs or support server-initiated SSE streams. Each POST creates a fresh MCP server and transport instance. Background execution metadata and logs persist under `MCP_DATA_DIR`.

## Authentication

- `token`: static bearer token for private integrations and initial deployment.
- `oauth`: validates signed OAuth access-token JWTs against the configured issuer and JWKS; checks issuer, audience, expiry and required scopes; publishes RFC 9728 Protected Resource Metadata.
- `none`: permitted only when the listener binds to loopback.

This project is an OAuth protected resource, not an authorization server. The external provider must support Authorization Code + PKCE S256, refresh tokens, resource/audience binding, signed JWT access tokens, and client registration compatible with the intended MCP client (CIMD or DCR where required). Opaque-token introspection is not implemented.

### OAuth configuration

- `MCP_PUBLIC_URL`: canonical HTTPS MCP endpoint, exactly `https://host/mcp`.
- `OAUTH_ISSUER_URL`: exact HTTPS issuer identifier from the provider.
- `OAUTH_AUDIENCE`: HTTPS resource identifier expected in the JWT audience claim.
- `OAUTH_JWKS_URL`: optional explicit HTTPS JWKS URL; otherwise read from OIDC discovery.
- `OAUTH_REQUIRED_SCOPES`: space- or comma-separated required scope tokens; defaults to `mcp`.

The discovery document issuer must exactly match `OAUTH_ISSUER_URL`; the discovered `jwks_uri` must use HTTPS. The first successful JWKS discovery is cached. Failed discovery returns 503.

The resource metadata endpoint is `/.well-known/oauth-protected-resource/mcp`. Missing or invalid credentials receive a Bearer challenge referencing this endpoint.

## CORS

Browser access is disabled by default. `MCP_CORS_ORIGINS` accepts comma-separated exact HTTPS origins; HTTP is allowed only for localhost development. Wildcards, paths, query strings, fragments and credentials are rejected. Preflight requests are restricted to POST and the headers needed by the MCP HTTP client. No credentialed CORS access is enabled. Requests without an Origin header, including server-to-server clients, are unaffected.

## Security model

- Run as a dedicated unprivileged Linux account.
- Filesystem tools and command working directories are restricted to `MCP_ALLOWED_ROOTS`.
- Commands run as the service account, not root.
- Do not mount the Docker socket or add the service account to the Docker group; Docker access is effectively root access.
- Keep Node bound to loopback and expose it only through a TLS reverse proxy.
- Keep the allowed filesystem roots narrow. Authorized shell users can execute commands with the service account's OS permissions.

## Requirements

- Ubuntu 24.04 LTS or another supported Linux distribution
- Node.js 22 or newer installed at `/usr/bin/node`
- npm, systemd, curl, tar and OpenSSL
- Dedicated service account (created by the installer)

## Local development

```bash
cp .env.example .env
# Keep MCP_AUTH_MODE=token and set a random MCP_AUTH_TOKEN of at least 32 characters.
npm install
npm run typecheck
npm test
npm run build
```

Generate a token with `openssl rand -hex 32`.

## VPS installation

Run the installer from the checked-out repository on Ubuntu 24.04:

```bash
sudo ./deploy/install.sh
```

The installer:

1. Verifies root privileges, systemd and Node.js 22+.
2. Creates the unprivileged `vps-mcp` account and required directories.
3. Creates a root-owned, service-readable environment file with a cryptographically random bearer token if one does not already exist. It never prints the token.
4. Copies the application, installs dependencies and builds the TypeScript output as the service account.
5. Installs and enables the systemd service.
6. Verifies the local health endpoint and confirms unauthenticated MCP requests receive HTTP 401.

The installer does not change firewall rules, install a public reverse proxy, configure DNS or switch authentication to OAuth. It is safe to rerun for application updates; an existing environment file is preserved.

Environment file: `/etc/vps-mcp/vps-mcp.env` (mode 0640, owner root:vps-mcp). Service: `vps-mcp.service`. Application: `/opt/vps-mcp`. Data: `/var/lib/vps-mcp`.

### Public endpoint setup

1. Choose a hostname and point its DNS A/AAAA record to the VPS.
2. Install Caddy and adapt `deploy/Caddyfile.example` to the hostname.
3. Permit inbound TCP 80 and 443. Keep port 3000 closed to the public internet.
4. Verify HTTPS and the public `/healthz` endpoint.
5. Configure an OAuth provider that supports Authorization Code + PKCE S256, refresh tokens, JWT access tokens, resource/audience binding and the client registration method required by the MCP client.
6. Set `MCP_AUTH_MODE=oauth`, `MCP_PUBLIC_URL`, `OAUTH_ISSUER_URL`, `OAUTH_AUDIENCE` and optional `OAUTH_JWKS_URL` in the protected environment file. Restart the service.
7. Verify `/.well-known/oauth-protected-resource/mcp`, valid authentication, invalid/expired tokens, wrong issuer/audience and insufficient scopes.
8. Register the remote MCP endpoint in the intended client. Verify initialization, tool discovery, `system.health`, bounded filesystem access and a harmless command.

Do not expose the MCP endpoint publicly in static-token mode unless the integration's token handling and threat model explicitly require it. Prefer OAuth for a public remote endpoint.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `MCP_HOST` | `127.0.0.1` | Bind address |
| `MCP_PORT` | `3000` | HTTP port |
| `MCP_AUTH_MODE` | `token` | `token`, `oauth` or loopback-only `none` |
| `MCP_AUTH_TOKEN` | generated by installer | Static bearer token, minimum 32 characters |
| `MCP_PUBLIC_URL` | unset | Canonical HTTPS URL ending in `/mcp`, required for OAuth |
| `OAUTH_ISSUER_URL` | unset | HTTPS OAuth/OIDC issuer, required for OAuth |
| `OAUTH_AUDIENCE` | unset | HTTPS resource audience, required for OAuth |
| `OAUTH_JWKS_URL` | OIDC discovery | Optional explicit HTTPS signing-key URL |
| `OAUTH_REQUIRED_SCOPES` | `mcp` | Required scope tokens |
| `MCP_CORS_ORIGINS` | empty | Exact allowed browser origins |
| `MCP_ALLOWED_ROOTS` | `/srv,$HOME/.local/share/vps-mcp` | Allowed filesystem roots |
| `MCP_DATA_DIR` | `$HOME/.local/share/vps-mcp` | Persistent execution metadata and logs |
| `MCP_MAX_REQUEST_BYTES` | `2097152` | Maximum HTTP JSON request size |
| `MCP_DEFAULT_COMMAND_TIMEOUT_MS` | `30000` | Default command timeout |
| `MCP_MAX_COMMAND_TIMEOUT_MS` | `900000` | Maximum command timeout |
| `MCP_MAX_OUTPUT_BYTES` | `1048576` | Maximum synchronous command output |

## Known boundaries

- External OAuth provider selection and tenant-specific configuration remain deployment decisions.
- Only signed JWT access tokens are supported; opaque-token introspection is not implemented.
- Active background process supervision is not yet managed by a dedicated process supervisor.
- Privileged host administration requires a separately designed, narrowly scoped helper; unrestricted sudo is not supported.
- Git worktree orchestration, concurrency locks, backups, management UI and Railway Sandbox compatibility remain later milestones.

## Development checks

```bash
npm install
npm run typecheck
npm test
npm run build
```
