# Sandbox lifecycle and runtime adapter

## Scope

The runtime adapter is the only application-layer interface to rootless Podman. It runs in a dedicated vps-sandbox systemd service and is reached by the public MCP process through a local Unix socket. The public vps-mcp.service does not receive Podman access, a runtime socket, sudo, or additional capabilities.

The adapter supports two distinct workload types:

- task: temporary execution containers associated with a repository and optional task worktree.
- project-service: persistent application containers associated with a repository. Their configuration, database, storage and deployment lifecycle belong to the project-environment manager (#42), not task cleanup.

No MCP tool exposes raw container IDs, Podman arguments, host paths, environment overrides or runtime flags. The MCP-side TypeScript adapter accepts typed operations and sends a bounded JSON request over /run/vps-sandbox-runtime.sock. The agent validates the request again before constructing fixed Podman argument arrays.

## Runtime operations

The internal adapter supports:

- Image inspect and pull, requiring a SHA-256 digest reference.
- Container create, start, inspect, list, stop, remove, exec and logs.
- Bounded CPU, memory and PID settings.
- A read-only container root filesystem, all capabilities dropped, no-new-privileges, private network namespace with network=none, and bounded tmpfs at /tmp.
- Optional bind mount at /workspace, only when its real path is beneath a root explicitly configured in VPS_SANDBOX_ALLOWED_WORKSPACE_ROOTS. The only accepted root paths are /srv/vps-mcp-workspaces and /var/lib/vps-mcp/task-workspaces/worktrees. Task mounts must resolve exactly to <root>/<repository-id>/<worktree-uuid>; the workspace registry identity is part of path validation. No mount root or image digest is approved by default.
- Exec using an argv array, never a host shell command. Command arguments are executed only inside the selected container.

Images must be immutable digest references, for example registry.example/app@sha256:<64-hex-digest>. Mutable tags are rejected. Image pull is an explicit operation; create uses --pull=never so deployment cannot silently fetch a changed image.

## Durable workload records

The runtime agent stores one JSON record per workload under /var/lib/vps-sandbox/workloads/<workload-id>/record.json, mode 0600, inside directories mode 0700. Records contain only non-secret metadata:

- Opaque workload ID and workload type.
- Repository and optional worktree IDs.
- Image reference and digest.
- Runtime container ID.
- Workspace mount reference and access mode.
- Resource/network policy.
- Lifecycle status and timestamps.

Commands, environment variables, credentials and container output are not persisted in workload records. Record writes use a temporary file followed by an atomic rename.

Lifecycle intent is persisted before start/stop/remove operations. On container.list, the agent reconciles each known runtime ID against Podman and updates its recorded state. Interrupted transitions without a verifiable runtime ID are reported as unknown; records and unexplained containers are not automatically deleted. A missing runtime container is also marked unknown and retained for operator review.

The agent serializes operations within its process. Durable records survive MCP and agent restarts. Container state after a host reboot is reconciled when workloads are listed or inspected; this adapter does not automatically restart task containers. Persistent project-service restart policy and application recovery are owned by #42.

## Lifecycle isolation

Every mutating start/stop/remove request includes the expected workload type. The agent compares it with the durable record and rejects a mismatch. Task cleanup must always pass expectedWorkloadType=task; it cannot accidentally stop or remove a project-service workload.

Task container destruction does not remove worktree records or worktree files. Project-service lifecycle remains separate from task sandbox lifecycle. The adapter never mounts a persistent project's mutable checkout into a task container unless a later trusted manager explicitly provisions and authorizes that path.

## Runtime boundary

The rootless agent runs as the dedicated non-login vps-sandbox identity. A systemd socket unit exposes a Unix socket owned by vps-sandbox:vps-mcp, mode 0660. The public MCP process can connect because it belongs to the vps-mcp group; unrelated local users cannot.

The service uses the dedicated rootless Podman storage and user manager, a bounded capability set for UID/GID mapping helpers, and delegated CPU/memory/PID controllers. It does not run as root and does not use the rootful Podman socket. The public MCP service unit remains unchanged.

The service unit's cgroup delegation and NoNewPrivileges=no are security-sensitive. They are confined to the dedicated non-login runtime identity, not the public MCP service. The live systemd policy and cgroup boundary must be reviewed on the VPS before installation. Do not enable workload creation merely because the TypeScript tests pass.

## Recovery and cleanup

- Create writes a creating intent record before Podman create.
- Start and stop persist starting/stopping before invoking Podman.
- Remove persists removing before invoking Podman.
- A failed or interrupted transition is reconciled from the actual runtime state.
- A missing runtime container does not cause its metadata record to be discarded.
- Runtime list never removes unknown or unregistered containers.
- No reaper is included here. Expiry, quotas, lock recovery and cleanup policy are owned by #36.

## Current rollout gate

The code, socket/service units and root-only installer are provided by this issue. The installer is intentionally not run automatically. Before enabling it on the VPS:

1. Review the service unit's cgroup delegation, capabilities, device access and filesystem write paths.
2. Confirm the vps-sandbox user manager and D-Bus bus are active.
3. Decide and provision the workspace mount root and ownership model. The installer leaves this unset.
4. Run the installer as root during a maintenance window.
5. Run live create/start/exec/logs/stop/remove tests using a digest-pinned test image.
6. Verify effective cgroup limits, namespace isolation, mount confinement, no host/runtime socket access, restart reconciliation and cleanup.
7. Record sanitized live evidence before closing #33.

Until those checks pass, the public MCP runtime adapter fails closed if its socket is unavailable.
