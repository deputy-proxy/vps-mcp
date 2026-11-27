# Persistent project environment operations

## Safety gates

- Confirm the repository is registered and branch governance is compliant.
- Confirm the canonical remote has a `development` branch.
- Inspect resource capacity and reserve the planned CPU, memory, PID and disk vector before provisioning.
- Use a disposable repository for acceptance tests. Never use production credentials, databases, storage, uploads, or secrets.
- Do not expose a service publicly until its authenticated development route and network policy have been reviewed.
- Never run a migration or seeder against production.

## Promotion authorization

The project-environment.profile.promote tool is gated independently from ordinary MCP access. Set VPS_SERVICE_PROFILE_PROMOTION_ENABLED=true to enable the operation. For OAuth authentication, the verified access token must also contain the exact vps:admin scope. After the authorization provider is configured to grant vps:admin only to administrators, advertise it through OAUTH_SUPPORTED_SCOPES. Do not add it to OAUTH_REQUIRED_SCOPES; ordinary MCP operations must not require administrator privileges. The MCP authentication middleware passes only verified token metadata to tool handlers. Never trust scope values supplied in tool arguments or unverified request headers.

Promotion changes profile readiness only. It does not provision, start, or deploy a project workload. Keep the feature flag disabled until the disposable-project acceptance plan is ready.

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

After starting a Laravel project service, verify that the runtime reports health.status=healthy with the php-fpm check. The runtime probes 127.0.0.1:9000 inside the container as UID/GID 10001, retries for a bounded startup window, and stops a service that never becomes healthy. Re-run runtime inspection to refresh the persisted health observation.

## Recovery and retirement

Inspect status and health before restart or restore. Preserve unknown workloads and data for operator review. Stop services before backup restore. Verify backup identity and checksums, restore into staging, and switch only after validation. Deprovisioning must stop/remove project-service workloads, preserve or explicitly retire backups and data, remove registered environment paths only after verification, and release resource reservations last.

## Acceptance evidence

Record the disposable repository identity, development commit SHA, profile version, reserved resource vector, isolated data paths (not secret values), deployment/rollback result, health results, restart/reboot recovery results, and proof that task cleanup did not affect the persistent environment.


## Service profiles

Use project-environment.profile.list to inspect available versioned service profiles. `laravel-php` version 1 is retained as an immutable definition-only contract. Version 2 is the candidate profile: PHP 8.4.28, Composer 2.9.2, Node 22.23.0 and one PHP-FPM web workload. Queue workers and scheduler are intentionally disabled until multi-process project-service supervision is implemented.

Version 2 pins `ghcr.io/deputy-proxy/vps-mcp-laravel-php@sha256:07022280f3b8e1a1be9abed133870af82a85912d78e4300144b1a3e38933a9da`. CI run 45894579996 built, smoke-tested and scanned the exact published digest successfully; the publish job recorded SBOM and provenance. On the VPS, the digest was pulled and inspected successfully, and the rootless runtime acceptance suite passed 31/31. This is image/runtime validation only. Version 2 remains definition-only and project-environment.register must not be used to provision a live service until the remaining project-service acceptance gates pass.

The storage/logs mounts are deliberately nested. The storage mount is applied first at `/app/storage`; the dedicated project logs mount overlays `/app/storage/logs`. Cache is mounted separately at `/app/bootstrap/cache`. Do not reorder or collapse these mounts without changing the profile contract and its tests.

`project-environment.register` validates the profile ID and version, derives default resource values from the profile, and reserves those resources through the #36 resource-governance API. Registration does not build images, run migrations, create databases or start containers. Repeated registration is safe: an identical reservation is a no-op, including while its project service is running. A changed reservation is rejected while project-service workloads are active. See `runtime/laravel-php/README.md` for the exact pinned inputs and validation evidence.

Migrations are disabled by default and seeders are disabled with an empty allowlist. Do not enable either until the deployment path proves that the target database is the repository's isolated development database. Production credentials and endpoints must never be available to profile hooks.