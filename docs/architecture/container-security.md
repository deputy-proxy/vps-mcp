# Container security policy

## Trust boundaries

| Component | Identity | Trust and permissions |
|---|---|---|
| Public MCP API | `vps-mcp` | Authenticated MCP tools; no general Podman socket or root access |
| Runtime agent | `vps-sandbox` | Rootless Podman; validated local socket requests; bounded systemd capabilities and cgroups |
| Task container | Rootless user namespace | One assigned task workspace at most; restricted egress proxy; no host namespace or runtime socket |
| Project service | Rootless user namespace | Separate workload type; no egress (`network=none`) until private project routing is implemented |
| Quota broker | `root` | Restricted socket API for managed project-quota operations; no arbitrary paths or shell commands |
| Egress proxy | `vps-egress` | Exact-hostname allowlist and destination restrictions |
| Host administrator | `root` | Installs and reviews privileged runtime, quota, firewall and proxy configuration |

## Mandatory container defaults

Every created container receives:

- Rootless Podman; no rootful engine or Docker group.
- A generated workload identity and immutable workload type.
- An administrator-approved image pinned by SHA-256 digest.
- A read-only root filesystem.
- `--cap-drop=ALL`.
- `--security-opt=no-new-privileges`.
- The administrator-managed Podman seccomp profile.
- `--userns=keep-id` and the mapped `vps-sandbox` UID/GID.
- Explicit PID, memory and CPU limits.
- A bounded `/tmp` tmpfs with `noexec,nosuid,nodev`.
- Private PID and IPC namespaces.
- No privileged mode, host namespace joins, host PID/network, arbitrary host mounts, runtime socket mounts or caller-selected devices.

The agent constructs Podman arguments itself. Caller-supplied flags, raw container IDs, arbitrary host paths, mutable image tags and unapproved environment overrides are rejected.

The runtime systemd service has narrowly scoped host device permissions needed by rootless storage/networking. These permissions do not grant task containers device passthrough. Container device access remains denied unless a separately reviewed policy explicitly changes it.

## Network policy

### Task workloads

Task workloads use the administrator-installed restricted egress profile:

- Rootless `slirp4netns:allow_host_loopback=true`.
- Explicit proxy URL `http://10.0.2.2:3128` inside the container.
- Explicit uppercase and lowercase HTTP/HTTPS proxy environment variables.
- Explicit `NO_PROXY`/`no_proxy` values limited to local loopback names.
- Podman's automatic proxy injection is disabled; the runtime supplies the approved variables itself.
- Host nftables rules allow the `vps-sandbox` UID to connect only to the loopback proxy at `127.0.0.1:3128` and drop its other direct outbound sockets.
- The `vps-egress` UID may send only established TCP replies from source port `3128` to loopback and the slirp client subnet; other local/private destinations remain blocked.
- Squid permits only exact hostnames in `/etc/vps-sandbox/egress/allowed-domains.txt`.
- The proxy denies private, loopback, link-local and metadata destinations and restricts upstream TCP ports to 80 and 443.

The proxy and firewall are required dependencies of the runtime service when the restricted task egress profile is enabled. If the required profile is unavailable, the runtime must fail closed rather than silently start with unrestricted networking.

The administrator must review allowlist changes. Wildcard suffix entries are not supported. A hostname being allowlisted does not imply that every resource served by it is trusted.

### Project-service workloads

Project-service workloads remain on `network=none`. They must not inherit task egress access. Private project routing and authenticated reverse-proxy access are separate controls owned by the project-environment and routing work.

## Workspace mounts

The agent resolves the requested path and configured roots with `realpath`, requires a directory, and verifies that the resolved target remains beneath an explicitly approved root.

Only administrator-approved workspace roots may be configured:

- `/srv/vps-mcp-workspaces`
- `/var/lib/vps-mcp/task-workspaces/worktrees`

The administrator must provision the chosen root and prove ownership/access boundaries before adding it to the runtime environment file.

The task-workspace manager grants per-worktree POSIX ACLs only after verifying the registry record and Git worktree linkage. Ancestors receive execute-only access; the exact worktree receives read/write access and inherited ACLs. Callers cannot select a different path.

A path beneath an approved root is not automatically trusted. Workspace creation, registration and ownership remain controlled by the repository/worktree manager.

## Image policy

Images must be pinned by SHA-256 digest and exactly match the administrator-managed `VPS_SANDBOX_ALLOWED_IMAGES` list.

