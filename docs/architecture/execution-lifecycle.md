# Durable task execution lifecycle

## Scope

Background execution is available only inside a managed task sandbox. The host-level terminal.execute tool remains synchronous. The former host-level terminal.start, terminal.status, terminal.logs and terminal.cancel tools are retired; new background commands must use sandbox.execution.* and provide both the owning sandbox ID and, where applicable, the execution ID.

Task executions are distinct from persistent project-service health, logs, restart and deployment operations. Those remain owned by the project-environment lifecycle.

## Components and storage

The MCP server validates tool input and forwards an operation over the private runtime socket. The rootless runtime agent is authoritative for workload ownership, execution records, process identity, quotas and logs.

| Data | Host location | Container visibility |
|---|---|---|
| Workload record | /var/lib/vps-sandbox/workloads/<sandbox-id>/record.json | Not mounted |
| Execution metadata | /var/lib/vps-sandbox/executions/<sandbox-id>/<execution-id>/record.json | Not mounted |
| Execution logs and small runtime markers | /var/lib/vps-sandbox/execution-logs/<sandbox-id>/ | Mounted only into that task sandbox at /run/vps-mcp-executions |
| Task workspace | Registered worktree path | Mounted at /workspace with its configured access mode |

Metadata is written atomically with restrictive permissions. The execution log directory is created per sandbox and mounted only into that sandbox. No project-service workload receives this mount. The task process can see and modify its own log files, so log contents and in-container completion markers are treated as untrusted task output. The authoritative execution record remains outside the mount.

The execution mount is provisioned when a task sandbox is created. A sandbox created by an older runtime without this mount cannot start durable executions; recreate that task sandbox rather than trying to mutate its mounts.

## Execution identity and supervision

The runtime starts a detached wrapper inside the selected container. It creates a unique execution marker, a dedicated process session/group and a container-local identity tuple containing the wrapper PID, process-group ID and /proc start time. The host record also stores the immutable runtime container ID and execution UUID. No host PID is used as the execution identity.

The wrapper captures combined stdout/stderr into a per-execution FIFO and a host-backed log file. The reader consumes at most the configured limit plus one sentinel byte and runs under a file-size resource limit; the runtime trims the sentinel and records whether output was truncated. The log bind mount is isolated to the owning task container; the task process can modify only that sandbox’s own log files. This keeps the persisted log bounded without relying on the MCP request remaining connected.

A container-local watchdog enforces the execution timeout. It survives MCP and runtime-agent restarts because it is owned by the task container, not by the MCP process. It sends SIGTERM to the selected execution process group and escalates to SIGKILL after two seconds. The cancellation tool performs the same targeted signal sequence. Commands that deliberately daemonize outside their process group may not be individually cancellable, but sandbox stop/remove still terminates the entire task container and therefore all of its processes.

## State model

    [*] --> starting
    starting --> running: identity recorded
    starting --> completed: command exits quickly
    starting --> unknown: identity cannot be reconciled
    running --> completed: exit status recorded
    running --> cancelling: cancellation requested
    running --> timed_out: timeout watchdog fires
    cancelling --> cancelled: process group terminated
    cancelling --> unknown: termination cannot be confirmed
    running --> interrupted: sandbox stops or disappears
    unknown --> interrupted: owning sandbox is stopped
    completed --> [*]
    cancelled --> [*]
    timed_out --> [*]
    interrupted --> [*]

The persisted record includes:

- Execution UUID and owning sandbox UUID.
- Redacted executable summary, argument count and SHA-256 command fingerprint; raw arguments are never persisted.
- Workspace-relative working directory.
- Runtime container ID and container-local PID, process group, start time and unique marker.
- Creation, start, update and finish timestamps.
- Status, exit code when known, timeout and cancellation reason.
- Relative log filename, byte count, truncation state and retention deadlines.

If the runtime cannot prove that the recorded process is still present, it reports unknown or interrupted. It does not infer completion from a stale PID or reuse a host PID.

## Lifecycle coupling

- sandbox.stop first requests cancellation for active executions, then stops the selected task container. Any remaining execution records are finalized as interrupted only after the container stop succeeds.
- sandbox.remove follows the same rule before force-removing the selected task container.
- Execution records and logs remain readable after the task container is removed, subject to retention.
- Task workspace removal remains blocked while its sandbox exists. Removing a sandbox does not delete its worktree.
- No execution operation accepts a project-service workload. Task cancellation and cleanup cannot signal processes in another container or a persistent project service.

## Resource policy

The initial fixed policy is deliberately conservative:

| Limit | Policy |
|---|---:|
| Default timeout | 30 minutes |
| Maximum timeout | 24 hours |
| Per-execution log | 2 MiB |
| Per-sandbox retained logs | 32 MiB |
| Global retained logs | 512 MiB |
| Active executions per sandbox | 1 |
| Active executions globally | 8 |
| Log retention | 7 days after completion |
| Execution metadata retention | 30 days after completion |
| Cancellation grace period | 2 seconds before SIGKILL |

The runtime reserves the maximum per-execution log budget before starting a command. Starts are serialized while global and per-sandbox quotas are checked. Only one background execution is allowed per sandbox; synchronous sandbox.exec is rejected while it is active, avoiding process-group interference between commands. Expired records are pruned only after they are terminal; active or indeterminate records are not silently deleted.
