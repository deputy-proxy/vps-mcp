# ADR-0001: Rootless container runtime for managed development sandboxes

- Status: **Proposed, blocked on administrator validation**
- Date: 2026-11-21
- Issue: [#30](https://github.com/deputy-proxy/vps-mcp/issues/30)

## Context

The development platform needs isolated containers for temporary task sandboxes and, later, persistent project services. The production VPS is Ubuntu 24.04.5, kernel 6.8, systemd 255 and cgroup v2. The public MCP process runs as unprivileged `vps-mcp` with an empty capability bounding set and hardened systemd restrictions. No container runtime or rootless helper packages were installed at inspection. Only `ubuntu:100000:65536` is present in `/etc/subuid` and `/etc/subgid`; no range is configured for `vps-mcp` or the proposed `vps-sandbox` identity. Kernel user-namespace sysctls are enabled, but an unprivileged user-namespace probe from the public MCP execution context fails with `Operation not permitted`. The live MCP service cgroup exposes only `memory` and `pids`, not `cpu`, and `cgroup.subtree_control` is not writable; the deployed unit has `Delegate=no` and `ProtectControlGroups=true`.

The administrator confirmed the public unit has `NoNewPrivileges=true`, `RestrictSUIDSGID=true`, `ProtectControlGroups=true`, an empty `CapabilityBoundingSet`, and no cgroup delegation. `NoNewPrivileges=true` blocks privilege gain by the setuid/file-capability mapping helpers. The empty capability bounding set also prevents those helpers from acquiring `CAP_SETUID`/`CAP_SETGID`. `RestrictSUIDSGID=true` only blocks creation of SUID/SGID file bits and can remain enabled.

## Decision

Select **rootless Podman as the preferred candidate**, but do not approve or enable it for production until the dedicated runtime-context acceptance matrix passes. This ADR is not a claim that Podman currently works on the VPS.

Do not weaken the public `vps-mcp.service`. Feasibility testing must use a dedicated non-login `vps-sandbox` identity and a separate transient systemd unit with `Delegate=cpu memory pids`, `ProtectControlGroups=no`, `NoNewPrivileges=no`, and `CapabilityBoundingSet=CAP_SETUID CAP_SETGID`, while retaining `RestrictSUIDSGID=yes`. Systemd 255 accepts only a boolean for `ProtectControlGroups`; it does not support the later `private` value. The test therefore leaves the cgroup mount writable only within a delegated unit and relies on `Delegate=` ownership: `vps-sandbox` may manage descendants below its own unit cgroup, while the host service manager retains ownership above it. This exposes the cgroup hierarchy for inspection, so the live test must verify that writes outside the delegated subtree are denied. These relaxed settings apply only to the transient test unit's process tree, never to the public MCP service.

The transient unit is a feasibility boundary, not automatically the final production runtime architecture. Issue #33 must define how the MCP API communicates with a separately managed runtime service and how the runtime identity is constrained. The implementation must not fall back to rootful Docker/Podman, a rootful engine socket, Docker group membership, unrestricted sudo or broad capabilities. If the dedicated rootless context cannot meet the isolation requirements, evaluate a more narrowly isolated service design or another rootless runtime in a new ADR. Do not weaken the public unit as an unreviewed workaround.

## Alternatives

- **Rootful Docker/Podman:** rejected due to daemon/socket privilege exposure and the risk of granting host-root-equivalent control.
- **Rootless Buildah:** useful for image building but does not provide the complete container lifecycle and execution interface required by later issues.
- **Direct host process isolation:** rejected as the primary boundary; bespoke namespace/cgroup/LSM orchestration would create a larger security surface.
- **Rootless Podman:** preferred candidate due to daemonless operation, mature OCI support and resource/security controls, subject to live proof.

## Consequences

- Runtime-dependent implementation remains gated until issue #30's live acceptance criteria pass.
- Administrator involvement is required for package installation, subordinate IDs and a dedicated transient systemd test unit.
- The preflight is read-only and must run as `vps-sandbox` inside that same transient unit; the administrator provisioning script is separate and does not edit the public MCP systemd policy.
- The MCP checkout is private to `vps-mcp`, so provisioning installs a read-only preflight copy under `/usr/local/libexec/vps-mcp/` for execution by `vps-sandbox`.
- A single-ID user namespace is not considered equivalent to the planned subordinate UID/GID mapping without an explicit threat-model and workspace-ownership review.
- Merging the feasibility/provisioning code does not close issue #30 or authorize runtime workloads; live host evidence is still required.
