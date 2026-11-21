# ADR-0001: Rootless container runtime for managed development sandboxes

- Status: **Proposed, blocked on administrator validation**
- Date: 2026-11-21
- Issue: [#30](https://github.com/deputy-proxy/vps-mcp/issues/30)

## Context

The sandbox platform needs per-task container isolation without a rootful container daemon or broad host privileges. The production VPS is Ubuntu 24.04.5, kernel 6.8, systemd 255 and cgroup v2. The MCP process runs as unprivileged `vps-mcp` with an empty capability bounding set and hardened systemd restrictions. No container runtime or rootless helper packages were installed at inspection. Only `ubuntu:100000:65536` is present in `/etc/subuid` and `/etc/subgid`; no range is configured for `vps-mcp`. Kernel user-namespace sysctls are enabled, but an unprivileged user-namespace probe from the MCP execution context fails with `Operation not permitted`. The live service cgroup exposes only `memory` and `pids`, not `cpu`, and `cgroup.subtree_control` is not writable by `vps-mcp`; the deployed unit has `Delegate=no` and `ProtectControlGroups=true`.

The administrator confirmed the deployed unit: `NoNewPrivileges=true`, `RestrictSUIDSGID=true`, `ProtectControlGroups=true`, empty `CapabilityBoundingSet`, and no cgroup delegation. `NoNewPrivileges=true` blocks privilege gain by the setuid/file-capability mapping helpers. The empty `CapabilityBoundingSet=` also prevents them from acquiring `CAP_SETUID`/`CAP_SETGID`. `RestrictSUIDSGID=true` only blocks creation of SUID/SGID file bits and can remain enabled.

## Decision

Select **rootless Podman as the preferred candidate**, but do not approve or enable it for production until the actual service-context acceptance matrix passes. This ADR is deliberately not a claim that Podman currently works on the VPS.

A controlled feasibility test may use a temporary systemd drop-in with `Delegate=cpu memory pids`, `ProtectControlGroups=private`, `NoNewPrivileges=false`, and `CapabilityBoundingSet=CAP_SETUID CAP_SETGID`, keeping `RestrictSUIDSGID=true` and the empty capability bounding set. This is not yet approved as the production policy because `NoNewPrivileges=false` and the two-capability bounding set apply to the entire service process tree. Evaluate a dedicated runtime service identity before enabling production workloads. The implementation must not fall back to rootful Docker/Podman, a rootful engine socket, Docker group membership, unrestricted sudo or broad capabilities. If rootless Podman cannot meet the isolation requirements under the existing systemd policy, evaluate a separately isolated, narrowly delegated service design or another rootless runtime in a new ADR. Do not weaken the current unit as an unreviewed workaround.

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
