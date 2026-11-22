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
- Required task bind mount at /workspace, only when its real path is beneath a root explicitly configured in VPS_SANDBOX_ALLOWED_WORKSPACE_ROOTS. The only accepted root paths are /srv/vps-mcp-workspaces and /var/lib/vps-mcp/task-workspaces/worktrees. Task mounts must resolve exactly to <root>/<repository-id>/<worktree-uuid>; the workspace registry identity is part of path validation. Task workloads also receive a private per-sandbox execution-log mount at /run/vps-mcp-executions. Project-service workloads never receive it. No workspace root or image digest is approved by default.
- Exec using an argv array, never a host shell command. Command arguments are executed only inside the selected container.

Images must be immutable digest references, for example registry.example/app@sha256:<64-hex-digest>. Mutable tags are rejected. Image pull is an explicit operation; create uses --pull=never so deployment cannot silently fetch a changed image.

## Durable workload records

The runtime agent stores one JSON record per workload under /var/lib/vps-sandbox/workloads/<workload-id>/record.json, mode 0600, inside directories mode 0700. Records contain only non-secret metadata:

- Opaque workload ID and workload type.
- Repository and optional worktree IDs.
- Image reference and digest.
- Runtime container ID.
- Workspace mount reference and access mode.
- Task-only execution log mount reference.
- Resource/network policy.
- Lifecycle status and timestamps.

Commands, environment variables, credentials and container output are not persisted in workload records. Record writes use a temporary file followed by an atomic rename.

Lifecycle intent is persisted before start/stop/remove operations. On container.list, the agent reconciles each known runtime ID against Podman and updates its recorded state. Interrupted transitions without a verifiable runtime ID are reported as unknown; records and unexplained containers are not automatically deleted. A missing runtime container is also marked unknown and retained for operator review.

The agent serializes operations within its process. Durable records survive MCP and agent restarts. Container state after a host reboot is reconciled when workloads are listed or inspected; this adapter does not automatically restart task containers. Persistent project-service restart policy and application recovery are owned by #42.

## Lifecycle isolation

Every mutating start/stop/remove request includes the expected workload type. The agent compares it with the durable record and rejects a mismatch. Task cleanup must always pass expectedWorkloadType=task; it cannot accidentally stop or remove a project-service workload.

Task container destruction does not remove worktree records or worktree files. Project-service lifecycle remains separate from task sandbox lifecycle. Before a task workload is created, the typed adapter asks the task-workspace manager to verify the registered worktree and grant the vps-sandbox identity execute-only ACLs on ancestor directories plus read/write inherited ACLs on that exact worktree. Arbitrary caller-supplied workspace paths are not accepted. The host acl package is required.

## Runtime boundary

The rootless agent runs as the dedicated non-login vps-sandbox identity with its account primary group unchanged so Podman user-namespace GID mapping remains consistent. A systemd socket unit independently exposes a Unix socket owned by vps-sandbox:vps-mcp, mode 0660. The public MCP process can connect because it belongs to the vps-mcp group; unrelated local users cannot.

The service uses the dedicated rootless Podman storage and user manager, a bounded capability set for UID/GID mapping helpers, and delegated CPU/memory/PID controllers. The runtime agent selects Podman’s cgroupfs manager and pins every workload beneath `/system.slice/vps-sandbox-runtime.service` with `--cgroup-parent`. This is intentional: it keeps workload cgroups inside this service’s delegated subtree, preserves effective CPU/memory/PID limits, and allows `podman exec` to enter the container cgroup. Do not remove the fixed parent or switch this service to the systemd cgroup manager; the latter attempts to manage scopes under the separate user manager and fails on this host when executing into a running container. The service does not run as root and does not use the rootful Podman socket. The public MCP service unit remains unchanged.

The service unit's cgroup delegation and NoNewPrivileges=no are security-sensitive. They are confined to the dedicated non-login runtime identity, not the public MCP service. The live systemd policy and cgroup boundary must be reviewed on the VPS before installation. Do not enable workload creation merely because the TypeScript tests pass.

## Recovery and cleanup

- Create writes a creating intent record before Podman create.
- Start and stop persist starting/stopping before invoking Podman.
- Remove persists removing before invoking Podman.
- A failed or interrupted transition is reconciled from the actual runtime state.
- A missing runtime container does not cause its metadata record to be discarded.
- Runtime list never removes unknown or unregistered containers.
- Execution-specific concurrency/log quotas and seven-/30-day execution log/record retention are enforced by the execution manager. General workload expiry, reaping, lock recovery and broader cleanup policy remain owned by #36.

## Current rollout gate

The rootless runtime service and socket were installed and accepted by the prerequisite issues. This issue adds the durable execution module and a task-only execution-log mount. After the reviewed code is merged, redeploy the runtime agent and module together with the root-only installer. The installer is not run automatically. Before redeploying:

1. Review the service unit's cgroup delegation, capabilities, device access and filesystem write paths.
2. Confirm the vps-sandbox user manager and D-Bus bus are active.
3. Decide and provision the workspace mount root and ownership model. The installer leaves this unset.
4. Run the installer as root during a maintenance window.
5. Recreate a disposable task sandbox so the new execution-log mount is present.
6. Run live execution start/status/logs/cancel, timeout, restart recovery, stop/remove, quota and log-retention tests using a digest-pinned test image.
7. Verify effective cgroup limits, namespace isolation, mount confinement, no host/runtime socket access, restart reconciliation and cleanup.
8. Record sanitized live evidence before closing #35.

Until those checks pass, the public MCP runtime adapter fails closed if its socket is unavailable.

## Public MCP task lifecycle

The public MCP surface exposes task-only lifecycle tools: `sandbox.image.inspect`, `sandbox.image.pull`, `sandbox.create`, `sandbox.start`, `sandbox.inspect`, `sandbox.list`, `sandbox.stop`, `sandbox.remove` and `sandbox.logs`. These tools never expose project-service workloads. The create operation takes a registered repository ID, a task-worktree ID and a digest-pinned image; the runtime agent remains the authority for checking the image allowlist, workspace-root allowlist and exact worktree mount identity.

The task-worktree ID and sandbox workload ID are distinct UUIDs. `sandbox.create` generates the workload ID and returns it for subsequent sandbox operations. It grants the runtime identity access to the exact worktree through the existing task-workspace preparation routine. The container is created with network disabled, a read-only root filesystem, all capabilities dropped, no-new-privileges and bounded CPU, memory and PID resources. Task containers also receive a per-sandbox host-backed log mount; execution metadata is kept outside the container. It is created stopped; callers must explicitly invoke `sandbox.start`.

Lifecycle operations inspect the durable workload record and enforce `workloadType=task`. Stop and remove requests pass the expected task type to the runtime agent, which independently rejects cross-type lifecycle operations. `sandbox.remove` requires explicit confirmation and removes only the container; task-worktree cleanup remains a separate operation.
