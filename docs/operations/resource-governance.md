# Resource governance

## Capacity model

The runtime agent reserves host headroom and admits workloads only when the requested CPU, memory, PID and disk reservations fit both the global budget and the repository budget. Defaults are intentionally conservative:

- CPU: 70% of detected logical CPU capacity.
- Memory: 70% of detected host memory.
- PIDs: 2,048 globally.
- Active task containers: 8 globally.
- Per-repository CPU, memory and PID budgets: the global limits unless explicitly lowered.
- Per-repository disk reservation: 100 GiB.
- Global disk reservation: 150 GiB.
- Disk warning threshold: 15 GiB free.
- Disk critical/reserved headroom: 5 GiB free.
- Task workspace disk budget: 2 GiB per task container.

The budget is configurable through `/etc/vps-sandbox/runtime.env`, which is read by the rootless runtime systemd service. The installer seeds these values for new installations and preserves an existing file. Blank CPU/memory/per-repository overrides use the calculated defaults. See [the runtime environment example](vps-sandbox-runtime.env.example).

| Variable | Purpose | Default |
|---|---|---:|
| `VPS_SANDBOX_GLOBAL_CPU_MILLI` | Global CPU reservation in millicores | 70% of logical CPU capacity |
| `VPS_SANDBOX_GLOBAL_MEMORY_MIB` | Global memory reservation | 70% of detected memory |
| `VPS_SANDBOX_GLOBAL_PIDS` | Global PID reservation | 2048 |
| `VPS_SANDBOX_GLOBAL_DISK_MIB` | Global disk reservation | 153600 |
| `VPS_SANDBOX_MAX_ACTIVE_TASKS` | Active task-container cap | 8 |
| `VPS_SANDBOX_REPOSITORY_CPU_MILLI` | Per-repository CPU reservation | Global CPU budget |
| `VPS_SANDBOX_REPOSITORY_MEMORY_MIB` | Per-repository memory reservation | Global memory budget |
| `VPS_SANDBOX_REPOSITORY_PIDS` | Per-repository PID reservation | Global PID budget |
| `VPS_SANDBOX_REPOSITORY_DISK_MIB` | Per-repository disk reservation | 102400 |
| `VPS_SANDBOX_DISK_WARNING_BYTES` | Disk warning threshold | 16106127360 |
| `VPS_SANDBOX_DISK_RESERVE_BYTES` | Minimum free-disk safety margin | 5368709120 |

The MCP API cannot set Podman flags or raise the configured ceilings. A reservation that would overcommit a budget fails with `SANDBOX_CAPACITY_EXCEEDED`; a disk safety-margin violation fails with `SANDBOX_DISK_PRESSURE`.

## Persistent project reservations

Before #42 provisions a persistent development environment, it must call `resource.reserve` with the registered repository ID and its planned resource vector:

```json
{
  "repositoryId": "deputy-proxy-easyenglish-ro-91b8c1e506",
  "resources": {
    "cpuMilli": 500,
    "memoryMiB": 1024,
    "pids": 128,
    "diskMiB": 10240
  }
}
```

The operation is idempotent per repository and replaces that repository's prior reservation only after the new request passes admission checks. `resource.release` marks the reservation released; it must be called only after deprovisioning the associated project environment. When a project-service workload becomes active, its live resource vector replaces the reservation in capacity accounting to avoid double-counting.

## Monitoring

Call `resource.capacity` to inspect configured budgets, current active workload reservations, project reservations, Podman storage accounting and free disk. Disk level is `normal`, `warning` or `critical`. New workload creation is denied when it would cross the critical free-space reserve. When free space falls below that reserve, the watchdog stops running task containers first and leaves persistent project services untouched; operators must investigate and reclaim storage before resuming tasks.

