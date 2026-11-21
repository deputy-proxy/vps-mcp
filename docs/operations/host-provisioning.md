# Host provisioning and runtime validation

## Supported baseline

The current candidate target is Ubuntu 24.04 LTS, x86_64, systemd 255 or newer, cgroup v2, ext4 or another explicitly validated rootless-storage filesystem, and at least 2 GiB available RAM plus 10 GiB free disk for the runtime baseline. Production sizing and per-container limits will be established by the resource-governance issue.

## Administrator provisioning

Review `scripts/provision-rootless-podman.sh` before running it. From a privileged administrator session in the checked-out repository:

```bash
sudo bash scripts/provision-rootless-podman.sh vps-sandbox
```

The script is intentionally limited to Ubuntu 24.04. It creates the dedicated non-login `vps-sandbox` identity and private primary group when absent, installs `podman`, `uidmap`, `slirp4netns` and `fuse-overlayfs`; allocates subordinate UID/GID ranges only when none exist; prepares the service-owned storage directory; disables the package-enabled rootful Podman socket, service, auto-update service/timer and helper units; enables lingering; starts and validates the delegated user manager and its D-Bus socket; and installs a read-only preflight copy at `/usr/local/libexec/vps-mcp/rootless-runtime-preflight.mjs`. It does not edit `/opt/vps-mcp`, modify `vps-mcp.service`, enable a rootful daemon, add either identity to sudo or Docker groups, or broaden the public MCP service capabilities.

If a subordinate ID range is already assigned, inspect it for overlap before changing it. Never blindly replace an existing range. Confirm the runtime directory exists after provisioning:

```bash
SANDBOX_UID="$(id -u vps-sandbox)"
test -d "/run/user/${SANDBOX_UID}"
```

## Restricted MCP diagnostics broker

After provisioning the vps-sandbox identity, install the rootless diagnostic helper and its socket-activated broker as root:

```bash
sudo bash scripts/install-vps-sandboxctl.sh
```

The installer places the fixed helper and broker under /usr/local/libexec/vps-mcp/, installs vps-sandboxctl-broker.socket and vps-sandboxctl-broker.service, and enables the socket. The socket is owned by root:vps-mcp with mode 0660. The broker runs as root with NoNewPrivileges=yes, an empty capability bounding set and filesystem/kernel hardening. It accepts exactly one JSON operation per connection: preflight, info, smoke or acceptance. It does not accept commands, arguments, paths, image names or systemd properties.

The MCP service connects to /run/vps-sandboxctl.sock; it does not invoke sudo. This avoids the setuid restriction imposed by NoNewPrivileges=yes on the public MCP service. The broker asks the system manager to start the fixed transient test unit, which runs as vps-sandbox with the reviewed namespace and cgroup settings. The public vps-mcp.service unit remains unchanged.

Verify the socket is active and the legacy sudoers rule has been removed:

```bash
systemctl is-active vps-sandboxctl-broker.socket
stat -c '%A %U:%G %n' /run/vps-sandboxctl.sock
test ! -e /etc/sudoers.d/vps-mcp-sandboxctl
```

The MCP tool runtime.acceptance exposes only those three fixed operations. To revoke the bridge, stop and disable the socket, then remove the broker units and /usr/local/libexec/vps-mcp/ after confirming no diagnostics are running.

## Dedicated transient systemd test unit

Run both the preflight and Podman smoke test under the same dedicated transient unit configuration. Do not run them as `vps-mcp`, and do not change the public `vps-mcp.service` security policy.

```bash
SANDBOX_UID="$(id -u vps-sandbox)"
sudo systemd-run --wait --pipe --collect \
  --unit=vps-sandbox-rootless-smoke \
  --uid=vps-sandbox \
  --setenv=HOME=/var/lib/vps-sandbox \
  --setenv="XDG_RUNTIME_DIR=/run/user/${SANDBOX_UID}" \
  --property='Delegate=cpu memory pids' \
  --property=ProtectControlGroups=no \
  --property=NoNewPrivileges=no \
  --property='CapabilityBoundingSet=CAP_SETUID CAP_SETGID' \
  --property=RestrictSUIDSGID=yes \
  --property=ProtectSystem=strict \
  --property=ProtectHome=read-only \
  --property=ProtectKernelTunables=yes \
  --property=ProtectKernelModules=yes \
  --property=PrivateTmp=yes \
  --property="ReadWritePaths=/var/lib/vps-sandbox /run/user/${SANDBOX_UID}" \
  /usr/bin/bash -lc '/usr/bin/node /usr/local/libexec/vps-mcp/rootless-runtime-preflight.mjs && UNIT_CGROUP="/sys/fs/cgroup$(cut -d: -f3 /proc/self/cgroup)" && test -w "${UNIT_CGROUP}/cgroup.subtree_control" && test ! -w /sys/fs/cgroup/cgroup.subtree_control && test ! -w /sys/fs/cgroup/system.slice/cgroup.subtree_control && /usr/bin/podman --cgroup-manager=systemd info --debug && /usr/bin/podman --cgroup-manager=cgroupfs run --rm --pull=missing docker.io/library/alpine:3.21 id'
```

