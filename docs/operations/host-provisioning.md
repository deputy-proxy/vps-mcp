# Host provisioning and runtime validation

## Supported baseline

The current candidate target is Ubuntu 24.04 LTS, x86_64, systemd 255 or newer, cgroup v2, ext4 or another explicitly validated rootless-storage filesystem, and at least 2 GiB available RAM plus 10 GiB free disk for the runtime baseline. Production sizing and per-container limits will be established by the resource-governance issue.

## Administrator provisioning

Review `scripts/provision-rootless-podman.sh` before running it. From a privileged administrator session in the checked-out repository:

```bash
sudo bash scripts/provision-rootless-podman.sh vps-sandbox
```

The script is intentionally limited to Ubuntu 24.04. It creates the dedicated non-login `vps-sandbox` identity and private primary group when absent, installs `podman`, `uidmap`, `slirp4netns` and `fuse-overlayfs`; allocates subordinate UID/GID ranges only when none exist; prepares the service-owned storage directory; disables the package-enabled rootful Podman socket, service, auto-update service/timer and helper units; enables lingering; starts the user manager; and installs a read-only preflight copy at `/usr/local/libexec/vps-mcp/rootless-runtime-preflight.mjs`. It does not edit `/opt/vps-mcp`, modify `vps-mcp.service`, enable a rootful daemon, add either identity to sudo or Docker groups, or broaden the public MCP service capabilities.

If a subordinate ID range is already assigned, inspect it for overlap before changing it. Never blindly replace an existing range. Confirm the runtime directory exists after provisioning:

```bash
SANDBOX_UID="$(id -u vps-sandbox)"
test -d "/run/user/${SANDBOX_UID}"
```

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
  /usr/bin/bash -lc '/usr/bin/node /usr/local/libexec/vps-mcp/rootless-runtime-preflight.mjs && UNIT_CGROUP="/sys/fs/cgroup$(cut -d: -f3 /proc/self/cgroup)" && test -w "${UNIT_CGROUP}/cgroup.subtree_control" && test ! -w /sys/fs/cgroup/cgroup.subtree_control && test ! -w /sys/fs/cgroup/system.slice/cgroup.subtree_control && /usr/bin/podman --cgroup-manager=cgroupfs info --debug && /usr/bin/podman --cgroup-manager=cgroupfs run --rm --pull=missing docker.io/library/alpine:3.21 id'
```

The preflight must report `READY`. It verifies the effective runtime identity, user namespace, subordinate IDs, mapping helpers, `NoNewPrivileges=false`, the two mapping-helper capabilities, cgroup v2 delegation, network helper, Podman and writable rootless storage. The inline cgroup checks also confirm that the unit can write its own delegated subtree but cannot write the root or `system.slice` cgroup control files. A preflight run from a normal administrator shell or from the public MCP service is not equivalent.

This is an isolated feasibility test, not the final production service design. Systemd 255 supports only boolean values for `ProtectControlGroups`; `private` is not a valid value on this host. `ProtectControlGroups=no` is required for writable cgroup delegation, while `Delegate=cpu memory pids` transfers ownership only of the unit subtree to `vps-sandbox`; the host manager retains ownership above it. Because the hierarchy remains visible, explicitly verify that writes outside the delegated subtree are denied. `NoNewPrivileges=no` and the two-capability bounding set apply to the entire transient unit process tree, which is why it runs under the dedicated non-login `vps-sandbox` identity. Keep `RestrictSUIDSGID=yes`. Preserve the public MCP service's existing hardening without exception.

## Restricted MCP runtime helper

The public MCP process must not receive general sudo access. The repository includes a root-owned helper that exposes only three fixed diagnostics: `preflight`, `info` and `smoke`. It accepts exactly one operation name and does not accept shell commands, Podman arguments, image names, systemd properties, paths or environment overrides. Each operation runs in a fresh transient systemd service as `vps-sandbox` with the reviewed property set above. The smoke operation runs only the pinned Alpine 3.21 test image and removes its container automatically. This helper is an acceptance/diagnostic bridge, not the future general sandbox lifecycle API; workload create/stop/remove APIs remain subject to the design and review in #33.

After pulling the repository version containing `scripts/vps-sandboxctl.mjs`, install it and its exact-argument sudoers policy once as root:

```bash
sudo bash scripts/install-vps-sandboxctl.sh
```

The installer places `/usr/local/sbin/vps-sandboxctl` as `root:root` mode `0755` and `/etc/sudoers.d/vps-mcp-sandboxctl` as `root:root` mode `0440`, validates the policy with `visudo`, and grants `vps-mcp` passwordless permission for only these exact invocations:

```bash
sudo -n /usr/local/sbin/vps-sandboxctl preflight
sudo -n /usr/local/sbin/vps-sandboxctl info
sudo -n /usr/local/sbin/vps-sandboxctl smoke
```

The MCP tool `runtime.acceptance` invokes those same fixed operations. It does not accept arbitrary command input. Verify the installed helper and sudoers file ownership/modes after installation. Do not add `vps-mcp` to the sudo or Docker groups, do not grant `/usr/bin/systemd-run` directly, and do not change `vps-mcp.service`. Remove `/etc/sudoers.d/vps-mcp-sandboxctl` and `/usr/local/sbin/vps-sandboxctl` to revoke this bridge.

## Live acceptance matrix

After the transient preflight and basic smoke test pass, verify and record each item:

1. `podman unshare` succeeds and its UID/GID maps match the documented subordinate mapping model. Do not use generic `unshare -Ur` as the acceptance probe: Ubuntu's AppArmor `unprivileged_userns` transition can deny that executable while Podman's dedicated AppArmor profile permits the runtime's namespace path.
2. `podman --cgroup-manager=cgroupfs info --debug` reports rootless mode and the expected storage driver.
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
- cgroup limits unavailable: verify cgroup v2 delegation for the transient unit. Do not mount or remount host cgroups from the MCP process.
- storage is not writable: verify `/var/lib/vps-sandbox/.local/share/containers` ownership and the unit's `ReadWritePaths`.
- overlay storage fails: validate `fuse-overlayfs` and filesystem support; do not switch to a less isolated storage mode without review.