Workspace disk limits are checked by the runtime watchdog. A task container that exceeds its configured workspace disk budget is stopped, active executions are marked interrupted and the workspace contents are retained. The watchdog scans every five minutes. This is a fail-safe workload stop, not a strict block-level filesystem quota; a task may temporarily exceed its threshold between scans. A quota-capable filesystem and separately reviewed host provisioning are required for hard per-directory enforcement.

## Concurrency and locks

Mutating operations acquire durable locks for the global resource pool, repository, worktree or workload as applicable. Multiple lock keys are acquired in sorted order. Lock owner records contain PID, process start time and a random ownership token. A lock is not reclaimed merely because it is old: the recorded process must be proven dead or its PID must have been reused. An incomplete owner record is eligible for reclamation only after the configured stale-lock grace period. Lock acquisition has a bounded timeout and returns `SANDBOX_BUSY` on contention timeout.

Defaults:

- `VPS_SANDBOX_LOCK_TIMEOUT_MS=180000`
- `VPS_SANDBOX_STALE_LOCK_MS=60000`

## Network defaults

Task sandboxes use `network=none`. Project-service workloads also remain fail-closed with no egress until the private project-network and authenticated proxy design in #42/#43 is implemented. This prevents host, private-network and metadata-service access, but package installation and application dependencies that require network access must use preloaded caches until an approved egress profile exists.

## Emergency pause

Use `sandbox.maintenance.pause` with `paused=true` to block new workload creation/start, workspace writes and command execution. Stop/remove remain available so operators can contain an incident. The pause does not kill work already admitted before the pause transition. It also suspends automatic cleanup housekeeping, while disk-pressure and workspace-quota enforcement remain active. The pause state is durable across runtime-agent restarts. Set `paused=false` after the incident is resolved.

## Strict task workspace quotas

Task creation now requires a hard ext4 project quota to be applied to its exact managed worktree before Podman creates the container. The root-owned quota broker accepts only a repository ID, worktree UUID and bounded disk budget; it does not accept arbitrary paths or shell commands. The helper assigns a deterministic project ID, enables project inheritance on every existing directory in the worktree and applies the hard block limit with setquota. The five-minute watchdog remains as a secondary containment check.

Provisioning is deliberately separate from runtime installation:

1. Confirm the task-worktree filesystem is ext4 and has the ext4 project feature.
2. During a reviewed maintenance window, enable the prjquota mount option on the filesystem. The provisioning script refuses to remount or mutate a live root filesystem automatically.
3. Run sudo bash scripts/provision-vps-sandbox-quotas.sh.
4. Run sudo bash scripts/install-vps-sandbox-runtime.sh to install and activate the restricted quota socket broker.
5. Verify a disposable task worktree reports an enforced project quota before enabling ordinary task creation.

If project quotas are not active, task creation fails closed with SANDBOX_DISK_QUOTA_UNAVAILABLE; it does not silently fall back to periodic-only enforcement.

## Restricted task egress

Task sandboxes can use a restricted HTTP CONNECT proxy for dependency registries. The installer provisions Squid under a dedicated vps-egress identity and an nftables output policy that permits the rootless vps-sandbox identity to open host sockets only to the loopback proxy. The proxy allows only the administrator-maintained exact-hostname allowlist, denies private, loopback, link-local and metadata destinations after DNS resolution, and permits only TCP 80/443 upstream. The firewall separately prevents the proxy identity from connecting to local/private destinations or arbitrary ports. Project-service containers remain on network=none.

Install only after reviewing the allowed domains with sudo bash scripts/install-vps-sandbox-egress.sh.

The installer enables the firewall before the proxy, adds a systemd dependency from the runtime agent to both services, then enables the restricted task profile. If the proxy or firewall is unavailable, the runtime agent does not start with the egress profile. Existing task network modes are immutable; recreate task sandboxes to adopt the new profile. Add exact hostnames as anchored regular expressions to /etc/vps-sandbox/egress/allowed-domains.txt after security review. Wildcard suffix entries are intentionally not supported.