The preflight must report `READY`. It verifies the effective runtime identity, systemd user manager D-Bus socket, delegated CPU/memory/PID controllers, user namespace, subordinate IDs, mapping helpers, `NoNewPrivileges=false`, the two mapping-helper capabilities, cgroup v2 delegation, network helper, Podman and writable rootless storage. The inline cgroup checks also confirm that the unit can write its own delegated subtree but cannot write the root or `system.slice` cgroup control files. A preflight run from a normal administrator shell or from the public MCP service is not equivalent.

This is an isolated feasibility test, not the final production service design. Systemd 255 supports only boolean values for `ProtectControlGroups`; `private` is not a valid value on this host. `ProtectControlGroups=no` is required for writable cgroup delegation, while `Delegate=cpu memory pids` transfers ownership only of the unit subtree to `vps-sandbox`; the host manager retains ownership above it. Because the hierarchy remains visible, explicitly verify that writes outside the delegated subtree are denied. `NoNewPrivileges=no` and the two-capability bounding set apply to the entire transient unit process tree, which is why it runs under the dedicated non-login `vps-sandbox` identity. Keep `RestrictSUIDSGID=yes`. Preserve the public MCP service's existing hardening without exception.

## Restricted MCP runtime helper

The public MCP process must not receive general sudo access. The repository includes a root-owned helper that exposes only three fixed diagnostics: `preflight`, `info` and `smoke`. It accepts exactly one operation name and does not accept shell commands, Podman arguments, image names, systemd properties, paths or environment overrides. Each operation runs in a fresh transient systemd service as `vps-sandbox` with the reviewed property set above. The smoke operation runs only the pinned Alpine 3.21 test image and removes its container automatically. This helper is an acceptance/diagnostic bridge, not the future general sandbox lifecycle API; workload create/stop/remove APIs remain subject to the design and review in #33.

The restricted MCP diagnostics broker is installed and managed as described in the section above. Do not install a sudoers rule or modify the public MCP service.



## Automated live acceptance

After installing the latest helper and broker, run the fixed MCP tool operation `runtime.acceptance` with `operation=acceptance`. It runs a temporary Alpine container under the dedicated `vps-sandbox` transient unit and verifies:

- Rootless container identity and cgroup delegation boundaries.
- Read-only root filesystem, dropped capabilities, no-new-privileges and network mode `none`.
- Configured CPU, memory and PID limits, including the effective cgroup v2 values read inside the container.
- Read-only and explicitly writable workspace bind mounts.
- Absence of host-root and runtime-socket mounts.
- Container removal and temporary workspace cleanup.

The operation is bounded and cleans up its temporary resources. A failed check returns a non-zero exit code. It does not run destructive load tests or reboot the host.

### Manual restart and reboot recovery check

The acceptance suite cannot safely reboot or restart the public MCP service from inside its own execution path. Complete this separately during a maintenance window:

1. Record `systemctl is-active vps-mcp.service vps-sandboxctl-broker.socket` and the current `podman ps -a` output as `vps-sandbox`.
2. Confirm no application workload is running. Do not run this check while real workloads exist.
3. Reboot the VPS through the normal host administration procedure.
4. Verify both services are active after boot.
5. Run `runtime.acceptance` operations `preflight`, `smoke` and `acceptance` again.
6. Verify no container named `vps-acceptance-*`, no stale transient unit named `vps-sandboxctl-*`, and no leftover acceptance workspace remains.

Record the reboot time, service states, test outputs and cleanup evidence in issue #30. Do not claim reboot recovery until this manual check passes.

## Live acceptance matrix

After the transient preflight and basic smoke test pass, verify and record each item:

