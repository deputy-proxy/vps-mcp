# Resource governance

## Capacity model

The runtime agent reserves host headroom and admits workloads only when the requested CPU, memory, PID and disk reservations fit both the global budget and the repository budget.

The configured defaults are intentionally conservative:

- CPU: 70% of detected logical CPU capacity.
- Memory: 70% of detected host memory.
- PIDs: 2,048 globally.
- Active task containers: 8 globally.
- Per-repository CPU, memory and PID budgets: the global limits unless explicitly lowered.
- Per-repository disk reservation: 100 GiB.
- Global disk reservation: 150 GiB.
- Disk warning threshold: 15 GiB free.
- Disk critical/reserved headroom: 5 GiB free. The warning threshold must be strictly greater than the critical reserve threshold.
- Task workspace hard quota: 2 GiB per task worktree.

The budget is configurable through `/etc/vps-sandbox/runtime.env`, which is read by the rootless runtime systemd service. The installer seeds values for new installations and preserves an existing file. Blank CPU, memory and per-repository overrides use the calculated defaults. See docs/operations/vps-sandbox-runtime.env.example.

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
| `VPS_SANDBOX_TASK_DISK_MIB` | Hard task workspace quota | 2048 |

The MCP API cannot set Podman flags or raise configured ceilings. A reservation that would overcommit a budget fails with `SANDBOX_CAPACITY_EXCEEDED`; a disk safety-margin violation fails with `SANDBOX_DISK_PRESSURE`.

## Persistent project reservations

Before a persistent development environment is provisioned, its manager must call `resource.reserve` with the registered repository ID and planned resource vector:

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

The operation is idempotent per repository and replaces that repository's prior reservation only after the new request passes admission checks.

`resource.release` marks the reservation released. It must be called only after deprovisioning the associated project environment.

When a project-service workload becomes active, its live resource vector replaces its reservation in capacity accounting to avoid double-counting.

## Task workspace hard quotas

Task workspace disk enforcement uses ext4 project quotas, not only periodic measurement.

Before a task container is created, the runtime asks the root-owned quota broker to apply a hard block limit to the exact managed worktree. The broker accepts only a repository ID, worktree UUID and bounded disk budget. It derives the path from approved workspace roots and the quota registry; it does not accept arbitrary paths or shell commands.

The helper:

1. Verifies that the managed workspace is on the supported ext4 filesystem.
2. Verifies the ext4 project feature and active `prjquota`/`pquota` mount option.
3. Resolves the actual backing filesystem, including bind-mounted worktree roots.
4. Assigns a deterministic project ID to the worktree.
5. Enables project inheritance on its directories.
6. Applies the hard block quota.

Provisioning is deliberately separate from runtime installation. The provisioning script does not automatically remount or mutate a live root filesystem. Filesystem feature or mount-option changes require a reviewed maintenance window.

Host provisioning procedure:

1) Confirm that the task-worktree filesystem is ext4 and has the ext4 project feature.
2) During a reviewed maintenance window, enable the prjquota mount option where required.
3) Run sudo bash scripts/provision-vps-sandbox-quotas.sh.
4) Run sudo bash scripts/install-vps-sandbox-runtime.sh to install and activate the restricted quota socket broker.
5) Verify that a disposable task worktree reports an enforced project quota before enabling ordinary task creation.


If project quotas are unavailable or the broker cannot apply the requested quota, task creation fails closed with `SANDBOX_DISK_QUOTA_UNAVAILABLE`. The runtime must not silently fall back to periodic-only enforcement.

The five-minute workspace watchdog remains defense in depth. It measures workspace usage and can stop an over-budget task, but it is not the primary hard-limit mechanism.

The project quota applies to the managed task worktree. It does not individually cap Podman image storage, container layers, repository caches, execution logs, audit records or persistent project data. Those categories require separate monitoring and capacity policies.

## Monitoring

Call `resource.capacity` or `resource.inspect` to inspect configured budgets, current active workload reservations, project reservations, Podman storage accounting and free disk.

The runtime reports:

