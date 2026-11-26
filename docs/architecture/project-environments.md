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

Laravel/PHP is the first profile family (laravel-php, version 1). It describes PHP 8.4, Composer 2 and Node 22, PHP-FPM, a queue worker, the Laravel scheduler, MySQL 8, optional Redis 7, project-scoped storage/cache/log mounts, conservative resource defaults, disabled migrations and disabled seeders. Laravel-specific behavior belongs in this profile implementation, not in the core environment identity, persistence, locking, source, or lifecycle model.

The initial Laravel profile is deliberately definition-only: no trusted immutable runtime image digest has been selected and validated yet. It can be inspected and used to create metadata records with reserved capacity, but it cannot be provisioned. A profile is eligible for provisioning only after it is marked deployable and pins an immutable sha256 image digest. Unknown, incomplete or definition-only profiles fail closed.

## Isolation and resource admission

Environment registration reserves CPU, memory, PIDs and disk through the #36 `resource.reserve` operation for the registered repository ID. The requested vector is derived from the selected profile (with explicitly supplied bounded overrides) and must fit both global and per-repository budgets plus the host disk safety margin. A reservation failure leaves the metadata record visible with a recorded error and no service may be provisioned; retrying registration retries the idempotent reservation. An identical reservation request is a no-op even while the project service is running. A changed reservation is rejected while project-service workloads are active. A project-service workload consumes its reservation rather than being charged twice. Reservations are released only after the environment and all project-service workloads have been deprovisioned.

Each project gets private configuration, database/schema and credentials, storage/uploads, cache namespace and logs. Runtime mounts are explicit and project-scoped. Project services do not inherit task workspace mounts, task execution-log mounts, task egress proxy access, or task sandbox credentials. A task sandbox uses a separate worktree and cannot mount or write any persistent project path.

## Lifecycle and recovery

Desired states are `provisioned`, `running`, `stopped`, and `deprovisioned`; observed states additionally include `starting`, `stopping`, `degraded`, `unknown`, and `error`. Mutations persist intent before calling the runtime and persist the observed result afterward. Operations are idempotent and keyed by stable environment/workload identity.

MCP startup and host reboot recovery reconcile environment records against runtime workload records. Persistent services use an explicit restart policy. Missing, unregistered, or identity-mismatched containers are not silently deleted or recreated; they produce an actionable degraded/unknown result. Task cleanup and ephemeral reaping must never stop, remove, or delete project environments, releases, databases, uploads, backups, or logs.

## Backups, migrations and rollback

Database migrations run only against the project's development database and only as part of a controlled deployment. Seeders are disabled by default and require an explicit profile-level allowlist; production targets are impossible by construction. Backups include database and project-owned persistent files, carry repository/environment identity and checksums, and are written outside the live data directories. Restore validates identity and backup integrity before replacing data, using a recoverable staging/rollback procedure.

A deployment rollback restores the prior immutable release and compatible runtime configuration. Data rollback is separate and requires an explicit restore operation; a code rollback must not silently roll back database data.

## Delivery gates

Do not enable broad onboarding or live provisioning until resource governance (#36) is accepted and the project-service runtime contract is verified. Host-level changes, service installation, reverse-proxy exposure, DNS and production-adjacent operations require explicit review and approval. All tests use disposable repositories and isolated development-only data.
