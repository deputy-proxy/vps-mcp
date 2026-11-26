# VPS and sandbox observability dashboard

The dashboard is a read-only operator view served by the existing VPS-MCP Express application.

- URL: https://<public-vps-mcp-origin>/dashboard
- API: /dashboard/api/overview, /dashboard/api/history, and /dashboard/api/sandboxes/:id
- Refresh: 15 seconds in the browser; current snapshot cache is 15 seconds.
- History: bounded in-memory host and per-sandbox samples, retained for up to 30 minutes.
- No database, persistent metrics store, separate agent, or monitoring platform is introduced.

## Authentication setup

The dashboard uses the same configured AuthKit/OIDC issuer as the MCP resource server, but it has a separate browser login and session boundary. MCP bearer tokens are never exposed to the dashboard or browser JavaScript.

Register a confidential first-party application in the existing WorkOS AuthKit environment and configure:

- Authorization Code flow.
- PKCE with S256.
- Exact redirect URI: https://<public-vps-mcp-origin>/dashboard/auth/callback.
- OIDC scopes: openid profile email.
- Token endpoint client authentication: client_secret_basic is preferred; client_secret_post is used only if the provider advertises it as the supported confidential-client method.

Set these server-side variables:

| Variable | Purpose |
|---|---|
| OAUTH_ISSUER_URL | Existing exact AuthKit issuer URL. Required for dashboard OIDC even if MCP itself uses static-token authentication. |
| DASHBOARD_OIDC_CLIENT_ID | Confidential dashboard application client ID. |
| DASHBOARD_OIDC_CLIENT_SECRET | Confidential dashboard application secret. Never expose to browser code or commit it. |
| DASHBOARD_OIDC_REDIRECT_URI | Exact public HTTPS callback URL ending in /dashboard/auth/callback. |
| DASHBOARD_ALLOWED_EMAILS | Comma-separated exact email allowlist. Only verified email claims are accepted. |
| DASHBOARD_SESSION_TTL_SECONDS | Optional maximum session lifetime; defaults to 28,800 seconds and cannot exceed 86,400 seconds. |

If any dashboard authentication variable is configured, all required variables must be present. Invalid or incomplete configuration prevents the application from starting. If no dashboard authentication variables are configured, /dashboard returns HTTP 503 rather than exposing an unauthenticated interface.

The callback validates provider discovery issuer, HTTPS endpoints, authorization state, PKCE, ID-token signature, issuer, audience, expiry, nonce, verified email and the configured email allowlist. Authorization state is bound to a short-lived HttpOnly browser cookie, is single-use and expires after five minutes.

The browser receives only a random opaque session identifier in an HttpOnly, SameSite=Lax cookie. HTTPS deployments use a __Host- cookie with Secure and Path=/. Session records are held in process memory; restarting the service invalidates dashboard sessions. This implementation requires one application process; do not run multiple replicas without introducing a shared session/state store. The session lifetime is capped by the ID-token expiry. No access token, refresh token, ID token or client secret is stored in browser storage. Dashboard logout clears only the local dashboard session and does not terminate the WorkOS SSO session.

## Read-only boundary

Every dashboard page, asset and data endpoint requires a valid dashboard session. The dashboard exposes no sandbox lifecycle, workspace mutation, repository mutation, cleanup, maintenance-pause or host-administration action.

The runtime integration uses the dedicated dashboard.inventory operation. It reads the durable workload registry, Podman inventory and cgroup v2 counters. It does not use the existing container.list reconciliation path because that operation may update workload records.

The runtime agent must be updated to a version containing dashboard.inventory before live sandbox metrics become available. Until that runtime-agent version is installed, the dashboard reports runtime inventory as unavailable; it does not fall back to a mutating operation.

## Metric definitions and limitations

### Host

- CPU: host-wide utilization calculated from deltas in os.cpus() counters. The first sample is shown as warming up.
- Memory: operating-system total, used and available memory.
- Data filesystem: statfs() for MCP_DATA_DIR. This is the filesystem containing VPS-MCP managed data, not a claim about every mounted volume.
- Load average: operating-system 1, 5 and 15-minute load averages.
- Uptime: host uptime.