1. `podman unshare` succeeds and its UID/GID maps match the documented subordinate mapping model. Do not use generic `unshare -Ur` as the acceptance probe: Ubuntu's AppArmor `unprivileged_userns` transition can deny that executable while Podman's dedicated AppArmor profile permits the runtime's namespace path.
2. `podman --cgroup-manager=systemd info --debug` reports rootless mode, the systemd cgroup manager and the expected storage driver.
3. Pull a pinned, trusted test image.
4. Create and start a container with no added capabilities, no privileged mode, read-only rootfs, bounded tmpfs and explicit resource limits.
5. Execute a command and verify the expected container identity and UID/GID mapping.
6. Verify the container cannot read `/etc/shadow`, another user's home, the host runtime socket or arbitrary host paths.
7. Verify only the explicit workspace mount is visible; verify read-only mounts reject writes.
8. Verify CPU, memory and PID limits are enforced and observable under cgroup v2. Confirm the runtime identity cannot write to any cgroup outside its delegated transient-unit subtree.
9. Verify the selected network mode works without exposing host networking; confirm and document egress behavior.
10. Stop and remove the container; verify no process, mount or writable layer is left behind.
11. Run the smoke test a second time and verify rootless storage remains usable. Record whether any transient unit or container state remains after the first run.

Capture command output, runtime versions, effective transient-unit properties, cgroup controller files and test results. Redact tokens, registry credentials, private repository URLs and environment values. Do not claim MCP restart/host reboot reconciliation from this feasibility test; persistent lifecycle recovery is validated by later runtime lifecycle issues.

## Systemd policy review

The administrator-confirmed `vps-mcp.service` enables `NoNewPrivileges=true`, `RestrictSUIDSGID=true`, `ProtectSystem=strict`, `ProtectHome=read-only`, `ProtectControlGroups=true`, and an empty `CapabilityBoundingSet`; effective `Delegate=no`. The live cgroup exposes only `memory` and `pids`, not `cpu`, and `cgroup.subtree_control` is not writable. Kernel user-namespace sysctls are enabled. **Leave this public MCP service unchanged.**

If the transient unit cannot provide the required user namespace and delegated cgroup behavior, or can modify cgroups outside its own delegated subtree, stop and revise the runtime architecture rather than weakening `vps-mcp.service`. The final production service identity, control API and systemd policy must be designed and threat-model reviewed in #33 before runtime workloads are enabled.

## Rollback

1. Stop any test containers and remove only the test images/containers created for this acceptance run.
2. Disable lingering for `vps-sandbox` only if it was enabled solely for this experiment and no other service relies on it: `loginctl disable-linger vps-sandbox`.
3. Preserve subordinate ID allocations until confirming no process/container storage uses them. Removing or reassigning ranges can corrupt ownership of existing files.
4. Back up and then remove `/var/lib/vps-sandbox` only after confirming it contains no required state.
5. Remove packages only if they were installed solely for this experiment and no other host service depends on them.
6. Remove `/usr/local/libexec/vps-mcp/rootless-runtime-preflight.mjs` only if it was installed solely for this experiment.
7. Restore any administrator-managed configuration from the recorded backup. The provisioning script itself does not change the public systemd unit.

## Troubleshooting

- Generic `unshare -Ur` may be denied by Ubuntu's enforced AppArmor `unprivileged_userns` profile even when Podman is permitted. Use `podman unshare` for the runtime acceptance test. If that fails, inspect the Podman/crun AppArmor profiles, transient unit's effective `NoNewPrivileges`, capabilities, `Delegate` and `ProtectControlGroups`; do not disable the host-wide AppArmor restriction.
- `newuidmap`/`newgidmap` fails: check `/etc/subuid`, `/etc/subgid`, helper ownership/mode, `NoNewPrivileges` and the effective capability bounding set. `RestrictSUIDSGID` should normally remain enabled.
- cgroup limits unavailable: verify the lingering `user@<uid>.service` is active with `Delegate=yes`, its D-Bus socket exists, the helper passes `DBUS_SESSION_BUS_ADDRESS`, and Podman reports `cgroupManager: systemd`. Do not fall back to rootless `cgroupfs` for workload limits and do not mount or remount host cgroups from the MCP process.
- storage is not writable: verify `/var/lib/vps-sandbox/.local/share/containers` ownership and the unit's `ReadWritePaths`.
- overlay storage fails: validate `fuse-overlayfs` and filesystem support; do not switch to a less isolated storage mode without review.


### Host filesystem isolation checks

The fixed runtime helper validates that these protected host paths exist before starting a test unit: `/etc/vps-mcp`, `/etc/vps-mcp/vps-mcp.env`, `/opt/vps-mcp`, `/srv/vps-mcp`, `/root` and `/etc/shadow`. The transient unit masks the MCP environment directory, both private MCP checkouts and root's home with systemd `InaccessiblePaths=`. The acceptance suite then verifies from the actual `vps-sandbox` execution identity that the shadow file and MCP environment are unreadable and the protected directories cannot be traversed. This host-side check complements the container-side check for absent host-root and runtime-socket mounts.

The future managed workspace root `/srv/vps-mcp-workspaces` is intentionally not created by runtime feasibility provisioning. Once repository/worktree management provisions it, #31/#32 must add explicit per-workspace ownership and access tests before task sandboxes are enabled.
