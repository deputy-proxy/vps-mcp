# VPS-MCP Workload Runtime Threat Model

## 1. Scope and security objectives

This document covers the VPS-MCP rootless workload runtime, task sandboxes, managed worktrees, resource governance, cleanup, and restricted task egress.

The security objectives are:

1. Prevent task workloads from gaining control of the host or public MCP service.
2. Isolate repositories, worktrees, task sandboxes, and project-service workloads.
3. Prevent unauthorized access to host files, credentials, runtime sockets, and other workloads.
4. Enforce resource limits and preserve host capacity.
5. Restrict task network access to explicitly approved destinations.
6. Make lifecycle operations safe under retries, concurrency, and runtime interruption.
7. Preserve work and evidence during cleanup and recovery.
8. Record useful security and lifecycle events without recording secrets.

This is an operational threat model for the current implementation. It does not claim that every possible attack has been eliminated.

## 2. Assets to protect

| Asset | Security requirement |
|---|---|
| Host operating system and kernel | Task workloads must not gain host-level control |
| Public MCP service and its credentials | Must remain isolated from workload execution |
| Runtime agent and Unix socket | Accessible only to authorized local identities |
| Repository worktrees | Accessible only through their registered workload identity |
| Other repositories and project services | No cross-project or cross-workload access |
| Runtime and Podman storage | Protected from unauthorized access and uncontrolled exhaustion |
| Resource reservations and quota registry | Integrity and ownership must be preserved |
| Execution records, logs and audit data | Private, bounded and protected against cross-workload access |
| Network destinations | Private, loopback, link-local and metadata services must not be reachable from task workloads |
| Persistent project data | Must not be removed by task cleanup |

Credentials and deployment secrets must not be placed in task worktrees or supplied through task environment overrides. The runtime does not intentionally pass the public MCP service environment or registry credentials into task containers.

## 3. Actors and attacker capabilities

The threat model assumes the following potentially hostile actors:

- **Malicious repository content:** build scripts, package lifecycle scripts, tests, generated code and dependencies can execute arbitrary commands inside a task container.
- **Compromised task process:** a process inside a task container may attempt to escape its container, access another workload, exhaust resources or exfiltrate accessible data.
- **Untrusted tool caller:** an authenticated caller may submit malformed, repeated or conflicting lifecycle requests.
- **Malicious dependency or registry content:** downloaded packages and build tools may contain hostile code.
- **Unprivileged local host user:** may attempt to access runtime sockets, workload records or protected files.
- **Operator error:** an administrator may install an unsafe policy, broaden an allowlist, alter filesystem ownership or perform an unsafe cleanup.

The host administrator, kernel, systemd, Podman, nftables and the trusted runtime installation process are part of the trusted computing base. A compromise of host root or the kernel is outside the protection boundary of rootless containers.

## 4. Trust boundaries

### Public MCP API

The public MCP service authenticates tool callers and communicates with the runtime through a restricted Unix socket. It does not receive general Podman socket access or root privileges.

### Runtime agent

The runtime agent runs under the dedicated `vps-sandbox` identity. It validates operation schemas, workload records, immutable workload types, image digests, resource vectors and workspace identities before invoking Podman.

The runtime socket is owned by `vps-sandbox:vps-mcp` with mode `0660`. It is not a public network endpoint.

### Task container

Task containers run under rootless Podman with bounded resources, a read-only root filesystem, dropped capabilities, no-new-privileges, a configured seccomp profile and a restricted workspace mount.

A task container does not receive the host runtime socket, host PID/network namespace, arbitrary host paths or caller-selected Podman flags.

### Workspace and repository manager

A task workspace is selected from a registered repository/worktree identity. The runtime resolves and checks the path against configured workspace roots. Per-worktree ACLs grant access to the exact managed worktree rather than the entire workspace tree.

### Quota broker

The quota broker is a separate root-owned, socket-activated service. Its API accepts a repository ID, managed worktree UUID and bounded disk budget. It does not accept arbitrary paths or shell commands. The helper derives the managed path from approved roots and registry data.

### Egress proxy and firewall

Task containers use rootless `slirp4netns` networking and an explicitly configured HTTP proxy. Host nftables rules restrict the `vps-sandbox` identity to the loopback proxy. Squid applies the administrator-managed hostname allowlist and destination restrictions.

Project-service workloads remain on `network=none` until their separate private-routing design is implemented.

## 5. Threat scenarios and mitigations

### 5.1 Container escape or host compromise