### Sandboxes

- Runtime state and identity: durable workload records matched to the read-only Podman inventory. Container uptime is based on the runtime State.StartedAt timestamp, normalized from Podman’s Go timestamp format; creation time is not used as a substitute.
- Repository and worktree: managed repository and task-workspace registries. Repository metadata is read through a dedicated no-migration API; an older registry schema is reported unavailable rather than migrated by a dashboard read.
- Branch and commit: local Git metadata read from the registered worktree.
- Working-tree state: git status --porcelain for the registered worktree.
- CPU: cgroup v2 cpu.stat deltas. Both host-wide percentage and percentage of the effective cgroup CPU quota are calculated. The quota percentage is only available when the effective cpu.max quota is known.
- Memory: cgroup v2 memory.current and memory.max; configured workload memory is shown separately when useful.
- PIDs: cgroup v2 pids.current and pids.max; configured PID limit is shown separately.
- Workspace disk: bounded recursive sum of regular-file sizes within the verified managed worktree. Symlinks are excluded; scanning stops after 20,000 entries or two seconds and is labelled partial rather than presented as complete.
- Network RX/TX: cumulative receive/transmit bytes read from the running container process network namespace in /proc/<pid>/net/dev. Loopback is excluded. If the namespace counters cannot be read, the metric is unavailable rather than zero.

Unavailable or unsupported metrics remain unavailable. They are never represented as zero. Workspace scans are bounded and explicitly report partial results. The detail panel shows the runtime sample time and metric availability; missing network or workspace metrics are also surfaced as dashboard warnings. A failure for one container does not suppress metrics for other containers.

## Refresh, cache and history

The browser refreshes every 15 seconds and supports manual refresh. The server keeps a disposable 15-second snapshot cache and a bounded rolling history of up to 121 samples per series for a 30-minute window. Concurrent refreshes share one in-flight collection. Git metadata inspection is limited to 32 worktrees per snapshot, prioritizes running/recent workloads, and runs at a maximum concurrency of four. Cache/history state is process-local and is discarded on restart.

## Troubleshooting

- Dashboard returns 503: verify all dashboard OIDC variables are configured together and that OAUTH_ISSUER_URL is the exact HTTPS issuer.
- Sign-in fails: verify the registered callback URL exactly matches DASHBOARD_OIDC_REDIRECT_URI, the client secret is current, PKCE S256 is enabled, and the ID token contains a verified email in DASHBOARD_ALLOWED_EMAILS.
- Runtime inventory unavailable: verify the installed /usr/local/libexec/vps-mcp/vps-sandbox-runtime.mjs includes dashboard.inventory, and that the runtime socket/service is healthy.
- CPU or memory unavailable for one sandbox: inspect that container's cgroup v2 path and read permissions under /sys/fs/cgroup; container exit/removal races are expected to produce unavailable metrics for that sample.
- Network counters unavailable: verify the runtime agent can read /proc/<container-pid>/net/dev for the running task container.
- Workspace disk is partial: the scan reached its 20,000-entry or two-second safety bound; the displayed value is a lower bound for that sample.
- Repository or branch unknown: verify the workload's repository/worktree association and that the registered worktree still exists.
- Disk unavailable: verify that MCP_DATA_DIR exists and the service account can call statfs() on it.

## Validation and rollback

Run:

    npm ci
    npm run typecheck
    npm test
    npm run build
    node --check public/dashboard.js
    node --check scripts/vps-sandbox-runtime.mjs
    git diff --check

For live verification, compare host values with the operating system and per-container cgroup values with the corresponding rootless Podman container's cgroup v2 files. Exercise multiple workloads, stopped workloads, dirty worktrees and a transiently missing container. Do not use production services for destructive or experimental tests.

The dashboard is read-only. Rolling back the application removes the dashboard routes without changing workloads, worktrees or repositories. If the runtime agent is rolled back independently, the dashboard will report runtime metrics as unavailable; existing MCP operations remain separate.
