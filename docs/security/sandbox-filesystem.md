# Task sandbox execution and filesystem boundary

## Tool inventory

Task tools are separate from host administration tools. Every task operation requires the UUID `sandboxId` returned by the sandbox lifecycle manager. The ID identifies a managed workload record; callers cannot supply a raw container ID, host path, mount path, Podman flag, or runtime socket path.

| Tool | Required inputs | Behavior |
|---|---|---|
| `sandbox.exec` | `sandboxId`, `command` (argument array) | Runs synchronously in the selected running task container. Optional `cwd` is relative to `/workspace`; `timeoutMs` is 1-120 seconds; `maxOutputBytes` is 1 KiB-1 MiB; `env` accepts only `LANG`, `LC_ALL`, `TZ`, `CI`, `NODE_ENV`, and `TERM`. |
| `sandbox.filesystem.list` | `sandboxId`, optional `path` | Lists immediate regular files and directories in the assigned workspace. Symlinks and special files are omitted. |
| `sandbox.filesystem.read` | `sandboxId`, `path` | Reads a UTF-8 regular file up to 2 MiB. |
| `sandbox.filesystem.write` | `sandboxId`, `path`, `content` | Atomically creates or replaces a UTF-8 regular file up to 1 MiB. Parent directories must already exist. |

All filesystem paths are relative to the task workspace. Absolute paths, empty path components, `.` and `..` components, backslashes, special files, and paths resolving outside the workspace are rejected. Directory symlinks are resolved and accepted only when their canonical target remains inside the workspace; final-file symlinks are rejected, and symlink entries are omitted from listings. Reads and writes operate inside the selected container using its `/workspace` mount. Writes use a temporary file in the same directory followed by rename and are denied when the workload mount is read-only. No task filesystem tool can address another sandbox by supplying a host path.

## Trust boundaries

- **Host administration:** `terminal.*` and `filesystem.*` remain host-level tools restricted by `MCP_ALLOWED_ROOTS`. They are not aliases for task operations and must not be used to execute task commands.
- **Task sandbox:** `sandbox.*` accepts only a managed task workload ID. The runtime agent loads its persisted workload record, requires `workloadType=task`, requires a running container and the managed `/workspace` mount, and checks that the host workspace path matches the registered repository/worktree identity and administrator-configured workspace root. Runtime-unavailable or invalid IDs fail closed; there is no host fallback.
- **Project service:** Project-service workloads are explicitly rejected by task tools. Task workloads receive only their individual task worktree mount. Project-service mounts, databases, storage, deployment credentials and secrets are not exposed through these tools.

The runtime agent runs as the dedicated unprivileged `vps-sandbox` identity under its hardened systemd unit. Its filesystem access to worktrees is granted per managed worktree. The task tools use the workspace path from the runtime record, never a caller-supplied host path. Commands are passed as an argv array to Podman exec; a minimal in-container `sh` wrapper validates the working directory and then calls `exec "$@"`, so command arguments are not shell-expanded. If a caller intentionally supplies `sh -c`, that nested shell remains inside the selected container. The approved task image must provide `sh`, `base64`, `mktemp`, `wc`, `tr`, `stat`, and `readlink` applets, plus a mounted `/proc` for filesystem tools.

## Limits and failure behavior

- Maximum four concurrent task operations across the runtime agent. Further requests fail with `SANDBOX_CAPACITY_EXCEEDED` rather than creating an unbounded queue.
- Commands are limited to 64 non-empty arguments, each at most 4 KiB; timeout is capped at 120 seconds.
- Command output defaults to 256 KiB and is bounded to 1 MiB, with a caller-selectable maximum between 1 KiB and 1 MiB. Responses report exit code, stdout, stderr, timeout and truncation state.
- Environment overrides are allowlisted. Host environment variables are never copied into the container process environment.
- Filesystem reads are limited to 2 MiB; writes are limited to 1 MiB. Only regular files are readable or writable; symlinks and special files are rejected.
- Sandbox operations verify the workload record and runtime state on each request. Missing, stopped, malformed, project-service, or unmounted workloads fail closed.

## Deployment

The runtime agent is installed as a read-only copy at `/usr/local/libexec/vps-mcp/vps-sandbox-runtime.mjs`. After merging this change, deploy the reviewed agent and MCP application together during the normal VPS-MCP deployment process. Do not edit the live systemd unit, runtime environment, ACLs, Caddy configuration, or production services as part of this feature. Run the automated test suite before deployment and use a disposable task sandbox for live acceptance.
