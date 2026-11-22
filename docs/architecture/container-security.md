# Container security policy

## Trust boundaries

| Component | Identity | Trust and permissions |
|---|---|---|
| Public MCP API | vps-mcp | Authenticated MCP tools; no Podman binary/socket access; no added capabilities |
| Runtime agent | vps-sandbox | Rootless Podman only; local socket requests validated against a fixed schema |
| Task container | Rootless user namespace | One assigned workspace mount at most; no host namespace or runtime socket |
| Project service | Rootless user namespace | Separate workload type; project-environment manager owns its lifecycle |
| Host administrator | root | Installs and reviews the dedicated runtime service; no runtime command is exposed through MCP |

## Mandatory container defaults

Every created container receives:

- Rootless Podman; no rootful engine or Docker group.
- --network=none; no host network namespace.
- Private PID/IPC namespaces (Podman defaults; host namespace joins are never accepted).
- --read-only root filesystem.
- --cap-drop=ALL.
- --security-opt=no-new-privileges.
- Default Podman seccomp profile.
- Explicit PID, memory and CPU limits.
- A 64 MiB /tmp tmpfs with noexec,nosuid,nodev.
- No device passthrough, privileged mode, host path mounts by default, or runtime socket mounts.

The agent constructs every Podman argument itself. Caller-supplied flags, raw container IDs, host paths outside the approved workspace roots, mutable image tags and environment overrides are not accepted.

## Workspace mounts

The agent resolves the requested path and every configured root with realpath, requires a directory, and verifies the resolved target remains beneath an explicitly approved root. The default configuration contains no allowed roots or image digests, so mount, inspect, pull and create requests fail closed.

Only these exact root directories may be configured:

- /srv/vps-mcp-workspaces
- /var/lib/vps-mcp/task-workspaces/worktrees

The administrator must provision the chosen directory and prove ownership/access boundaries before adding it to the runtime environment file. The task-workspace manager grants per-worktree POSIX ACLs only after verifying the registry record and Git worktree linkage: execute-only access on ancestors (no listing), and read/write access plus inherited ACLs on the exact worktree. Callers cannot select a different path. The host acl package (setfacl) is required. A path under a permitted root is not automatically safe: workspace creation and ownership must still be controlled by the repository/worktree manager.

## Image policy

Images must be pinned by SHA-256 digest and exactly match the administrator-managed VPS_SANDBOX_ALLOWED_IMAGES list. The default list is empty. The agent has no registry credentials in its request protocol and accepts no environment variables or credential mounts. Pulls are explicit; container create never performs an implicit pull. Add or change an image digest only after security review and smoke testing; language/toolchain profile mappings are owned by #42.

## Workload identity and lifecycle

Each workload has a generated UUID, an immutable workload type (task or project-service), repository ID, optional worktree ID, image digest, runtime ID and resource policy. Mutating lifecycle requests carry the expected workload type. Type mismatch is rejected before Podman is invoked.

Task operations cannot be used as a generic project-service cleanup path. The project-environment manager must use the project-service type and own project service configuration, data mounts and restart policy.

## Runtime service boundary

The runtime service uses the dedicated vps-sandbox account, not root and not vps-mcp. Its Unix socket is group-accessible only to vps-mcp. Its systemd unit delegates CPU/memory/PID controllers and permits only the UID/GID mapping capabilities needed by rootless Podman. The public MCP unit's existing hardening is not changed.

The systemd runtime service uses ProtectControlGroups=no with explicit cgroup delegation. This is a sensitive setting: the runtime identity must be proven unable to write outside its delegated subtree. NoNewPrivileges=no and the capability bounding set apply only to the dedicated runtime process tree. Do not install the service until the live cgroup and host filesystem isolation checks have been reviewed.

## Fail-closed behavior

- Missing runtime socket: MCP adapter returns an explicit unavailable error.
- Invalid operation or extra request fields: reject.
- Invalid UUID, repository ID, image digest, resource values or argv: reject.
- Workspace mount outside configured roots: reject.
- Unknown runtime ID or missing workload record: reject; never accept raw IDs from callers.
- Workload type mismatch: reject.
- Interrupted or missing runtime state: mark unknown and retain records for inspection.
- No automatic cleanup of unexplained containers, dirty workspaces or project services.
