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
3. Register the environment. Registration automatically reserves its profile resource vector through `resource.reserve`; inspect the returned reservation and capacity decision. If admission fails, the metadata record remains visible with a reservation error. Retry after capacity is freed, or submit a smaller bounded resource vector; the stored plan can be adjusted only after a capacity/disk admission failure and before any project service is active.
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


## Service profiles

Use project-environment.profile.list to inspect available versioned service profiles. The initial laravel-php version 1 profile describes PHP 8.4, Composer 2, Node 22, PHP-FPM, a queue worker, the scheduler, MySQL 8, optional Redis 7, health checks, project-owned mounts, resource defaults and backup scope.

This profile is currently definition-only. It has no approved immutable runtime image digest, so it is not eligible for provisioning. project-environment.register validates the profile ID and version, derives default resource values from the profile, and reserves those resources through the #36 resource-governance API. Registration does not build images, run migrations, create databases or start containers. Repeated registration is safe: an identical reservation is a no-op, including while its project service is running. A changed reservation is rejected while project-service workloads are active.

Migrations are disabled by default and seeders are disabled with an empty allowlist. Do not enable either until the deployment path proves that the target database is the repository's isolated development database. Production credentials and endpoints must never be available to profile hooks.
