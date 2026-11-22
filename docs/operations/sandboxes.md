# Sandbox runtime operations

## Install the runtime agent

Prerequisites:

- Rootless Podman feasibility and host isolation acceptance from #30.
- Repository/worktree management and the chosen workspace ownership model from #31/#32.
- The vps-sandbox non-login account, subordinate UID/GID ranges, rootless Podman storage, lingering user manager and D-Bus bus.
- A reviewed systemd service policy.

Review these files before installation:

- systemd/vps-sandbox-runtime.socket
- systemd/vps-sandbox-runtime.service
- scripts/vps-sandbox-runtime.mjs
- scripts/install-vps-sandbox-runtime.sh

Install from the checked-out repository as root:

    sudo bash scripts/install-vps-sandbox-runtime.sh

The installer copies the agent to /usr/local/libexec/vps-mcp/, installs the systemd socket and service, creates /etc/vps-sandbox/runtime.env if absent, and enables the socket. It preserves an existing runtime environment file. It does not modify vps-mcp.service, the diagnostic broker, Caddy, production services or application repositories.

The default environment file leaves VPS_SANDBOX_ALLOWED_WORKSPACE_ROOTS empty. Do not populate it until the workspace root is provisioned and the vps-sandbox access boundary has been verified.

## Verify service readiness

    systemctl is-active vps-sandbox-runtime.socket
    stat -c '%A %U:%G %n' /run/vps-sandbox-runtime.sock
    systemctl status vps-sandbox-runtime.service --no-pager

The service is socket-activated, so it may be inactive until the first MCP request. The socket must be owned by vps-sandbox:vps-mcp with mode 0660.

The MCP-side adapter uses /run/vps-sandbox-runtime.sock by default. An alternate socket path can be set with VPS_SANDBOX_RUNTIME_SOCKET in the MCP service environment, but changing it is not necessary for the default deployment.

## Live workload acceptance

Do not use a production repository or real user data for the first runtime tests. Use a disposable workload and an approved digest-pinned image. Capture sanitized output for each test:

1. Inspect and pull the exact image digest.
2. Create a task workload with network disabled, read-only rootfs, all capabilities dropped and explicit CPU/memory/PID limits.
3. Start it and inspect its runtime state.
4. Execute a harmless argv command and read bounded logs.
5. Verify a read-only workspace mount rejects writes and an explicitly writable workspace mount remains confined to the approved root.
6. Verify the container cannot read host secrets, another user's home, host root or the Podman socket.
7. Verify effective cgroup values from inside the container, not just Podman inspect configuration.
8. Stop and remove the task workload. Verify no container process or mount remains.
9. Repeat with a project-service workload and prove a task-typed stop/remove request is rejected.
10. Restart the MCP process and runtime agent; list workloads and verify records reconcile to actual Podman state.
11. During a maintenance window, reboot the VPS and repeat reconciliation. Do not reboot automatically from an MCP operation.

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