The runtime has no registry credentials in its request protocol. It accepts no caller-supplied credential mounts or arbitrary environment values. Pulls are explicit; container creation does not perform an implicit pull.

Add or change an image digest only after security review and smoke testing.

## Workload identity and lifecycle

Each workload has a generated UUID, immutable workload type (`task` or `project-service`), repository ID, optional worktree ID, image digest, runtime ID and resource policy.

Mutating lifecycle requests carry the expected workload type. Type mismatches are rejected before Podman is invoked.

Task operations cannot be used as a generic project-service cleanup path. The project-environment manager owns project-service configuration, data mounts and restart policy.

## Runtime and quota service boundaries

The runtime agent runs as the dedicated `vps-sandbox` account, not root and not `vps-mcp`. Its Unix socket is group-accessible only to `vps-mcp`.

The runtime systemd unit delegates only the required CPU, memory and PID controllers and permits the capabilities and device access needed by the rootless runtime. `DevicePolicy=closed` remains in force. The public MCP unit's existing hardening is not changed.

Sensitive systemd settings:

The runtime relies on explicit cgroup delegation and a narrowly scoped capability and device policy. Settings affecting cgroup protection, NoNewPrivileges, the capability bounding set, DevicePolicy or DeviceAllow must not be broadened casually.

Any change requires verification that the vps-sandbox identity cannot write outside its delegated cgroup subtree and cannot access unapproved host devices. Review effective systemd properties, not only the unit file. The public MCP service must retain its independent hardening.


The quota broker is a separate root-owned socket-activated service. Its API accepts only a repository ID, managed worktree UUID and bounded disk budget. It derives the workspace path from approved roots and registry data; it does not accept arbitrary paths or commands.

## Disk quotas and resource governance

Task workspace hard limits are enforced with ext4 project quotas. The quota broker assigns a deterministic project ID, applies project inheritance to the managed worktree and configures the hard block limit before container creation.

The default task workspace hard limit is 2 GiB. If the required ext4 project-quota prerequisites or broker are unavailable, task creation fails closed with `SANDBOX_DISK_QUOTA_UNAVAILABLE`.

The runtime's periodic disk watchdog remains defense in depth. It monitors workspace usage and stops an over-budget task if necessary, but it is not a replacement for the hard filesystem quota.

Global and per-repository CPU, memory, PID and disk reservations are checked before workload admission. The runtime reserves host headroom and blocks new allocations when the configured disk safety margin would be crossed.

Podman images, container storage, caches, execution logs, audit records and worktrees are monitored separately. An individual worktree project quota does not cap all of these other storage categories.

## Fail-closed behavior

- Missing runtime socket: the MCP adapter returns an explicit unavailable error.
- Invalid operation or extra request fields: reject.
- Invalid UUID, repository ID, image digest, resource values or argv: reject.
- Workspace mount outside configured roots: reject.
- Unknown runtime ID or missing workload record: reject; never accept raw IDs from callers.
- Workload type mismatch: reject.
- Missing quota prerequisites: reject task creation.
- Missing required task egress services: do not start with unrestricted networking.
- Interrupted or missing runtime state: mark unknown and retain records for inspection.
- No automatic cleanup of unexplained containers, dirty workspaces or project services.

## Locking, cleanup and audit

Mutating lifecycle, workspace and resource operations acquire durable per-resource locks. Lock owners include PID and process-start identity plus an ownership token. A lock is reclaimed only after the owner is proven dead or the owner record remains invalid beyond the stale-lock grace period. Locks are acquired in stable key order and have bounded waits.

Automatic cleanup is disabled by default. When enabled, the reaper removes only eligible expired task containers with terminal executions and terminal runtime state. It never removes project-service workloads, Git worktrees, retained work or execution history.

Operators can preview cleanup and must explicitly confirm actual cleanup. An emergency pause blocks new creation, starts, workspace writes and command execution and suspends automatic housekeeping.

Lifecycle, capacity, cleanup, pause and policy-denial events are stored in private, bounded audit files with credential-pattern redaction. Audit data must not contain command argument arrays or environment values.


Task workspaces are bind-mounted through a per-workload staging directory outside the sandbox user's home. The staging root is owned by root and group-readable/traversable by the dedicated runtime identity. A restricted root quota broker enters the host mount namespace to create or remove only identity-derived staging paths; task containers receive the staged bind mount with the requested read-only or read-write mode. The unprivileged runtime cannot create host mounts.
