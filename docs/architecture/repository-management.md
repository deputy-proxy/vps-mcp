# Managed repository registry and clone cache

## Purpose and boundaries

The managed repository registry is the durable inventory of trusted GitHub repositories. It is deliberately separate from persistent application environments and temporary task sandboxes. A registry entry describes identity and policy; its bare clone cache stores Git objects and remote-tracking refs. Neither is an application checkout.

The registry is open-ended. `REPOSITORY_MAX_COUNT` and `REPOSITORY_MAX_CACHE_BYTES` are configurable resource guardrails, not compiled-in repository lists. The initial active repositories can be onboarded through `repository.register`; future repositories use the same operation without a code change.

## Data model and storage

Data is stored below `MCP_DATA_DIR/repositories/`:

- `registry.json`: schema-versioned metadata, atomically replaced and mode `0600`.
- `cache/<owner-repo>/`: bare Git clone for each canonical GitHub identity.
- `.registry-lock/` and repository-operation lock directories: cross-process filesystem locks.

Each record contains a stable ID, canonical GitHub full name and HTTPS remote, repository name, development hostname, bare cache path, discovered remote default branch, required `main` and `development` branch policy, language/toolchain profile, timestamps, last fetch, status, policy references and explicitly registered persistent-environment paths. No access token, password, credential helper output or other Git credential is written to registry metadata.

Schema version 0 metadata is migrated to version 1 under an atomic file replacement. Unknown future schema versions and malformed records fail closed rather than being silently overwritten.

## Identity and Git execution

Only credential-free HTTPS remotes on `github.com` identifying exactly one owner/repository are accepted. Local paths, `file:` URLs, other hosts, non-HTTPS schemes, embedded credentials, ports, query strings, fragments and extra path components are rejected. The canonical remote is stored as `https://github.com/<owner>/<repo>.git`; Git authentication is delegated to an optional service-owned executable implementing Git's credential-helper protocol (`REPOSITORY_GIT_CREDENTIAL_HELPER`). The helper path must be an absolute executable owned by root or the service account and not writable by group/other. No helper or global Git configuration is inherited implicitly. Credentials are never copied into metadata.

Git is invoked with an explicit working directory and argument arrays, never a shell command string. System/global Git configuration and inherited `GIT_*` overrides are disabled, terminal prompting is disabled, hooks are suppressed, and `file`/`ext` transport protocols are denied. Operations have bounded execution time and output. Errors are shortened and credential-shaped URL fragments are redacted.

## Branch policy

`main` is the production branch. `development` is the development integration branch. The GitHub default branch is discovered and recorded for information only; it is never treated as the development branch. Registration and validation inspect remote refs and report missing required branches. They do not create, rename, checkout, reset or delete branches. Branch governance is implemented by the dedicated ruleset policy in [branch and release policy](branch-and-release-policy.md).

## Cache lifecycle and worktree safety

Caches are bare repositories. Registration records metadata but does not clone. `repository.fetch` creates a bare clone on first use and subsequently fetches/prunes remote-tracking refs. Fetch never checks out, resets, cleans or writes a worktree. It does not rewrite a local branch; it only updates remote-tracking refs and the object database.

Registry metadata writes use an atomic temporary-file/rename pattern and a cross-process lock. Repository operations use repository-scoped locks so clone/fetch/removal for one repository cannot race. Fetch and removal are serialized for the same cache. Removal checks linked worktrees and registered persistent environments and refuses to proceed while either exists.

Removal defaults to dry-run. A real removal requires `dryRun=false`, and still refuses when retained worktrees or existing persistent-environment paths are recorded. It removes only the managed bare cache and registry entry; it never recursively deletes application environments or arbitrary worktrees.

## Health and capacity

Inspection reports remote reachability, default and required branches, missing required branches, cache existence/integrity/size, linked worktrees, registered persistent environments and cache-limit status. `REPOSITORY_MAX_COUNT` defaults to 250 entries. `REPOSITORY_MAX_CACHE_BYTES` defaults to 20 GiB per cache. `REPOSITORY_CACHE_STALE_AFTER_MS` defaults to seven days and marks never-fetched or overdue caches as stale. These limits can be raised deliberately as host capacity permits.

## MCP surface

- `repository.register`: validate identity, discover remote refs and persist metadata.
- `repository.list`: list all registered repositories.
- `repository.inspect`: inspect metadata, remote, cache and protection state.
- `repository.update`: update metadata and register persistent-environment paths.
- `repository.validate`: perform remote/cache/branch health validation.
- `repository.fetch`: clone or fetch the persistent bare cache.
- `repository.remove`: dry-run or safely remove a managed cache and registry record.
- `repository.branch-policy.inspect`: inspect active GitHub rulesets for `main` and `development`.
- `repository.branch-policy.apply`: dry-run or explicitly create the managed branch-governance ruleset.

These APIs are intentionally separate from the generic filesystem and terminal tools. Later repository onboarding, project-environment and task orchestration work can consume the typed registry service without embedding repository lists in MCP handlers.
