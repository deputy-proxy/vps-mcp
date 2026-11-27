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
3. Register the environment. Registration automatically reserves the aggregate profile resource vector, including application and declared dependency budgets, through `resource.reserve`; inspect the returned reservation and capacity decision. If admission fails, the metadata record remains visible with a reservation error. Retry after capacity is freed, or retry with the profile's minimum aggregate vector or adjust the versioned component budgets; the stored plan can be adjusted only after a capacity/disk admission failure and before any project service is active.
4. Provision isolated project directories and development-only database/cache credentials.
5. Resolve the current remote `development` commit and prepare an immutable candidate release.
6. Build and validate the candidate release without changing the active release.
7. Activate atomically, start the declared services, and run profile health checks.
8. Commit the release only after health checks pass; otherwise restore the previous release pointer.
9. Reconcile desired and observed state after MCP restart and host reboot.

## Data and credentials

Environment records contain metadata only. Store secrets in a dedicated protected secret mechanism with least-privilege access; never write secret values to repository metadata, release manifests, logs, audit events, backups manifests, or tool responses. Use separate database credentials and storage paths for every project. Backups must be encrypted or stored in an equivalently protected location and must never share production credentials.

After starting a Laravel project service, verify that the runtime reports health.status=healthy with the php-fpm check. The runtime probes 127.0.0.1:9000 inside the container as UID/GID 10001, retries for a bounded startup window, and stops the project pod if the service never becomes healthy. The PHP-FPM container joins a repository-specific Podman pod whose network namespace is `none`; only the pod's network namespace is shared, with no host network or published ports. Re-run runtime inspection to refresh the persisted health observation.

## Recovery and retirement

Inspect status and health before restart or restore. Preserve unknown workloads and data for operator review. An explicit provisioning retry may reconcile an `unknown` project-service record only after the runtime verifies that no container exists by workload identity or deterministic name and the repository-private pod is empty; it removes only the stale runtime record and broker-staged mounts, never the persistent project release or data directories. Boot recovery itself continues to leave unknown workloads for operator review. Stop services before backup restore. Verify backup identity and checksums, restore into staging, and switch only after validation. Deprovisioning must stop/remove project-service workloads, preserve or explicitly retire backups and data, remove registered environment paths only after verification, and release resource reservations last.

## Acceptance evidence

Record the disposable repository identity, development commit SHA, profile version, reserved resource vector, isolated data paths (not secret values), deployment/rollback result, health results, restart/reboot recovery results, and proof that task cleanup did not affect the persistent environment.


## Service profiles

Use project-environment.profile.list to inspect available versioned service profiles. `laravel-php` version 1 is retained as an immutable definition-only contract. Version 2 is the original immutable candidate profile. Version 3 is the refreshed image candidate: PHP 8.4.28, Composer 2.9.2, Node 22.23.0 and one PHP-FPM web workload. Queue workers and scheduler are intentionally disabled until multi-process project-service supervision is implemented.

Version 3 pins `ghcr.io/deputy-proxy/vps-mcp-laravel-php@sha256:10a7f5152d0bea6be3bde3ea3c6697154f20245128372833629a6d547e298b72`; version 2 remains unchanged with its original digest. PR #196 records the published immutable digest, BuildKit SBOM (SPDX 2.3), SLSA provenance resolving to development commit `b947b4b1e7215afcda5779a3a5ca0eab375b6d3a`, and a Trivy result with zero HIGH/CRITICAL findings. The digest is pullable from GHCR. The 31/31 rootless runtime acceptance result validates the runtime foundation, not the project-service contract. This is artifact evidence only, not administrator approval or authorization to provision. Version 3 remains definition-only and project-environment.register must not be used to provision a live service until the remaining project-service acceptance gates pass.

The storage/logs mounts are deliberately nested. The storage mount is applied first at `/app/storage`; the dedicated project logs mount overlays `/app/storage/logs`. Cache is mounted separately at `/app/bootstrap/cache`. Do not reorder or collapse these mounts without changing the profile contract and its tests.

For installations with separate production and development service accounts, configure the same VPS_SANDBOX_PROJECT_ENV_ROOTS_JSON root/owner map in the runtime and each MCP service environment. The quota broker must forward that map to its privileged helper. The broker selects exactly one root containing the repository and enforces its configured owner; the runtime verifies every staged mount source against the complete configured root list. Keep the legacy single-root variables only for installations that do not use a root map.

On this VPS, the target root map is /var/lib/vps-mcp/project-environments owned by vps-mcp and /var/lib/vps-mcp-development/project-environments owned by vps-mcp-development. Review the host configuration with sudo bash scripts/configure-development-project-environment-root.sh (dry-run). Applying it requires explicit operator approval: sudo bash scripts/configure-development-project-environment-root.sh --apply. The script preserves existing root contents and environment-file ownership/modes, refuses non-canonical roots or unexpected directory ownership/permissions, and refuses to run while rootless containers are active. It writes the same root map to both MCP service environment files and the rootless runtime environment, reinstalls the merged runtime/quota-broker files, and restarts the production and development MCP services. It does not create or start a project workload. Run the rootless acceptance suite and inspect the registered project environment after the restart; do not promote the Laravel profile as part of this operation.

`project-environment.register` validates the profile ID and version, derives the aggregate resource vector by summing the application and declared dependency budgets, and reserves it through the #36 resource-governance API. The application container retains its own smaller vector; it does not receive the dependency capacity as extra limits. Registration does not build images, run migrations, create databases or start containers. Provisioning creates a repository-specific no-egress Podman pod; the current profile still contains only PHP-FPM, and MySQL/Redis dependency workloads remain blocked on the #215 implementation and approved immutable image digests. Repeated registration is safe: an identical reservation is a no-op, including while its project service is running. A changed reservation is rejected while project-service workloads are active. An existing environment may move to a new profile version only with an explicit version and complete aggregate resource vector, and only when it has no registered workloads; this metadata-only upgrade preserves its release and data directories. See `runtime/laravel-php/README.md` for the exact pinned inputs and validation evidence.

Migrations are disabled by default and seeders are disabled with an empty allowlist. Do not enable either until the deployment path proves that the target database is the repository's isolated development database. Production credentials and endpoints must never be available to profile hooks.

### Disposable project-service acceptance profile

The project-service-acceptance@1 profile exists only to exercise the persistent PHP-FPM project-service runtime on the registered disposable repository deputy-proxy/toti-invatam-org (deputy-proxy-toti-invatam-org-44fadec4d6). It uses the exact approved immutable #187 PHP runtime image, has no MySQL/Redis dependencies, performs no build, migration or seeding, and is rejected for every other repository ID. It does not change the readiness of laravel-php@1, @2 or @3; those remain definition-only until the dependency/network and full runtime gates are accepted. Do not use this profile for application hosting.
