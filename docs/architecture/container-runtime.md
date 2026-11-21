# Container runtime architecture

## Status

**Decision: rootless Podman is the preferred candidate, but it is not approved for production use yet.** The current production execution context cannot create an unprivileged user namespace, and the live MCP process cannot inspect or change the systemd unit. No container runtime is installed. Do not enable sandbox workloads until the administrator prerequisites and the full service-context acceptance test pass.

## Host facts captured

Captured on 2026-11-21 from the `vps-mcp` execution identity on the production VPS:

- Ubuntu 24.04.5 LTS, x86_64, kernel `6.8.0-147-generic`.
- systemd 255; unified cgroup v2 (`cgroup2fs`).
- `/srv` is ext4, mounted read-write with `nosuid`; approximately 190 GiB free at inspection.
- The live service cgroup exposes only `memory` and `pids` controllers; `cpu` is not delegated. `cgroup.subtree_control` is not writable by `vps-mcp`.
- Approximately 11 GiB RAM available at inspection; no swap configured.
- `/srv` and `/var/lib/vps-mcp` are the MCP service's allowed writable roots.
- No Podman, Docker, Buildah, `newuidmap`, `newgidmap`, `slirp4netns`, `pasta` or `fuse-overlayfs` binary was present.
- `/etc/subuid` and `/etc/subgid` had no allocation for `vps-mcp`.
- The unprivileged user-namespace probe (`unshare -Ur ...`) failed with `Operation not permitted` in the MCP execution context.

The service unit tracked in this repository runs as `vps-mcp`, has an empty capability bounding set, and enables `NoNewPrivileges=true`, `ProtectSystem=strict`, `ProtectHome=read-only`, `ProtectKernelTunables=true`, `ProtectKernelModules=true`, `ProtectControlGroups=true`, `RestrictSUIDSGID=true`, and `ReadWritePaths=/srv /var/lib/vps-mcp`. The deployed unit is outside the MCP service's readable roots, so its live contents must be confirmed by an administrator before any host changes.

## Candidate and compatibility constraints

Rootless Podman is preferred because it does not require a rootful daemon or membership in the Docker group. The candidate must pass all of the following while running as `vps-mcp` under the actual `vps-mcp.service` sandbox:

1. Create a user namespace and establish the intended UID/GID mapping.
2. Pull an image, create/start/exec/stop/remove a container.
3. Mount only explicitly approved workspace paths, including read-only mounts; reject host paths outside the workspace.
4. Enforce CPU, memory and PID limits through cgroup v2.
5. Provide the selected network mode through `slirp4netns` or `pasta`.
6. Use a supported storage driver on the actual storage filesystem.
7. Survive service restart and host reboot without leaving untracked containers or processes.

The live service cgroup currently exposes only `memory` and `pids`, not `cpu`, and `cgroup.subtree_control` is not writable. The checked-in unit has `ProtectControlGroups=true` and no `Delegate=yes`. CPU/memory/PID enforcement therefore cannot be assumed; explicit systemd delegation and a narrowly scoped policy design must be proven before accepting Podman.

`NoNewPrivileges=true` prevents setuid privilege gain by `newuidmap`/`newgidmap`. A single-ID mapping is not accepted as a silent substitute for the planned mapping model. `RestrictSUIDSGID=true` is an additional compatibility concern. Do not relax either directive merely to make a smoke test pass. If a narrowly scoped systemd policy change is ultimately necessary, document the exact threat-model impact and prove that all other restrictions remain effective.

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

- Podman rootless storage: service user's home under `/var/lib/vps-mcp`.
- Managed workspaces: `/srv/vps-mcp-workspaces` (not provisioned by this issue; later repository/worktree issues own it).
- Runtime metadata and audit state: `/var/lib/vps-mcp`.

The current MCP allowlist does not yet include `/srv/vps-mcp-workspaces`; later issues must update it deliberately and document ownership and mount policy.

## Preflight and provisioning

Run the non-mutating check as the service identity:

```bash
node scripts/rootless-runtime-preflight.mjs
node scripts/rootless-runtime-preflight.mjs --json
```

An administrator may install Ubuntu 24.04 prerequisites with:

```bash
sudo bash scripts/provision-rootless-podman.sh vps-mcp
```

The provisioning script installs Podman and helper packages, allocates subordinate IDs only if absent, enables user lingering and prepares the rootless storage directory. It does not edit the systemd unit, grant sudo, add capabilities or change `NoNewPrivileges`.

## Acceptance gate

A passing preflight is necessary but not sufficient. Before selecting Podman as production runtime, complete the live test matrix in `docs/operations/host-provisioning.md` from the actual service context and record sanitized command output in the issue/PR. The preflight must be `READY`, the container smoke test must pass, and the systemd policy must be reviewed. Until then, sandbox creation remains disabled.
