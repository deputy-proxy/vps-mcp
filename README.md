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
- `oauth`: validates signed OAuth access-token JWTs against the configured issuer and JWKS; checks issuer, audience, expiry and any explicitly configured required scopes; publishes RFC 9728 Protected Resource Metadata.
- `none`: permitted only when the listener binds to loopback.

This project is an OAuth protected resource, not an authorization server. The external provider must support Authorization Code + PKCE S256, refresh tokens, resource/audience binding, signed JWT access tokens, and client registration compatible with the intended MCP client (CIMD or DCR where required). Opaque-token introspection is not implemented.

### WorkOS AuthKit setup

WorkOS AuthKit is the configured authorization provider for this deployment.

1. In the WorkOS Dashboard, open **Connect → Configuration**.
2. Under **MCP Auth**, enable **Client ID Metadata Document (CIMD)** and save the change. DCR can remain enabled for backwards compatibility if the dashboard offers it.
3. Under **MCP resource indicators**, choose **Edit MCP resources**.
4. Add this exact resource indicator and save it: `https://194.163.133.147/mcp`.
5. Once the server is reachable over trusted HTTPS, set this resource indicator as the default if the client may omit the `resource` parameter.
6. Do not add a made-up `mcp` scope. WorkOS's documented AuthKit MCP flow binds the access token to the configured resource indicator through its `aud` claim. Its standard authorization-server metadata advertises OIDC scopes such as `openid`, `profile`, `email` and `offline_access`; this server therefore defaults to no additional required scope. Request `offline_access` when refresh tokens are needed.

The WorkOS issuer for this staging environment is `https://stalwart-insight-17-staging.authkit.app`. Set `OAUTH_ISSUER_URL` to that exact issuer (with the trailing slash as returned by discovery), and set both `MCP_PUBLIC_URL` and `OAUTH_AUDIENCE` to the exact resource indicator above.

### OAuth provider compatibility

Run the discovery preflight:

```bash
npm run check:oauth -- https://YOUR_AUTHKIT_ISSUER/
```

The checker validates issuer identity, HTTPS endpoints, JWKS availability, Authorization Code, PKCE S256, CIMD or DCR, and token endpoint authentication methods. It cannot verify dashboard configuration, consent, resource indicator settings, or the resulting access-token audience. Those require an interactive authorization test.

### OAuth configuration

- `MCP_PUBLIC_URL`: canonical HTTPS MCP endpoint, exactly `https://host/mcp`.
- `OAUTH_ISSUER_URL`: exact HTTPS issuer identifier from the provider.
- `OAUTH_AUDIENCE`: HTTPS resource identifier expected in the JWT audience claim.
- `OAUTH_JWKS_URL`: optional explicit HTTPS JWKS URL; otherwise read from OIDC discovery.
- `OAUTH_REQUIRED_SCOPES`: optional space- or comma-separated required scope tokens; defaults to none. Configure only scopes actually issued by the provider.

The discovery document issuer must exactly match `OAUTH_ISSUER_URL`; the discovered `jwks_uri` must use HTTPS. The first successful JWKS discovery is cached. Failed discovery returns 503.

The resource metadata endpoint is `/.well-known/oauth-protected-resource/mcp`. Missing or invalid credentials receive a Bearer challenge referencing this endpoint. Configure the provider Resource Indicator to exactly match `MCP_PUBLIC_URL`; the issued access token must contain that value in `aud`. If required scopes are configured, the token must also contain them in `scope` or `scp`.

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
- Node.js 22 or newer
- npm
- Dedicated service account

## Local development

```bash
cp .env.example .env
# Keep MCP_AUTH_MODE=token and set a random MCP_AUTH_TOKEN of at least 32 characters.
npm ci
npm run typecheck
npm test
npm run build
```

Generate a token with `openssl rand -hex 32`.

## VPS deployment

1. Create the service account and directories:

   ```bash
   sudo useradd --system --create-home --home-dir /var/lib/vps-mcp --shell /usr/sbin/nologin vps-mcp
   sudo install -d -o vps-mcp -g vps-mcp -m 0750 /opt/vps-mcp /srv /var/lib/vps-mcp
   sudo install -d -o root -g vps-mcp -m 0750 /etc/vps-mcp
   ```

2. Clone the repository, install locked dependencies and build:

   ```bash
   sudo git clone https://github.com/deputy-proxy/vps-mcp.git /opt/vps-mcp
   sudo chown -R vps-mcp:vps-mcp /opt/vps-mcp
   sudo -u vps-mcp npm ci --prefix /opt/vps-mcp
   sudo -u vps-mcp npm run build --prefix /opt/vps-mcp
   ```

3. Create `/etc/vps-mcp/vps-mcp.env` with mode 0640, owned by root:vps-mcp. Keep token mode until a real OAuth provider and public endpoint are configured. Never commit secrets.

4. Install `systemd/vps-mcp.service`, reload systemd, enable and start the service. Verify `curl http://127.0.0.1:3000/healthz` and confirm unauthenticated POST requests to `/mcp` return 401.

5. Configure HTTPS for the public endpoint. For an IP-address URL, use a publicly trusted IP certificate with automated renewal and a deploy hook that reloads the reverse proxy after renewal. Do not assume a standard hostname-based Caddy example will issue an IP certificate automatically. Keep Node bound to loopback and allow inbound TCP 80/443 only; keep port 3000 closed publicly.

6. Configure the OAuth provider and exact resource/audience values, then switch to OAuth mode. Validate metadata, successful authentication, invalid/expired tokens and wrong issuer/audience before registering the MCP client.

7. Connect the intended MCP client and verify initialization, tool discovery, `system.health`, bounded filesystem access and a harmless command. Do not expose the service until all checks pass.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `MCP_HOST` | `127.0.0.1` | Bind address |
| `MCP_PORT` | `3000` | HTTP port |
| `MCP_AUTH_MODE` | `token` | `token`, `oauth` or loopback-only `none` |
| `MCP_AUTH_TOKEN` | required in token mode | Static bearer token, minimum 32 characters |
| `MCP_PUBLIC_URL` | unset | Canonical HTTPS URL ending in `/mcp`, required for OAuth |
| `OAUTH_ISSUER_URL` | unset | HTTPS OAuth/OIDC issuer, required for OAuth |
| `OAUTH_AUDIENCE` | unset | HTTPS resource audience, required for OAuth |
| `OAUTH_JWKS_URL` | OIDC discovery | Optional explicit HTTPS signing-key URL |
| `OAUTH_REQUIRED_SCOPES` | empty | Optional required scope tokens |
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
npm ci
npm run typecheck
npm test
npm run build
```
