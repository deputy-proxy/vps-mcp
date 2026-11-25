# Persistent project environment operations

## Safety gates

- Confirm the repository is registered and branch governance is compliant.
- Confirm the canonical remote has a `development` branch.
- Inspect resource capacity and reserve the planned CPU, memory, PID and disk vector before provisioning.
- Use a disposable repository for acceptance tests. Never use production credentials, databases, storage, uploads, or secrets.
- Do not expose a service publicly until its authenticated development route and network policy have been reviewed.
- Never run a migration or seeder against production.

## Intended lifecycle

1. Register and validate the repository; fetch its bare cache.
2. Select an approved, versioned service profile.
3. Reserve project resources with `resource.reserve`.
4. Provision isolated project directories and development-only database/cache credentials.
5. Resolve the current remote `development` commit and prepare an immutable candidate release.
6. Build and validate the candidate release without changing the active release.
7. Activate atomically, start the declared services, and run profile health checks.
8. Commit the release only after health checks pass; otherwise restore the previous release pointer.
9. Reconcile desired and observed state after MCP restart and host reboot.

## Data and credentials

Environment records contain metadata only. Store secrets in a dedicated protected secret mechanism with least-privilege access; never write secret values to repository metadata, release manifests, logs, audit events, backups manifests, or tool responses. Use separate database credentials and storage paths for every project. Backups must be encrypted or stored in an equivalently protected location and must never share production credentials.

## Recovery and retirement

Inspect status and health before restart or restore. Preserve unknown workloads and data for operator review. Stop services before backup restore. Verify backup identity and checksums, restore into staging, and switch only after validation. Deprovisioning must stop/remove project-service workloads, preserve or explicitly retire backups and data, remove registered environment paths only after verification, and release resource reservations last.

## Acceptance evidence

Record the disposable repository identity, development commit SHA, profile version, reserved resource vector, isolated data paths (not secret values), deployment/rollback result, health results, restart/reboot recovery results, and proof that task cleanup did not affect the persistent environment.