**Threat:** Malicious task code exploits a container runtime, kernel or namespace vulnerability to access the host.

**Mitigations:**
- Rootless Podman under a dedicated non-login identity.
- No rootful Docker or Podman daemon.
- Dropped container capabilities and no-new-privileges.
- Read-only root filesystem and bounded tmpfs.
- Seccomp profile and private namespaces.
- No host PID/network namespace, runtime socket or arbitrary device passthrough.
- Hardened systemd service with bounded capabilities and delegated cgroups.
- Public `vps-mcp.service` hardening remains separate and unchanged.

**Residual risk:** Rootless containers share the host kernel. Kernel, Podman, crun, slirp4netns and seccomp vulnerabilities remain relevant. Runtime systemd device permissions are host-service permissions; they do not authorize device passthrough into task containers.

### 5.2 Workspace traversal and cross-repository access

**Threat:** A task caller or malicious process attempts path traversal, symlink escape or access to another repository's worktree.

**Mitigations:**
- Callers provide managed identifiers, not arbitrary host paths.
- The runtime resolves workspace paths and validates containment beneath approved roots.
- The task-workspace manager verifies repository/worktree registration and Git worktree linkage.
- Per-worktree ACLs restrict access to the assigned worktree.
- Filesystem operations use workspace-relative paths and reject traversal and unsupported file types.
- Workload records bind the sandbox to its repository and worktree identity.

**Residual risk:** Incorrect administrator configuration, host-level ACL changes or vulnerabilities in the trusted workspace manager could weaken this boundary.

### 5.3 SSRF, private-network access and direct egress

**Threat:** Malicious task code attempts to access loopback services, private networks, cloud metadata endpoints or arbitrary public destinations.

**Mitigations:**
- Task networking uses `slirp4netns:allow_host_loopback=true` only with the approved proxy profile.
- The runtime injects explicit proxy variables and disables Podman's automatic proxy injection.
- Host nftables rules permit the `vps-sandbox` UID to connect only to the loopback proxy and drop its other direct outbound sockets.
- Squid allows only exact administrator-approved hostnames.
- The proxy denies private, loopback, link-local and metadata destinations and restricts upstream ports to TCP 80/443.
- Project-service containers remain on `network=none`.

**Residual risk:** An approved hostname may serve malicious content or redirect application-level behavior. Allowlist changes require security review. The proxy and firewall are host-level trusted components.

### 5.4 Workspace disk exhaustion

**Threat:** A task writes excessive data to its workspace and exhausts host storage or affects other workloads.

**Mitigations:**
- Hard ext4 project quotas are applied to managed task worktrees before container creation.
- The default task workspace limit is 2 GiB.
- The quota broker fails closed if the required project-quota prerequisites are unavailable.
- The runtime disk watchdog provides additional monitoring and containment.
- Global and per-repository disk budgets and a host free-space reserve prevent unsafe new allocations.
- Disk pressure prioritizes stopping task containers and preserves persistent project services and worktree contents.

**Residual risk:** Hard quotas depend on the configured ext4 project-quota filesystem and correct provisioning. Podman image storage, caches, logs and other host storage are governed separately and are not covered by an individual worktree quota. Disk-pressure behavior still requires dedicated stress testing.

### 5.5 Resource exhaustion and concurrency races

**Threat:** Concurrent requests overcommit CPU, memory, PIDs or disk, corrupt lifecycle state or bypass cleanup protections.

**Mitigations:**
- Global, per-repository and per-workload resource budgets.
- Bounded active task count and operation concurrency.
- Durable locks for global, repository, worktree and workload resources.
- Stable lock acquisition order and bounded waits.
- Lock ownership includes PID, process-start identity and an ownership token.
- Lifecycle operations persist durable operation records and support idempotent retries.
- Startup recovery marks interrupted running operations as `unknown` rather than replaying them blindly.

**Residual risk:** The current live acceptance does not establish behavior under sustained production-scale contention. Dedicated concurrency and resource-pressure load tests remain required.

### 5.6 Unsafe cleanup or deletion of retained work

**Threat:** A cleanup operation removes persistent project services, dirty worktrees, retained work or state needed for recovery.

**Mitigations:**
- Automatic cleanup is disabled by default.
- Cleanup preview is read-only.
- Actual cleanup requires explicit confirmation.
- Cleanup removes eligible task containers, not Git worktrees or their contents.
- Project-service workloads, running/unknown orphan containers and retained work are protected.
- Cleanup rechecks eligibility under locks immediately before removal.
- Emergency pause blocks new work and suspends housekeeping.

