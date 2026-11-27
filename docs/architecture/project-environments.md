# Persistent project environments

## Purpose and boundaries

A project environment is the durable development application environment for one registered repository. It is not a task workspace, task sandbox, repository bare cache, or production deployment. Its only source branch is `development`; `main` and task feature branches are never deployment sources.

The project-environment manager owns application checkout/release state, service profiles, project-specific data directories, deployment history, health state, backup metadata, and lifecycle reconciliation. The rootless runtime remains the only component allowed to create and control containers. The public MCP process communicates with it through the typed runtime adapter and never receives Podman access.

## Identity and durable state

The canonical identity is the immutable managed repository ID. There is at most one environment record per repository ID. Records are stored beneath `$MCP_DATA_DIR/project-environments/<repository-id>/environment.json` with directory mode 0700 and file mode 0600. Writes use a same-directory temporary file, fsync where supported, and atomic rename. A cross-process repository-scoped lock serializes lifecycle and deployment mutations.

The record contains only non-secret metadata: schema version, repository ID/full name, source branch (the literal `development`), environment root, active and candidate release IDs, profile identifier/version, desired and observed lifecycle state, workload IDs, resource vector, health summary, deployment/backup history references, timestamps, and last reconciliation result. Credentials and environment variable values are never persisted in this record or logs.

Environment-owned data is separated by purpose: immutable release checkouts, shared project database data, uploads/storage, cache, logs, backups, and generated runtime configuration. Each repository receives distinct paths, database/schema and credentials, cache namespace, and service identity. Production data, credentials, storage and mounts are explicitly forbidden.

## Source and release model

The source is the registered repository's canonical Git remote and the `development` branch only. The manager fetches the bare repository cache, resolves the remote-tracking `development` commit, and creates a new immutable release checkout. It never checks out `main`, task branches, caller-provided refs, or arbitrary repository URLs.

A deployment follows prepare, validate, activate, verify, and commit phases. Build and dependency installation occur in a candidate release, not in the active checkout. Activation switches an environment-owned release pointer atomically. Health checks must pass before the candidate becomes the recorded active release. On failure, restore the previous pointer and preserve the failed release and sanitized diagnostics for investigation. Do not mutate an active release in place.

## Service profiles

The core model is profile-driven and framework-neutral. A versioned profile defines its runtime/toolchain, immutable image digest, web process, optional queue workers and scheduler, health checks, ports, resource defaults, persistent mount declarations, startup/restart policy, database/cache requirements, build and release hooks, migration/seeder policy, and backup/restore requirements.

The profile catalog is exposed through project-environment.profile.list. Profile IDs and versions are immutable contracts: changing behavior requires a new profile version. Callers receive copies of profile definitions; they cannot mutate the in-process catalog.

Laravel/PHP is the first profile family. Version 1 is an immutable, definition-only historical contract with no image digest, no queue worker and no scheduler. Version 2 is the historical candidate. Version 3 is the current candidate: it pins the validated PHP 8.4.28 / Composer 2.9.2 / Node 22.23.0 image and describes the currently implemented single PHP-FPM workload. Queue workers and the scheduler remain disabled because the project-service runtime currently provisions one web workload; the profile must not advertise processes the runtime cannot start or supervise.

Both versions remain definition-only. Version 2's image digest passed CI build, exact-digest smoke test and vulnerability scan, was pulled and inspected on the VPS, and the rootless runtime acceptance suite passed 31/31 checks. This validates the image artifact and rootless runtime foundation, not the complete project-service contract. Provisioning remains disabled pending disposable-project validation of broker-staged mounts, resource limits, PHP-FPM health, lifecycle recovery, and the still-unimplemented database/deployment/backup workflows.

The Laravel profile's storage and logs mounts are intentionally nested: the project storage bind is mounted first at `/app/storage`, then the isolated logs bind overlays `/app/storage/logs`. The cache mount is separate at `/app/bootstrap/cache`. The profile validator permits only this explicit storage/logs nesting and rejects duplicate targets or any other nested mount relationship. The runtime stages each source independently through the quota broker and verifies its repository/workload identity and mount options.

