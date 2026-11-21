# Container runtime architecture

## Status

**Decision: rootless Podman is the preferred candidate, but it is not approved for production use.** The public `vps-mcp.service` cannot create the required user namespace or delegate the required cgroup controllers under its current hardening. No container runtime is installed. Do not enable sandbox workloads until the dedicated runtime identity has passed the administrator provisioning and live acceptance gates.

## Host facts captured

Captured on 2026-11-21 from the public `vps-mcp` execution identity on the production VPS:

- Ubuntu 24.04.5 LTS, x86_64, kernel `6.8.0-147-generic`.
- systemd 255; unified cgroup v2 (`cgroup2fs`).
- `/srv` is ext4, mounted read-write with `nosuid`; approximately 190 GiB free at inspection.
- The public MCP service cgroup exposes only `memory` and `pids`; `cpu` is not delegated. `cgroup.subtree_control` is not writable by `vps-mcp`.
- Approximately 11 GiB RAM available at inspection; no swap configured.
- `/srv` and `/var/lib/vps-mcp` are the MCP service's allowed writable roots.
- No Podman, Docker, Buildah, `newuidmap`, `newgidmap`, `slirp4netns`, `pasta` or `fuse-overlayfs` binary was present at inspection.
- `/etc/subuid` and `/etc/subgid` contain only `ubuntu:100000:65536`; no subordinate range exists for `vps-sandbox`.
- Kernel settings allow unprivileged user namespaces (`user.max_user_namespaces=47690`, `kernel.unprivileged_userns_clone=1`), so the host sysctls are not the blocker.
- The unprivileged user-namespace probe (`unshare -Ur ...`) fails with `Operation not permitted` inside `vps-mcp.service`.

The administrator confirmed the public unit has `User=vps-mcp`, an empty `CapabilityBoundingSet`, `NoNewPrivileges=true`, `ProtectSystem=strict`, `ProtectHome=read-only`, `ProtectKernelTunables=true`, `ProtectKernelModules=true`, `ProtectControlGroups=true`, `RestrictSUIDSGID=true`, and `ReadWritePaths=/srv /var/lib/vps-mcp`. Effective properties confirm `Delegate=no`.

## Candidate and compatibility constraints

Rootless Podman is preferred because it does not require a rootful daemon or Docker group membership. It must pass the acceptance matrix while running as **`vps-sandbox` inside the dedicated transient systemd test unit** described in the host provisioning guide. The public `vps-mcp.service` is not the runtime test context and must remain unchanged.

1. Create a user namespace and establish the intended subordinate UID/GID mapping.
2. Pull an image, create/start/exec/stop/remove a container.
3. Mount only explicitly approved workspace paths, including read-only mounts; reject host paths outside the workspace.
4. Enforce CPU, memory and PID limits through cgroup v2.
5. Provide the selected network mode through `slirp4netns` or `pasta`.
6. Use a supported storage driver on the actual storage filesystem.
7. Stop and remove test workloads without leaving untracked containers, mounts or processes. Persistent restart/reboot reconciliation is implemented and accepted in later lifecycle issues, not claimed by this feasibility PR.

The public service cgroup currently exposes only `memory` and `pids`, not `cpu`, and `cgroup.subtree_control` is not writable. The confirmed causes are `Delegate=no` and `ProtectControlGroups=yes`. Systemd 255 only accepts a boolean for `ProtectControlGroups`; the later `private` value is not supported by the deployed version. The transient unit therefore uses `ProtectControlGroups=no` together with `Delegate=cpu memory pids`. Per systemd 255 resource-control semantics, delegation transfers ownership of the unit cgroup subtree to the service user while the host manager retains ownership of the hierarchy above it. This must be verified on the live host, including proving that writes outside the delegated subtree are denied. The public MCP unit continues to use `ProtectControlGroups=true`.

`NoNewPrivileges=true` prevents `newuidmap`/`newgidmap` from gaining the privileges provided by their setuid/file-capability mechanism. The empty public-service capability bounding set also prevents those helpers from acquiring `CAP_SETUID`/`CAP_SETGID`. A conventional multi-ID rootless Podman test therefore needs `NoNewPrivileges=no` and a bounding set that permits only `CAP_SETUID CAP_SETGID` for the mapping helpers. **Keep `RestrictSUIDSGID=true`**: it blocks creation of SUID/SGID file bits, not execution of the installed mapping helpers. The trade-off is that the NNP and capability settings apply to the entire transient unit process tree. This is why the test runs under a dedicated non-login identity, never under `vps-mcp`. Since the test unit does not receive a private cgroup namespace on systemd 255, the hierarchy is visible for inspection; delegated ownership must prevent writes outside the unit subtree. The final production runtime boundary requires a separate threat-model review in #33.

## Security baseline

The runtime adapter must enforce, rather than rely on image defaults:

- Rootless engine only; no rootful Docker/Podman socket and no Docker group membership.
- No host PID, IPC or network namespace sharing.
- No privileged containers, added capabilities, device passthrough or host namespace joins.
- Drop all Linux capabilities; enable no-new-privileges inside the container; retain the default or stricter seccomp profile.
- Read-only container root filesystem, with narrowly scoped writable workspace and temporary mounts.
- Explicit CPU, memory, PID and storage limits; bounded process lifetime and output.
- Default-deny network policy until an explicit egress policy is designed and tested.
- No mounting of `/`, `/etc`, `/run`, `/var/run`, `/proc`, `/sys`, runtime sockets, credentials or other users' homes.
- Container UID/GID mapping must not grant access to host files beyond the task workspace.

## Operational directories

Keep runtime state separate from repository workspaces. The proposed locations are:

- Rootless Podman storage: `/var/lib/vps-sandbox/.local/share/containers`.
- Managed workspaces: `/srv/vps-mcp-workspaces` (not provisioned by this issue; later repository/worktree issues own it).
- MCP metadata and audit state: `/var/lib/vps-mcp`.

The MCP filesystem allowlist does not yet include `/srv/vps-mcp-workspaces`; later issues must update it deliberately and document ownership and mount policy. The `vps-sandbox` identity must not receive access to the private MCP checkout or MCP credentials.

## Preflight and provisioning

The administrator provisioning script installs Podman prerequisites, allocates subordinate IDs for `vps-sandbox`, prepares its rootless storage directory, enables lingering, and installs a read-only copy of the preflight at `/usr/local/libexec/vps-mcp/rootless-runtime-preflight.mjs`. It does not edit the public MCP systemd unit.

Run the preflight and smoke test as `vps-sandbox` inside the transient systemd unit shown in `docs/operations/host-provisioning.md`. The preflight inspects the effective process identity, `NoNewPrivileges`, capability bounding set, user namespace, cgroup delegation, subordinate IDs, helpers and storage. It deliberately does not read `vps-mcp.service`, because that is not the runtime test context.

## Acceptance gate

A passing preflight is necessary but not sufficient. Before selecting Podman as the runtime, complete the live test matrix in `docs/operations/host-provisioning.md` and record sanitized command output in issue #30. The preflight must report `READY`, the container smoke test and isolation/resource checks must pass, and the dedicated runtime service design must be reviewed. Until then, sandbox creation remains disabled. Merging the feasibility code does not close issue #30.
