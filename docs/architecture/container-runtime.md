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
- `/etc/subuid` and `/etc/subgid` contain only `ubuntu:100000:65536`; `vps-mcp` has no subordinate UID/GID range.
- Kernel settings allow unprivileged user namespaces (`user.max_user_namespaces=47690`, `kernel.unprivileged_userns_clone=1`), so the host sysctls are not the blocker.
- The unprivileged user-namespace probe (`unshare -Ur ...`) fails with `Operation not permitted` inside `vps-mcp.service`.

The administrator confirmed the deployed unit matches the checked-in hardening: `User=vps-mcp`, empty `CapabilityBoundingSet`, `NoNewPrivileges=true`, `ProtectSystem=strict`, `ProtectHome=read-only`, `ProtectKernelTunables=true`, `ProtectKernelModules=true`, `ProtectControlGroups=true`, `RestrictSUIDSGID=true`, and `ReadWritePaths=/srv /var/lib/vps-mcp`. Effective properties confirm `Delegate=no`.

## Candidate and compatibility constraints

Rootless Podman is preferred because it does not require a rootful daemon or membership in the Docker group. The candidate must pass all of the following while running as `vps-mcp` under the actual `vps-mcp.service` sandbox:

1. Create a user namespace and establish the intended UID/GID mapping.
2. Pull an image, create/start/exec/stop/remove a container.
3. Mount only explicitly approved workspace paths, including read-only mounts; reject host paths outside the workspace.
4. Enforce CPU, memory and PID limits through cgroup v2.
5. Provide the selected network mode through `slirp4netns` or `pasta`.
6. Use a supported storage driver on the actual storage filesystem.
7. Survive service restart and host reboot without leaving untracked containers or processes.

The live service cgroup exposes only `memory` and `pids`, not `cpu`, and `cgroup.subtree_control` is not writable. The confirmed causes are `Delegate=no` and `ProtectControlGroups=yes`. Systemd 255 supports a more confined candidate configuration using `Delegate=cpu memory pids` together with `ProtectControlGroups=private`, which gives the service a private writable cgroup namespace while limiting delegation to its own subtree. This must be verified after a controlled drop-in is applied.

`NoNewPrivileges=true` prevents `newuidmap`/`newgidmap` from gaining the privileges provided by their setuid/file-capability mechanism. The empty `CapabilityBoundingSet=` also prevents those helpers from acquiring `CAP_SETUID`/`CAP_SETGID`. A conventional multi-ID rootless Podman test therefore needs `NoNewPrivileges=false` and a bounding set that permits only `CAP_SETUID CAP_SETGID` for the mapping helpers. **Keep `RestrictSUIDSGID=true`**: systemd documents this as blocking creation of SUID/SGID file bits, not execution of already-installed mapping helpers. The trade-off is that the bounding set and NNP change apply to the entire service process tree; child processes may execute other setuid binaries and obtain those two capabilities. This is another reason to prefer a dedicated runtime service identity for production. Treat the same-service override as a temporary feasibility test, not automatically an acceptable final production design. Consider isolating the runtime behind a dedicated, narrowly scoped service identity before production. Do not add capabilities or sudo access. A single-ID mapping is not an accepted substitute for the planned subordinate mapping model.

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

The provisioning script installs Podman and helper packages, allocates subordinate IDs only if absent, enables user lingering and prepares the rootless storage directory. It does not edit the systemd unit, grant sudo, add capabilities or change `NoNewPrivileges`. A proposed systemd drop-in for a controlled feasibility test is documented in the host provisioning guide; do not apply it to production without a rollback window and review.

## Acceptance gate

A passing preflight is necessary but not sufficient. Before selecting Podman as production runtime, complete the live test matrix in `docs/operations/host-provisioning.md` from the actual service context and record sanitized command output in the issue/PR. The preflight must be `READY`, the container smoke test must pass, and the systemd policy must be reviewed. Until then, sandbox creation remains disabled.
