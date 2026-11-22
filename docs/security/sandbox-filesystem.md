# Task sandbox execution and filesystem boundary

## Tool inventory

Task tools are separate from host administration tools. Every task operation requires the UUID `sandboxId` returned by the sandbox lifecycle manager. The ID identifies a managed workload record; callers cannot supply a raw container ID, host path, mount path, Podman flag, or runtime socket path.

| Tool | Required inputs | Behavior |
|---|---|---|
| `sandbox.exec` | `sandboxId`, `command` (argument array) | Runs synchronously in the selected running task container. Optional `cwd` is relative to `/workspace`; `timeoutMs` is 1-120 seconds; `maxOutputBytes` is 1 KiB-1 MiB; `env` accepts only `LANG`, `LC_ALL`, `TZ`, `CI`, `NODE_ENV`, and `TERM`. |
| `sandbox.filesystem.list` | `sandboxId`, optional `path` | Lists immediate regular files and directories in the assigned workspace. Symlinks and special files are omitted. |
| `sandbox.filesystem.read` | `sandboxId`, `path` | Reads a UTF-8 regular file up to 2 MiB. |
| `sandbox.filesystem.write` | `sandboxId`, `path`, `content` | Atomically creates or replaces a UTF-8 regular file up to 1 MiB. Parent directories must already exist. |
| `sandbox.execution.start` | `sandboxId`, argv `command`, optional workspace-relative `cwd` and `timeoutMs` | Starts a durable background command in that running task container. Default timeout is 30 minutes; maximum is 24 hours. |
| `sandbox.execution.list` | `sandboxId` | Lists recent execution records for that task sandbox only. |
| `sandbox.execution.status` | `sandboxId`, `executionId` | Reconciles status using the persisted record and container-local process identity. |
| `sandbox.execution.logs` | `sandboxId`, `executionId`, optional `offset` and `maxBytes` | Reads bounded persistent combined stdout/stderr with tail and incremental offset support. |
| `sandbox.execution.cancel` | `sandboxId`, `executionId` | Sends SIGTERM to only the selected execution process group, then SIGKILL after two seconds if needed. |

All filesystem paths are relative to the task workspace. Absolute paths, empty path components, `.` and `..` components, backslashes, special files, and paths resolving outside the workspace are rejected. Directory symlinks are resolved and accepted only when their canonical target remains inside the workspace; final-file symlinks are rejected, and symlink entries are omitted from listings. Reads and writes operate inside the selected container using its `/workspace` mount. Writes use a temporary file in the same directory followed by rename and are denied when the workload mount is read-only. No task filesystem tool can address another sandbox by supplying a host path.

## Trust boundaries

- **Host administration:** `terminal.execute` and `filesystem.*` remain host-level tools restricted by `MCP_ALLOWED_ROOTS`. Host command execution is synchronous; the former host-level background execution tools have been removed.
- **Task sandbox:** `sandbox.*` accepts only a managed task workload ID. The runtime agent loads its persisted workload record, requires `workloadType=task`, requires a running container and the managed `/workspace` mount, and checks that the host workspace path matches the registered repository/worktree identity and administrator-configured workspace root. Runtime-unavailable or invalid IDs fail closed; there is no host fallback.
- **Project service:** Project-service workloads are explicitly rejected by task tools. Task workloads receive their individual task worktree mount and their own per-sandbox execution-log mount. Project-service mounts, databases, storage, deployment credentials and secrets are not exposed through these tools; project-service workloads receive no task execution-log mount.

The runtime agent runs as the dedicated unprivileged `vps-sandbox` identity under its hardened systemd unit. Durable execution metadata is stored under `/var/lib/vps-sandbox/executions`; logs are stored under `/var/lib/vps-sandbox/execution-logs` and bind-mounted only into their owning task sandbox at `/run/vps-mcp-executions`. Its filesystem access to worktrees is granted per managed worktree. The task tools use the workspace path from the runtime record, never a caller-supplied host path. Synchronous sandbox.exec commands are passed as argv arrays to Podman exec; the in-container wrapper validates the working directory and executes the selected program without shell expansion. Durable sandbox.execution.start commands use a separate container-local supervisor, process identity marker, bounded log FIFO and timeout watchdog. The task can modify its own log mount, so the host-side execution record is authoritative and container-side markers are treated as untrusted evidence. If a caller intentionally supplies sh -c, that nested shell remains inside the selected container. The approved task image must provide `sh`, `setsid`, `env`, `head`, `mkfifo`, `awk`, `sed`, `grep`, `tr` and `sleep`, plus a mounted `/proc`. Filesystem tools additionally use the documented base64, mktemp, wc, stat and readlink applets.

## Limits and failure behavior

- Maximum four concurrent task operations across the runtime agent. Further requests fail with `SANDBOX_CAPACITY_EXCEEDED` rather than creating an unbounded queue. Background execution has separate limits: one active execution per sandbox and eight globally. Synchronous sandbox.exec is rejected while a background execution is active, avoiding process-group interference.
- Synchronous sandbox.exec commands are limited to 64 non-empty arguments, each at most 4 KiB; timeout is capped at 120 seconds. Background execution accepts the same bounded argv and has a 30-minute default timeout, capped at 24 hours.
- Command output defaults to 256 KiB and is bounded to 1 MiB, with a caller-selectable maximum between 1 KiB and 1 MiB. Responses report exit code, stdout, stderr, timeout and truncation state.
- Environment overrides are allowlisted. Host environment variables are never copied into the container process environment.
- Filesystem reads are limited to 2 MiB; writes are limited to 1 MiB. Only regular files are readable or writable; symlinks and special files are rejected.
- Each execution is capped at 2 MiB of logs; retained logs are capped at 32 MiB per sandbox and 512 MiB globally. Logs expire seven days after completion; execution metadata expires after 30 days.
- Sandbox operations verify the workload record and runtime state on each request. Missing, stopped, malformed, project-service, or unmounted workloads fail closed.

## Deployment

The runtime agent and its `executions.mjs` module are installed as read-only files under `/usr/local/libexec/vps-mcp/`. Deploy both files together with the MCP application during the normal VPS-MCP deployment process. New task sandboxes receive the execution-log mount at creation; pre-existing task sandboxes must be recreated before durable execution can be started. Do not edit the live systemd unit, runtime environment, ACLs, Caddy configuration, or production services as part of this feature. Run the automated test suite before deployment and use a disposable task sandbox for live acceptance.