- CPU, memory and PID reservations.
- Active task and project-service counts.
- Global and per-repository disk budgets.
- Filesystem capacity and free-space pressure.
- Podman images, containers and local volumes.
- Execution logs and records.
- Operation records and audit data.
- Registered task worktree storage.
- Scan warnings.

Disk level is `normal`, `warning` or `critical`. New workload creation is denied when it would cross the critical free-space reserve.

When free space falls below the critical reserve, the watchdog stops running task containers first and leaves persistent project services untouched. Operators must investigate and reclaim storage before resuming tasks.

Do not automatically prune Podman images, repository caches, project databases, persistent project storage, worktrees or logs as part of task cleanup. Those resources require their own ownership, backup and retention policies. Image/cache pruning remains an explicit operator action after capacity inspection.

## Concurrency and locks

Mutating operations acquire durable locks for the global resource pool, repository, worktree or workload as applicable. Multiple lock keys are acquired in sorted order.

Lock owner records contain PID, process start time and a random ownership token. A lock is not reclaimed merely because it is old: the recorded process must be proven dead or its PID must have been reused. An incomplete owner record is eligible for reclamation only after the configured stale-lock grace period.

Lock acquisition has a bounded timeout and returns `SANDBOX_BUSY` on contention timeout.

Defaults:

- `VPS_SANDBOX_LOCK_TIMEOUT_MS=180000`
- `VPS_SANDBOX_STALE_LOCK_MS=60000`

Lifecycle operations persist durable operation records. Retries must preserve operation identity and arguments. At runtime startup, interrupted operations previously recorded as running are changed to `unknown` with a recovery reason. They are retained for inspection rather than blindly replayed.

## Network defaults


Install the restricted egress configuration after reviewing the approved domains:

sudo bash scripts/install-vps-sandbox-egress.sh

The administrator-maintained exact-hostname allowlist is /etc/vps-sandbox/egress/allowed-domains.txt. Add only reviewed exact hostnames. Wildcard suffix entries are not supported.

Task sandboxes use the restricted task egress profile:

- Rootless `slirp4netns` networking.
- Explicit HTTP/HTTPS proxy variables.
- Host nftables enforcement that blocks direct outbound sockets from the `vps-sandbox` identity.
- Squid exact-hostname allowlisting and private/link-local/metadata destination denial.
- Upstream TCP restricted to ports 80 and 443.

The proxy and firewall are required dependencies of the task runtime profile. If either is unavailable, the runtime must fail closed.

Project-service workloads remain on `network=none` until the private project-network and authenticated proxy design is implemented. Task egress permissions must not be reused for project services.

See [the container security policy](../architecture/container-security.md) and [the VPS-MCP threat model](../security/threat-model.md).

## Emergency pause

Use `sandbox.maintenance.pause` with `paused=true` to block new workload creation/start, workspace writes and command execution.

Stop/remove remain available so operators can contain an incident. The pause also suspends automatic cleanup housekeeping, while disk-pressure and workspace-quota enforcement remain active. The pause state is durable across runtime-agent restarts.

Set `paused=false` only after the incident is resolved.

## Validation and operational evidence

Record the following for a deployment or material policy change:

- `npm run typecheck`
- `npm test`
- `npm run build`
- Relevant CI workflow results
- `systemd-analyze verify` for changed units
- `git diff --check`
- Effective systemd properties and service/socket state
- `resource.inspect` output
- Project quota configuration and a controlled over-limit write test
- Allowed and denied egress tests, including direct-egress bypass attempts
- Cleanup preview and, where applicable, controlled cleanup tests
- Concurrency and resource-pressure test results

Do not claim hard quota enforcement solely because the quota is configured. Record a controlled over-limit write that demonstrates the expected filesystem failure. Likewise, do not claim production-scale concurrency or disk-pressure acceptance without exercising those conditions.

For the VPS-07 implementation, the live inspection confirmed zero active workloads, populated Podman storage reporting and no scan warnings. The host proxy allowed the npm registry and denied a non-allowlisted host and private destination. Direct egress attempts were blocked. A controlled hard-quota overflow and sustained concurrency/disk-pressure stress tests remain separate acceptance evidence.
