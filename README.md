# vps-mcp

An OAuth-protected remote Model Context Protocol (MCP) server for bootstrapping and operating a self-hosted development VPS. It provides system inspection, bounded filesystem access and synchronous/background command execution.

## Rootless container runtime readiness

The self-hosted sandbox runtime is gated on the rootless Podman feasibility decision. Read [the runtime architecture](docs/architecture/container-runtime.md), [host provisioning and acceptance](docs/operations/host-provisioning.md), and [ADR-0001](docs/adr/0001-rootless-container-runtime.md) before provisioning. The administrator provisioning step installs a read-only copy of the preflight at `/usr/local/libexec/vps-mcp/rootless-runtime-preflight.mjs`. The restricted `vps-sandboxctl` helper runs it as the dedicated `vps-sandbox` identity inside the documented transient systemd test unit. Do not run the feasibility test as `vps-mcp` or weaken the public `vps-mcp.service`. The administrator-only provisioning script is `scripts/provision-rootless-podman.sh`; it does not alter systemd hardening. A restricted root-owned diagnostic helper can expose only the fixed `preflight`, `info` and `smoke` checks to MCP through exact-argument sudoers rules. Install it with `sudo bash scripts/install-vps-sandboxctl.sh` after pulling the change. This is not a general privileged command interface and does not authorize production sandbox workloads.

## Current capabilities

| Tool | Purpose |
|---|---|
| `system.health` | Service and data-directory health |
| `system.info` | OS, CPU, memory, load, uptime and filesystem information |
| `runtime.acceptance` | Run fixed rootless runtime preflight, info or smoke checks through a restricted helper |
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
- `oauth`: requires a valid bearer token for every MCP HTTP request, including initialization and tool discovery. The server returns an HTTP 401 Bearer challenge pointing to its protected-resource metadata; signed access-token JWTs are checked for issuer, audience, expiry and any explicitly configured required scopes.
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

The WorkOS issuer for this staging environment is `https://stalwart-insight-17-staging.authkit.app`. Set `OAUTH_ISSUER_URL` to that exact issuer (without adding a trailing slash), and set both `MCP_PUBLIC_URL` and `OAUTH_AUDIENCE` to the exact resource indicator above.

See [AUTHKIT_SCOPES.md](./AUTHKIT_SCOPES.md) for the verified AuthKit scope set and the distinction between resource authentication and VPS tool authorization.

### ChatGPT client compatibility

Create and manage custom MCP server connections from **ChatGPT on the web**. The ChatGPT mobile apps do not currently support creating custom MCP server connections. Use the web app at `https://chatgpt.com` for connector setup and discovery tests.

When creating the connection, select **OAuth** authentication. Do not select **OAuth or no authentication**: that is ChatGPT's mixed-auth mode, which deliberately leaves `initialize` and `tools/list` unauthenticated and expects per-tool `securitySchemes`. This server uses server-level OAuth, so it challenges every MCP request, including initialization and tool discovery.

The MCP endpoint must be reachable from the public internet and present a publicly trusted TLS certificate. A Caddy local-CA certificate may be trusted by the VPS itself but is not trusted by remote clients. If using a bare IP address, explicitly provision and renew a publicly trusted IP-address certificate; Caddy's default local HTTPS behavior is not sufficient.

This repository includes an external smoke test that runs from GitHub-hosted infrastructure. It verifies TLS/network reachability, OAuth metadata, ChatGPT browser CORS, and server-level HTTP OAuth challenges on MCP initialization and tool discovery. Run it manually with:

```bash
MCP_URL=https://YOUR_PUBLIC_HOST/mcp npm run check:public
```

The same test runs on pull requests that change the smoke-test files and every six hours. A successful local request from the VPS alone does not prove that the endpoint is reachable by remote clients.

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

The resource metadata endpoint is `/.well-known/oauth-protected-resource/mcp`. In OAuth mode, every MCP HTTP request, including `initialize` and `tools/list`, is protected by the same HTTP authentication middleware. Missing credentials return HTTP 401 with a `WWW-Authenticate: Bearer` challenge containing the protected-resource metadata URL. Invalid or expired tokens are rejected before the MCP transport handles the request. Tools do not carry per-tool OAuth `securitySchemes`; authorization is applied at the server boundary, matching CR8OR's Laravel MCP integration. In static-token mode, the same HTTP boundary validates the configured bearer token. Configure the provider Resource Indicator to exactly match `MCP_PUBLIC_URL`; the issued access token must contain that value in `aud`. If required scopes are configured, the token must also contain them in `scope` or `scp`.

## CORS

Browser access is restricted to the official ChatGPT origins and any explicitly configured additional origins. `MCP_CORS_ORIGINS` accepts comma-separated exact HTTPS origins; HTTP is allowed only for localhost development. The official ChatGPT web origins (`https://chatgpt.com` and `https://chat.openai.com`) are always allowed because connector setup may perform OAuth discovery from the browser. CORS permits GET for discovery and POST for MCP requests. Wildcards, paths, query strings, fragments and credentials are rejected. Preflight requests are restricted to GET/POST and the headers needed by discovery and the MCP HTTP client. No credentialed CORS access is enabled. Requests without an Origin header, including server-to-server clients, are unaffected.

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
| `MCP_CORS_ORIGINS` | empty | Additional exact browser origins; official ChatGPT origins are built in |
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
- Privileged host administration is limited to the explicitly installed `vps-sandboxctl` diagnostic allowlist; unrestricted sudo is not supported. General sandbox lifecycle operations remain a later design decision.
- Git worktree orchestration, concurrency locks, backups, management UI and Railway Sandbox compatibility remain later milestones.

## Development checks

```bash
npm ci
npm run typecheck
npm test
npm run build
```
