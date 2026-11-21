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

The checked-in unit currently enables `NoNewPrivileges=true`, `RestrictSUIDSGID=true`, `ProtectSystem=strict`, `ProtectHome=read-only`, `ProtectControlGroups=true`, and an empty `CapabilityBoundingSet`. These protections must remain unless an ADR amendment explains a narrowly scoped change and its security consequences. In particular, do not disable `NoNewPrivileges` or grant broad capabilities solely to make `newuidmap` work. Test alternatives, including single-ID mapping limitations, before proposing a change.

The MCP service identity cannot read the deployed unit or perform administrator actions. An administrator must compare `/etc/systemd/system/vps-mcp.service` with the checked-in unit and confirm any drop-ins before provisioning.

## Rollback

1. Stop any test containers and remove only the test images/containers created for this acceptance run.
2. Disable lingering for the service user only if it was enabled solely for this experiment and no other service relies on it: `loginctl disable-linger vps-mcp`.
3. Preserve subordinate ID allocations until confirming no process/container storage uses them. Removing or reassigning ranges can corrupt ownership of existing files.
4. Back up and then remove the rootless Podman storage directory only after confirming it contains no required state.
5. Remove packages only if they were installed solely for this experiment and no other host service depends on them.
6. Restore any administrator-managed configuration from the recorded backup. The provisioning script itself does not change the systemd unit.

## Troubleshooting

- `unshare ... Operation not permitted`: inspect kernel/user-namespace policy and the actual systemd sandbox. Do not infer that installing Podman fixes it.
- `newuidmap`/`newgidmap` fails: check `/etc/subuid`, `/etc/subgid`, helper ownership/mode, `NoNewPrivileges` and `RestrictSUIDSGID`.
- cgroup limits unavailable: verify cgroup v2 delegation for the service slice. Do not mount or remount host cgroups from the MCP process.
- overlay storage fails: validate `fuse-overlayfs` and filesystem support; do not switch to a less isolated storage mode without review.
