# Repository registry operations

## Storage and configuration

The registry is stored at `$MCP_DATA_DIR/repositories/registry.json`; bare clones live in the sibling `cache/` directory. The service creates these directories with owner-only permissions. Ensure `MCP_DATA_DIR` is on persistent storage and writable by the `vps-mcp` service account. Do not place Git credentials in this directory or in repository metadata. For private repositories, configure a service-owned Git credential-helper executable using `REPOSITORY_GIT_CREDENTIAL_HELPER`; the helper must be executable, owned by root or the service account, and not group/world writable. The service does not inherit a user global Git config.

| Variable | Default | Purpose |
|---|---:|---|
| `REPOSITORY_DEV_HOST_SUFFIX` | `.dev.cr8or.be` | Suffix for derived development hostnames |
| `REPOSITORY_MAX_COUNT` | `250` | Configurable registry capacity |
| `REPOSITORY_MAX_CACHE_BYTES` | `21474836480` | Maximum bytes permitted for each bare cache (20 GiB) |
| `REPOSITORY_CACHE_STALE_AFTER_MS` | `604800000` | Age after which a cache is reported stale (7 days) |
| `REPOSITORY_GIT_CREDENTIAL_HELPER` | unset | Optional trusted Git credential-helper executable for private remotes |

A repository named `vps-mcp` derives `vps.mcp.dev.cr8or.be`. The hostname can be overridden at registration or with `repository.update`.

## Typical onboarding

1. Call `repository.register` with `https://github.com/<owner>/<repo>` and, optionally, the language/toolchain profile and policy references.
2. Review the returned canonical identity, derived hostname, discovered default branch and missing `main`/`development` branches.
3. Call `repository.inspect` or `repository.validate` to review the remote and cache health.
4. Call `repository.fetch` to create the persistent bare cache.
5. Register persistent project-environment paths and required backup paths with `repository.update`. Paths must be inside `MCP_ALLOWED_ROOTS`; this records deletion guards, it does not create or manage those resources.

The six initially active repositories are onboarded as ordinary records. There is no hardcoded cohort or repository count in application code.

## Fetch and branch policy

Fetch only updates the bare cache's remote-tracking refs and object database. It does not change a working tree, local branch, persistent environment or task sandbox. `main` remains the production branch and `development` remains the required integration branch, regardless of GitHub's default branch.

If either required branch is absent, registration/validation reports it. Do not use this feature to create or rename branches; issue #41 owns branch bootstrap and enforcement. If a remote becomes unreachable, resolve the network or Git credential problem for the service account and retry. Credentials must not be placed in remote URLs or issue comments.

## Safe cleanup

1. Call `repository.remove` with its default `dryRun=true` and review the reported cache and blockers.
2. Remove or formally retire linked worktrees and persistent environments through their owning workflows. Do not manually delete paths just to bypass a blocker.
3. Repeat the dry-run. Only when it reports no blockers, call `repository.remove` with `dryRun=false`.

The removal operation refuses when it finds linked worktrees, an existing registered persistent environment or an existing required backup. It removes the managed bare cache and metadata record only. It does not delete persistent environments, retained worktrees or backups.

## Recovery

- A missing cache can be recreated by `repository.fetch`.
- A corrupt cache is not automatically replaced; inspect and preserve it for recovery before taking corrective action.
- A corrupt or unsupported registry schema fails closed. Back up `registry.json` before manual repair or migration.
- Never edit `registry.json` while the service is running. Use the MCP tools so metadata locking and atomic replacement are applied.
