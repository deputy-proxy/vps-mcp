# Sandbox runtime operations

## Install the runtime agent

Prerequisites:

- Rootless Podman feasibility and host isolation acceptance from #30.
- Repository/worktree management and the chosen workspace ownership model from #31/#32.
- The vps-sandbox non-login account, subordinate UID/GID ranges, rootless Podman storage, lingering user manager and D-Bus bus.
- A reviewed systemd service policy.
- The host acl package (setfacl) for per-worktree access grants.

Review these files before installation:

- systemd/vps-sandbox-runtime.socket
- systemd/vps-sandbox-runtime.service
- scripts/vps-sandbox-runtime.mjs
- scripts/executions.mjs
- scripts/resource-governance.mjs
- scripts/install-vps-sandbox-runtime.sh

Install the ACL prerequisite if it is not already present:

    sudo apt-get update && sudo apt-get install -y acl

The runtime service runs with the vps-sandbox account primary group. The socket remains owned by vps-sandbox:vps-mcp; do not override the runtime process primary group to vps-mcp, because that changes the rootless Podman GID mapping. The MCP workspace manager grants vps-sandbox execute-only ACLs on parent directories and read/write inherited ACLs only on the exact registered worktree when a runtime workload is created.

Install from the checked-out repository as root:

    sudo bash scripts/install-vps-sandbox-runtime.sh

The installer copies the runtime agent, executions.mjs and resource-governance.mjs modules to /usr/local/libexec/vps-mcp/, installs the systemd socket and service, creates /etc/vps-sandbox/runtime.env if absent, and enables the socket. It preserves an existing runtime environment file. It does not modify vps-mcp.service, the diagnostic broker, Caddy, production services or application repositories.

The default environment file leaves VPS_SANDBOX_ALLOWED_WORKSPACE_ROOTS and VPS_SANDBOX_ALLOWED_IMAGES empty. Do not populate it until the workspace root is provisioned and the vps-sandbox access boundary has been verified. The runtime agent uses Podman’s cgroupfs manager with the fixed cgroup parent `/system.slice/vps-sandbox-runtime.service`; the service unit delegates CPU, memory and PID controllers. Keep this parent fixed so limits remain enforced inside the runtime service boundary.

## Verify service readiness

    systemctl is-active vps-sandbox-runtime.socket
    stat -c '%A %U:%G %n' /run/vps-sandbox-runtime.sock
    systemctl status vps-sandbox-runtime.service --no-pager

The service is socket-activated, so it may be inactive until the first MCP request. The socket must be owned by vps-sandbox:vps-mcp with mode 0660.

The MCP-side adapter uses /run/vps-sandbox-runtime.sock by default. An alternate socket path can be set with VPS_SANDBOX_RUNTIME_SOCKET in the MCP service environment, but changing it is not necessary for the default deployment.

## Live workload acceptance

Do not use a production repository or real user data for the first runtime tests. Use a disposable workload and an approved digest-pinned image. Capture sanitized output for each test:

1. Inspect and pull the exact image digest.
2. Create a task workload with network disabled, read-only rootfs, all capabilities dropped, a non-root mapped UID/GID, the explicit seccomp profile and CPU/memory/PID budgets plus a monitored workspace disk budget (2 GiB by default).
3. Start it and inspect its runtime state.
4. Execute a harmless synchronous argv command and read bounded container logs.
5. Through `sandbox.exec`, verify the supplied sandbox ID selects the only execution container, cwd is confined to `/workspace`, argv values are not shell-expanded, timeouts and output limits are enforced, and host environment variables are not inherited.
6. Through `sandbox.filesystem.list/read/write`, verify regular-file handling, atomic writes, UTF-8 and file-size limits, symlink escape rejection, special-file rejection, and workspace-relative path validation. Confirm writes fail on read-only mounts.
7. Through `sandbox.execution.start/status/logs/cancel`, verify a long-running command, non-zero exit status, incremental log reads, timeout, targeted cancellation, bounded log output, and recovery after MCP/runtime-agent restart. Stop/remove a sandbox with an active execution and verify that all its processes terminate while another sandbox and project-service remain unaffected.
8. Verify project-service workload IDs are rejected by all `sandbox.*` tools, lifecycle changes return `SANDBOX_BUSY` while operations are active, and more than four concurrent sandbox operations return `SANDBOX_CAPACITY_EXCEEDED`.
9. Verify command output and structured tool errors redact supported credential patterns. Confirm runtime-unavailable errors never fall back to host execution.
10. Verify the container cannot read host secrets, another user's home, host root or the Podman socket.
11. Verify effective cgroup values from inside the container, not just Podman inspect configuration.
12. Stop and remove the task workload. Verify no container process or mount remains.
13. Repeat with a project-service workload and prove a task-typed stop/remove request is rejected.
14. Restart the MCP process and runtime agent; list workloads and verify records reconcile to actual Podman state.
15. During a maintenance window, reboot the VPS and repeat reconciliation. Do not reboot automatically from an MCP operation.

