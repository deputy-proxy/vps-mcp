# Host provisioning and runtime validation

## Supported baseline

The current candidate target is Ubuntu 24.04 LTS, x86_64, systemd 255 or newer, cgroup v2, ext4 or another explicitly validated rootless-storage filesystem, and at least 2 GiB available RAM plus 10 GiB free disk for the runtime baseline. Production sizing and per-container limits will be established by the resource-governance issue.

## Read-only preflight

Run as `vps-mcp` in the same execution context used by the MCP service:

```bash
node scripts/rootless-runtime-preflight.mjs
```

The command exits nonzero when a required prerequisite fails. JSON output is available with `--json`. Warnings identify optional tuning or policy compatibility concerns. A successful host-level shell check does not replace a test under the actual systemd unit.

## Administrator provisioning

Review the script before running it. From a privileged administrator session:

```bash
sudo bash scripts/provision-rootless-podman.sh vps-mcp
```

The script is intentionally limited to Ubuntu 24.04. It installs `podman`, `uidmap`, `slirp4netns` and `fuse-overlayfs`; allocates subordinate UID/GID ranges only when none exist; enables lingering; and creates the service-owned storage directory. It does not edit `/opt/vps-mcp`, modify the active unit, enable a rootful daemon, add `vps-mcp` to sudo or Docker groups, or broaden capabilities.

If the subordinate ID range is already assigned, inspect it for overlap before changing it. Never blindly replace an existing range.

## Live acceptance matrix

Run each check as `vps-mcp` under the actual production `vps-mcp.service` restrictions, not from an administrator shell:

1. `unshare -Ur` succeeds and the UID/GID maps match the documented model.
2. `podman info --debug` reports rootless mode and the expected storage driver.
3. Pull a pinned, trusted test image.
4. Create and start a container with no added capabilities, no privileged mode, read-only rootfs, bounded tmpfs, and explicit resource limits.
5. Execute a command and verify the expected container identity and UID/GID mapping.
6. Verify the container cannot read `/etc/shadow`, another user's home, the host runtime socket, or arbitrary host paths.
7. Verify only the explicit workspace mount is visible; verify read-only mounts reject writes.
8. Verify CPU, memory and PID limits are enforced and observable under cgroup v2.
9. Verify the selected network mode works without exposing host networking; confirm default egress behavior.
10. Stop and remove the container; verify no process, mount or writable layer is left behind.
11. Restart `vps-mcp.service` and the host (during an approved maintenance window); verify runtime state reconciliation and no orphaned workloads.

Capture command output, runtime versions, systemd unit checksum and test results. Redact tokens, registry credentials, private repository URLs and environment values.

## Systemd policy review

The administrator-confirmed unit enables `NoNewPrivileges=true`, `RestrictSUIDSGID=true`, `ProtectSystem=strict`, `ProtectHome=read-only`, `ProtectControlGroups=true`, and an empty `CapabilityBoundingSet`; effective `Delegate=no`. The live cgroup exposes only `memory` and `pids`, not `cpu`, and `cgroup.subtree_control` is not writable. Kernel user-namespace sysctls are enabled. The missing prerequisites are therefore the service sandbox policy and subordinate IDs, not the host sysctls.

For a controlled feasibility test on systemd 255, the candidate drop-in is:

```ini
# /etc/systemd/system/vps-mcp.service.d/20-rootless-runtime-test.conf
[Service]
Delegate=cpu memory pids
ProtectControlGroups=private
NoNewPrivileges=false
CapabilityBoundingSet=CAP_SETUID CAP_SETGID
```

This is a **temporary test configuration**, not yet the approved production policy. `Delegate=` grants the service control of its own cgroup subtree; `ProtectControlGroups=private` provides a private writable cgroup namespace instead of exposing the host hierarchy read-write. `NoNewPrivileges=false` is required to let the mapping helpers gain the privileges needed to write the user namespace maps. The existing empty `CapabilityBoundingSet=` must also be replaced for the test with the minimum `CAP_SETUID CAP_SETGID` bounding set so the helpers can obtain those capabilities. Keep `RestrictSUIDSGID=true` and all other hardening settings unchanged. Do not add sudo or broader capabilities. Disabling `NoNewPrivileges` and allowing `CAP_SETUID CAP_SETGID` in the bounding set broadens the privilege-escalation surface for the whole service process tree: child processes may execute other setuid binaries and obtain those two capabilities. Production approval must consider a separate runtime service identity and a narrowly scoped runtime API.

Apply only during an approved maintenance window, after backing up the unit and confirming a rollback path. Then run `systemctl daemon-reload`, restart the service, and verify `systemctl show vps-mcp.service -p Delegate -p ProtectControlGroups -p NoNewPrivileges -p RestrictSUIDSGID -p CapabilityBoundingSet`. Re-run the preflight as `vps-mcp`; it must show the expected delegated controllers and writable `cgroup.subtree_control`. Then prove CPU, memory and PID limits with actual test containers. If any check fails, revert the drop-in and restart the service. Do not assume that the directive values alone prove the controls work.

`RestrictSUIDSGID=true` only blocks creating SUID/SGID file bits; it does not prevent executing the already-installed `newuidmap`/`newgidmap` helpers, so leave it enabled. `NoNewPrivileges=true` blocks privilege gain through setuid/file capabilities, while an empty `CapabilityBoundingSet=` prevents the mapping helpers from acquiring `CAP_SETUID`/`CAP_SETGID`. The production decision must document the security consequences and consider moving the runtime into a dedicated service identity before enabling general sandbox workloads.

The MCP service identity cannot read the deployed unit or perform administrator actions. An administrator must compare `/etc/systemd/system/vps-mcp.service` with the checked-in unit and confirm any drop-ins before provisioning.

## Rollback

1. Stop any test containers and remove only the test images/containers created for this acceptance run.
2. Disable lingering for the service user only if it was enabled solely for this experiment and no other service relies on it: `loginctl disable-linger vps-mcp`.
3. Preserve subordinate ID allocations until confirming no process/container storage uses them. Removing or reassigning ranges can corrupt ownership of existing files.
4. Back up and then remove the rootless Podman storage directory only after confirming it contains no required state.
5. Remove packages only if they were installed solely for this experiment and no other host service depends on them.
6. Restore any administrator-managed configuration from the recorded backup. The provisioning script itself does not change the systemd unit.

## Troubleshooting

- `unshare ... Operation not permitted`: verify `NoNewPrivileges`, `Delegate`, `ProtectControlGroups`, and the effective service cgroup namespace. The kernel sysctls being enabled does not prove the service can create namespaces.
- `newuidmap`/`newgidmap` fails: check `/etc/subuid`, `/etc/subgid`, helper ownership/mode and `NoNewPrivileges`. `RestrictSUIDSGID` controls creation of SUID/SGID file bits and should normally remain enabled.
- cgroup limits unavailable: verify cgroup v2 delegation for the service slice. Do not mount or remount host cgroups from the MCP process.
- overlay storage fails: validate `fuse-overlayfs` and filesystem support; do not switch to a less isolated storage mode without review.