The runtime mount verifier resolves the mounted source against every canonical root in VPS_SANDBOX_PROJECT_ENV_ROOTS_JSON, not only the legacy single-root setting. Each configured root has a dedicated owner; the privileged quota broker selects the one root containing the repository and rejects missing or duplicate repository identities. The runtime accepts a mount only when its source matches exactly one configured root plus the expected repository, release and data path. The legacy VPS_SANDBOX_PROJECT_ENV_ROOT / VPS_SANDBOX_PROJECT_ENV_OWNER pair remains supported when no root map is configured.

The Laravel runtime image is built from digest-pinned PHP-FPM, Composer and Node.js upstream images. Its build and smoke-test contract lives in `runtime/laravel-php/`; CI scans the resulting image and publishes development builds with SBOM and provenance attestations. A published digest is not automatically sufficient to enable a project profile: the exact digest, runtime acceptance and project-service isolation/lifecycle evidence must all pass before a profile is marked deployable.

## Isolation and resource admission

Environment registration reserves CPU, memory, PIDs and disk through the #36 `resource.reserve` operation for the registered repository ID. The requested vector is the aggregate of the profile's PHP application vector plus every declared dependency vector (with explicitly supplied bounded overrides) and must fit both global and per-repository budgets plus the host disk safety margin. A reservation failure leaves the metadata record visible with a recorded error and no service may be provisioned; retrying registration retries the idempotent reservation. An identical reservation request is a no-op even while the project service is running. A changed reservation is rejected while project-service workloads are active. Each persistent project workload consumes its portion of the aggregate reservation rather than being charged twice. The PHP-FPM workload persists both its own effective resource vector and the aggregate reservation identity. Resource governance accounts dependency workloads, including stopped instances, in the same project envelope. Reservations are released only after the environment and all project workloads have been deprovisioned.

Each project gets private configuration, database/schema and credentials, storage/uploads, cache namespace and logs. Runtime mounts are explicit and project-scoped. Project services do not inherit task workspace mounts, task execution-log mounts, task egress proxy access, or task sandbox credentials. The project-service runtime creates a deterministic repository-specific Podman pod with `--network=none` and shares only its network namespace (`--share=net`) with project members. The pod uses its own infra container, no host network, and no published ports; PHP-FPM joins it without overriding `--network`. The namespace is loopback-only, so project members can use `127.0.0.1` while remaining isolated from other projects and the host. Dependency containers are not yet implemented and must join this same pod when added. A task sandbox uses a separate worktree and cannot mount or write any persistent project path.

Project-service start is not considered successful until the runtime verifies the declared PHP-FPM TCP health check at 127.0.0.1:9000 from inside the container as the non-root application user. The runtime retries within a bounded startup window and stops the project pod if health never becomes ready. Runtime inspection refreshes the persisted health observation; stopped or missing workloads are not reported as healthy.

## Lifecycle and recovery

Desired states are `provisioned`, `running`, `stopped`, and `deprovisioned`; observed states additionally include `starting`, `stopping`, `degraded`, `unknown`, and `error`. Mutations persist intent before calling the runtime and persist the observed result afterward. Operations are idempotent and keyed by stable environment/workload identity.

MCP startup and host reboot recovery reconcile environment records against runtime workload records. Persistent services use an explicit restart policy. Missing, unregistered, or identity-mismatched containers are not silently deleted or recreated; they produce an actionable degraded/unknown result. Task cleanup and ephemeral reaping must never stop, remove, or delete project environments, releases, databases, uploads, backups, or logs.

## Backups, migrations and rollback

Database migrations run only against the project's development database and only as part of a controlled deployment. Seeders are disabled by default and require an explicit profile-level allowlist; production targets are impossible by construction. Backups include database and project-owned persistent files, carry repository/environment identity and checksums, and are written outside the live data directories. Restore validates identity and backup integrity before replacing data, using a recoverable staging/rollback procedure.

A deployment rollback restores the prior immutable release and compatible runtime configuration. Data rollback is separate and requires an explicit restore operation; a code rollback must not silently roll back database data.

## Delivery gates

Do not enable broad onboarding or live provisioning until resource governance (#36) is accepted and the project-service runtime contract is verified. Host-level changes, service installation, reverse-proxy exposure, DNS and production-adjacent operations require explicit review and approval. All tests use disposable repositories and isolated development-only data.