**Residual risk:** Operators remain responsible for reviewing cleanup candidates and maintaining appropriate backups and retention policies.

### 5.7 Secret exposure and audit leakage

**Threat:** Task code or logs expose credentials, environment values or private host configuration.

**Mitigations:**
- The runtime does not copy the public MCP process environment into task containers.
- Task environment overrides are allowlisted.
- Registry credentials and host runtime sockets are not mounted into task containers.
- Audit records are private, bounded and redact common credential patterns.
- Command argument arrays and environment values are not stored in the audit log.

**Residual risk:** Secrets deliberately committed to a repository or written into an accessible worktree remain accessible to code running in that worktree. Redaction is defense in depth, not a guarantee that every possible secret format is recognized.

## 6. Resource and lifecycle safety controls

The runtime enforces CPU, memory, PID, active-task and disk reservation budgets before workload admission.

Mutating operations use durable locks and operation records. A retry with the same operation identity must not execute a completed operation again with different arguments. Interrupted operations are retained for inspection and reconciled from runtime state.

The reaper is conservative. It does not decide whether Git work is dirty or whether a worktree is safe to delete. Worktree lifecycle and retention remain owned by the repository/worktree manager.

## 7. Verification evidence and limitations

The following evidence was collected during VPS-07 implementation and live validation.

| Control | Evidence | Status |
|---|---|---|
| Automated tests | `npm test`: 25 test files, 199 tests passed in the final local validation | Passed |
| TypeScript validation | `npm run typecheck` | Passed |
| Production compilation | `npm run build` | Passed |
| Earlier CI implementation | PR #120 CI completed successfully; 36 test files and 287 tests passed in that PR's validation | Passed for PR #120 |
| Runtime startup recovery | Runtime activated successfully after deployment and returned `resource.inspect` | Passed |
| Storage reporting | Podman images, containers and volumes reported; no scan warnings | Passed |
| Removed workspace handling | Removed workspaces excluded from storage scans | Passed |
| Project quota configuration | ext4 project quotas enabled; test and production project IDs visible in project quota reports | Configuration verified |
| Egress allowlist | Host proxy request to `registry.npmjs.org` returned HTTP 200 | Passed |
| Egress denial | Non-allowlisted public host and private destination denied by proxy | Passed |
| Direct egress | Direct DNS and direct public-IP connection attempts from the sandbox identity blocked | Passed |
| Container proxy policy | Container CONNECT test allowed the registry and denied a non-allowlisted hostname | Passed |
| Cleanup safety | Live cleanup preview returned no candidates, skipped items or orphan containers | Preview verified |
| Hard quota overflow | A controlled write beyond the 2 GiB limit returning `ENOSPC` has not yet been recorded as completed acceptance evidence | Outstanding |
| Sustained concurrency/load | Production-scale concurrent workload and contention stress test has not yet been recorded | Outstanding |
| Disk-pressure recovery | Controlled host disk-pressure exercise has not yet been recorded | Outstanding |
| Full container TLS test | The BusyBox test client did not support the required proxy behavior; a full TLS handshake from inside the container remains outstanding | Outstanding |

The live runtime inspection at the time of validation reported zero active tasks, zero active project services, zero resource usage, no disk pressure and no storage scan warnings. These observations are point-in-time evidence, not a substitute for load testing.

## 8. Operational assumptions and residual risks

- Host root, kernel, systemd, Podman and the installed firewall/proxy configuration are trusted.
- The administrator-managed image allowlist and egress hostname allowlist require review.
- Hard workspace quotas require the approved ext4 project-quota configuration.
- Container and image storage require separate capacity monitoring.
- No task should receive credentials merely because it belongs to a trusted repository.
- Project-service network routing and persistent-service acceptance are separate work and must not inherit task egress assumptions.
- Security controls must be revalidated after changes to the runtime identity, systemd units, filesystem mounts, Podman, proxy, nftables or workspace roots.

## 9. Change and incident procedure

For a suspected runtime or isolation incident:

1. Activate `sandbox.maintenance.pause`.
2. Preserve workload records, operation records, audit logs, execution logs and workspace contents.
3. Inspect runtime, proxy, firewall and quota-broker service state.
4. Review audit events and cleanup preview.
5. Do not delete unexplained containers, records or worktrees.
6. Revoke or narrow the affected image or egress allowlist entry.
7. Restore service only after the affected boundary has been verified.
8. Record the incident, evidence and any policy changes.

Changes to privileged host configuration require explicit review, recorded evidence and a rollback procedure.