The service must never delete unknown containers or records during reconciliation. Record failures and investigate before retrying.

## Logs and diagnostics

    journalctl -u vps-sandbox-runtime.service --since today --no-pager
    journalctl -u vps-sandbox-runtime.socket --since today --no-pager
    runuser -u vps-sandbox -- podman ps -a
    runuser -u vps-sandbox -- podman info --debug

Do not print environment files, tokens, registry credentials or workload secrets into logs or support tickets.

## Stop and rollback

To stop accepting runtime requests:

    sudo systemctl disable --now vps-sandbox-runtime.socket

This does not stop or delete existing containers or workload records. Inspect and stop only the intended workloads through the approved runtime interface. Do not delete /var/lib/vps-sandbox/workloads or rootless Podman storage during rollback; those contain recovery metadata and possible user work.

To remove the service units, first disable the socket and confirm no runtime operation is active. Back up /etc/vps-sandbox/runtime.env and workload metadata. Remove only the installed unit and agent files after confirming no dependent issue (#34/#42) is using them.

## MCP task sandbox lifecycle

Task workspaces and runtime sandboxes have separate identifiers and lifecycles:

1. Call `task-workspace.create` with the registered repository ID and a stable task ID. The returned `id` is the **worktree ID**, not a sandbox ID.
2. Call `sandbox.image.inspect` with the exact SHA-256 image reference. The runtime accepts only digests in `VPS_SANDBOX_ALLOWED_IMAGES`.
3. If the image is not present, call `sandbox.image.pull` with that same approved digest.
4. Call `sandbox.create` with the repository ID, returned worktree ID and approved image digest. The runtime verifies the registered worktree and grants access only to that directory. The returned workload `id` is the **sandbox ID** used by all `sandbox.*` tools, including durable execution tools.
5. Call `sandbox.start` with the sandbox ID before executing commands or using filesystem tools.
6. Use `sandbox.inspect`, `sandbox.list` and `sandbox.logs` to inspect task workloads. Project-service workloads are excluded from these tools.
7. Call `sandbox.stop` and then `sandbox.remove` with `confirm=true` when the task container is no longer needed. Removing a sandbox does not remove its task worktree or its files.
8. Remove the task worktree separately with `task-workspace.remove` after confirming its changes are retained or intentionally discarded.

The MCP API does not accept Podman flags, host paths, raw container IDs, arbitrary environment variables or mutable image tags. Network isolation, read-only root filesystem, dropped capabilities, no-new-privileges and resource bounds are enforced by the runtime agent. The runtime agent independently enforces the administrator-managed image and workspace-root allowlists. Durable execution records are kept outside containers; only the selected sandbox’s bounded log directory is mounted into that container.

## Persistent project-service runtime

Persistent project environments use a separate lifecycle from task sandboxes. Use project-environment.release.set to select an existing canonical active or candidate release, then project-environment.provision, project-environment.runtime.inspect, project-environment.start, project-environment.stop and project-environment.deprovision; task sandbox tools and generic task container lifecycle requests cannot create, execute in, stop or remove project-service workloads.

Provisioning is fail-closed. The environment must have an existing canonical release directory under releases/<release-uuid>, and its versioned service profile must be marked deployable with a full immutable image reference. Provision pulls that exact digest through the rootless runtime before creating the workload; the runtime independently requires the same image reference in VPS_SANDBOX_ALLOWED_IMAGES. The Laravel profile intentionally remains definition-only until the published image digest, SBOM/provenance, vulnerability evidence and rootless VPS acceptance have all been reviewed and the digest is explicitly approved. Merely publishing an image does not enable provisioning. Release contents are supplied by a separate deployment workflow; this milestone does not build or copy application releases.

VPS_SANDBOX_PROJECT_ENV_ROOT must exactly match MCP_DATA_DIR/project-environments. The default is /var/lib/vps-mcp/project-environments. The installer creates this root and includes its backing block device in the restricted quota broker's device allowlist. If MCP_DATA_DIR is customized, configure the same absolute project-environment root in both the MCP environment and /etc/vps-sandbox/runtime.env before provisioning.

The development MCP service process must belong to the `vps-mcp` group to access the rootless runtime and fixed diagnostics sockets. New development installations add `SupplementaryGroups=vps-mcp`; on an existing development host, review and run `sudo bash scripts/configure-development-runtime-access.sh` before attempting live acceptance. This only grants access to the constrained runtime socket APIs; it does not grant shell or root access.

The rootless runtime currently accepts one project-environment data root. The development MCP instance is configured to use `/var/lib/vps-mcp-development/project-environments`, owned by `vps-mcp-development`; the runtime quota broker must use the same root and owner. On an existing host, review and run `sudo bash scripts/configure-development-project-environment-root.sh` before project-service acceptance. That script refuses to switch roots if any project-service containers exist, updates both service environments, reinstalls the restricted runtime broker configuration and restarts the development MCP service. The production MCP instance is intentionally not configured to provision project environments while the runtime broker is bound to the development root. Multi-root support is a separate change.


The restricted root quota broker derives source paths from repository ID and release UUID, grants the vps-sandbox identity ACL access only to the selected release and its writable storage/cache/log directories, and stages bind mounts under /var/lib/vps-sandbox-mounts/projects/. It rejects arbitrary host paths. Bind mounts enforce nosuid and nodev; application code is mounted at /app read-only, project storage at /app/storage, cache at /app/bootstrap/cache, and logs at /app/storage/logs. Its UID 10001 is mapped to the rootless vps-sandbox host identity. Network is none; there is no port publishing or project ingress in this milestone.

The project's reserved CPU, memory, PID and disk vector is enforced at admission. CPU, memory and PIDs are applied to the rootless container; disk is enforced with an ext4 project quota on the canonical per-repository project-environment directory. If the quota filesystem or mount broker is unavailable, provisioning fails closed. Start revalidates the staged mount set and read-only/writable mount flags. The project-service record and lifecycle intent are persisted before Podman mutation, making create/start/stop/remove retries identity-bound and idempotent.

This milestone provisions only the PHP-FPM web workload. Project-private MySQL/Redis, worker/scheduler processes, external networking, reverse-proxy exposure, DNS and TLS are separate acceptance milestones. Deprovisioning removes the container and staged mounts and releases the resource reservation, but retains release and project data directories. It does not silently erase application data.

## Capacity, cleanup and emergency controls

Use `resource.capacity` to inspect global/per-repository reservations, active workloads, container storage and disk pressure. The default budget reserves only a conservative fraction of host CPU and memory, caps active task sandboxes, and keeps a 5 GiB disk safety margin. Tune `VPS_SANDBOX_GLOBAL_*` and `VPS_SANDBOX_REPOSITORY_*` values in the runtime service environment only after measuring the host.

`project-environment.register` creates the durable per-repository resource reservation from the selected profile and bounded overrides. The lower-level `resource.reserve` operation is available for explicit reservations outside that workflow and is idempotent per repository. Call `resource.release` only after the project environment is deprovisioned. An active project-service workload consumes its reservation instead of being counted twice.

Use `sandbox.cleanup.preview` before cleanup. `sandbox.cleanup.run` is dry-run by default; actual removal requires both `dryRun=false` and `confirm=true`. The reaper is disabled unless `VPS_SANDBOX_CLEANUP_ENABLED=true`. When enabled, it removes only expired stopped task containers with no active or unknown executions. It never removes worktrees or files. Task workspaces have a hard ext4 project quota, defaulting to 2 GiB, applied to the exact managed worktree before container creation. Persistent project environments use a separate ext4 project quota based on their reserved disk vector. If the project-quota filesystem prerequisites or quota broker are unavailable, task creation fails closed rather than falling back to periodic-only enforcement. The five-minute runtime watchdog also scans workspace usage and stops an over-quota task as defense in depth; it is not the hard-limit mechanism.

Use `sandbox.maintenance.pause` with `paused=true` during an emergency. It blocks new sandbox creation/start, workspace writes and command execution, and suspends automatic cleanup. Existing workloads can still be stopped or removed. Use `sandbox.audit.list` to inspect recent private audit events.
