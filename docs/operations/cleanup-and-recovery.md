# Cleanup and recovery

## Cleanup policy

Automatic cleanup is disabled by default. Enable it only after reviewing retention and confirming backups/retention expectations:

```ini
VPS_SANDBOX_CLEANUP_ENABLED=true
VPS_SANDBOX_TASK_RETENTION_MS=604800000
```

The runtime safety loop runs every five minutes. Expired-container cleanup is opt-in: when enabled, it removes only task containers older than the configured retention period, with terminal executions and a terminal runtime state. It also reports and can remove orphaned managed task containers when their workload record confirms removal, or when they are terminal and older than the retention period. Running/unknown orphan containers and all project-service containers are protected. The `task-workspace.retain` and `task-workspace.resume` operations synchronize the retained flag with the attached sandbox record, so a retained worktree also protects its stopped sandbox from automatic cleanup. Stale lock directories and recognized atomic-write temporary files older than `VPS_SANDBOX_TEMP_FILE_RETENTION_MS` (ten minutes by default) are reaped automatically even when expired-container cleanup is disabled; emergency pause suspends that housekeeping.

Cleanup removes only the container. It retains the Git worktree, its files, task workspace registry entry, execution records and logs. This is deliberate: the runtime agent does not own Git worktree retention or dirty-work decisions.

## Operator workflow

1. Call `sandbox.cleanup.preview` and inspect both `candidates` and `skipped`.
2. Confirm that candidates are expired task containers and not needed for a running workflow.
3. Call `sandbox.cleanup.run` with `dryRun=false` and `confirm=true` to remove eligible containers.
4. Inspect `sandbox.list`, `task-workspace.list` and `sandbox.audit.list` after cleanup.

The default `sandbox.cleanup.run` request is a dry run. Its report includes expired task containers, orphan-container inventory, stale locks and eligible temporary files. Actual cleanup requires explicit confirmation. The operation acquires a global cleanup lock and per-workload locks, then rechecks eligibility immediately before removal. It never removes worktrees or their contents.

## Emergency pause

During an incident, call `sandbox.maintenance.pause` with `paused=true`. The runtime blocks new sandbox creation/start, task command execution and workspace writes. Existing workloads can still be stopped or removed. Automatic container cleanup and stale-lock/temp-file housekeeping pause too, preserving state for investigation. Disk-pressure and per-workspace quota enforcement remain active as safety controls. The pause is stored outside the MCP process and survives service restarts.

Resume with `paused=false` only after the incident is resolved. Both transitions are recorded in the private audit log.

## Disk pressure

`resource.capacity` reports free disk and the Podman storage breakdown. Warning and critical thresholds are configurable through `VPS_SANDBOX_DISK_WARNING_BYTES` and `VPS_SANDBOX_DISK_RESERVE_BYTES`. New allocations are denied when free space would cross the reserved margin. At the critical threshold, the watchdog stops task containers first, preserving persistent project services and all worktree files.

Task workspaces have a disk budget. The five-minute watchdog measures regular files without following symlinks. When a task exceeds its limit, the runtime stops that task container and interrupts its active executions, but leaves the worktree and all files untouched. This watchdog is not an instantaneous hard filesystem quota. Do not represent it as protection against every transient write burst.

Do not automatically prune Podman images, repository caches, project databases, persistent project storage, worktrees or logs as part of task cleanup. Those resources require their own ownership, backup and retention policies. Image/cache pruning remains an explicit operator action after capacity inspection.

## Recovery and audit

Durable lock owner identity includes PID and process start time, preventing a reused PID from being mistaken for the original owner. A lock with a live owner is never reaped solely due to age. If an operation is interrupted, inspect the workload and runtime state before retrying; do not delete unexplained records or containers.

Synchronous `sandbox.exec` operations persist bounded, redacted results (up to 50 records per sandbox) keyed by `operationId`; a retry with the same ID replays the result, a changed command is rejected, and an interrupted operation is marked `unknown` so it is not accidentally run twice. Background `sandbox.execution.start` accepts a stable `executionId` and returns the existing execution on retry. Recent audit events are available through `sandbox.audit.list`. The log is private to the runtime identity, bounded/rotated, and redacts common credential patterns. It records lifecycle actions, reservation changes, cleanup outcomes, disk quota stops, emergency pause transitions and policy denials. It does not store command argument arrays or environment values.

For a runtime outage, disable the socket only through the documented host maintenance procedure. Preserve `/var/lib/vps-sandbox/workloads`, `/var/lib/vps-sandbox/executions`, `/var/lib/vps-sandbox/execution-logs`, `/var/lib/vps-sandbox/operations`, `/var/lib/vps-sandbox/reservations`, `/var/lib/vps-sandbox/audit` and the rootless Podman storage until recovery is complete.
