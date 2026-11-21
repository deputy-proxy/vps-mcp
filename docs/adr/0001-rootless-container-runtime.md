# ADR-0001: Rootless container runtime for managed development sandboxes

- Status: **Proposed, blocked on administrator validation**
- Date: 2026-11-21
- Issue: [#30](https://github.com/deputy-proxy/vps-mcp/issues/30)

## Context

The sandbox platform needs per-task container isolation without a rootful container daemon or broad host privileges. The production VPS is Ubuntu 24.04.5, kernel 6.8, systemd 255 and cgroup v2. The MCP process runs as unprivileged `vps-mcp` with an empty capability bounding set and hardened systemd restrictions. No container runtime or rootless helper packages were installed at inspection. No subordinate UID/GID ranges were configured for the service account. An unprivileged user-namespace probe from the MCP execution context failed with `Operation not permitted`. The live service cgroup exposes only `memory` and `pids`, not `cpu`, and `cgroup.subtree_control` is not writable by `vps-mcp`; the checked-in unit does not set `Delegate=yes` and enables `ProtectControlGroups=true`.

The deployed unit is not readable from the service context, so its exact live contents and drop-ins require administrator confirmation. The checked-in unit enables `NoNewPrivileges=true` and `RestrictSUIDSGID=true`, which may prevent the setuid mapping helpers required for multi-ID rootless Podman operation.

## Decision

Select **rootless Podman as the preferred candidate**, but do not approve or enable it for production until the actual service-context acceptance matrix passes. This ADR is deliberately not a claim that Podman currently works on the VPS.

The implementation must not fall back to rootful Docker/Podman, a rootful engine socket, Docker group membership, unrestricted sudo or broad capabilities. If rootless Podman cannot meet the isolation requirements under the existing systemd policy, evaluate a separately isolated, narrowly delegated service design or another rootless runtime in a new ADR. Do not weaken the current unit as an unreviewed workaround.

## Alternatives

- **Rootful Docker/Podman:** rejected due to daemon/socket privilege exposure and the risk of granting the MCP service host-root-equivalent control.
- **Rootless Buildah:** useful for image building but does not provide the complete container lifecycle and execution interface required by later issues.
- **Direct host process isolation:** rejected as the primary boundary; namespaces/cgroups/LSM orchestration would create a larger bespoke security surface.
- **Rootless Podman:** preferred candidate due to daemonless operation, mature OCI support and resource/security controls, subject to live proof.

## Consequences

- Runtime-dependent issues remain gated until this ADR is accepted.
- Administrator involvement is required for package installation, subordinate IDs and possibly service policy changes.
- The preflight and provisioning scripts are intentionally separate: one is safe to run as the service account, the other is explicitly privileged and does not edit systemd policy.
- A single-ID user namespace is not considered equivalent to the planned subordinate UID/GID mapping without an explicit threat-model and workspace-ownership review.
