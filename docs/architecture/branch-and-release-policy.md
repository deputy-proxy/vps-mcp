# Branch and release governance

## Branch model

Every managed repository has exactly two mandatory long-lived branches:

- `main`: production source.
- `development`: integration branch and source for the persistent VPS development environment.

Task branches must be created from `development` and merge back into `development`. The branch-policy service exposes `validateTaskBranchCreation`, which rejects any task branch whose base is not `development` or whose name is a protected long-lived branch. The `repository.task-branch.validate` MCP preflight exposes this check. Task/worktree orchestration in issue #32 must call the same `validateTaskBranchCreation` function before creating a branch or workspace; the preflight tool is not a substitute for enforcement inside that future mutation path. The active ruleset separately prevents direct pushes to the long-lived branches. A release is promoted only by a pull request with `development` as head and `main` as base. A production hotfix may use a short-lived `hotfix/*` branch, but its PR must include a development-reconciliation plan and the fix must be reconciled into `development` immediately. Permanent third long-lived branches are not permitted.

## GitHub ruleset

The managed ruleset is named `VPS managed branch governance` and targets exactly `refs/heads/main` and `refs/heads/development`. It is active and has no bypass actors. It enforces:

- Pull requests for changes to either protected branch.
- At least one approving review, with stale approvals dismissed when new commits are pushed.
- Strict required status checks. The configured contexts are stored per repository; the default is `quality`.
- No branch deletion.
- No non-fast-forward updates (force pushes).

The policy is additive. The apply operation does not overwrite an existing ruleset with the managed name. If a same-named ruleset exists but is not compliant, the operation stops for manual review. Missing branches are never created or repointed automatically.

## GitHub API access

`repository.branch-policy.inspect` reads active rules applying to each branch through GitHub's `GET /repos/{owner}/{repo}/rules/branches/{branch}` endpoint. Public repositories can be inspected without authentication. Private repositories require `REPOSITORY_GITHUB_TOKEN` with `Metadata: read`.

`repository.branch-policy.apply` creates the managed ruleset through GitHub's repository rulesets API. It is a dry run unless `confirm=true` is explicitly supplied. Applying requires `REPOSITORY_GITHUB_TOKEN` with `Administration: write`. The token is read from the service environment only and is never written to registry metadata or logs.

An unavailable API response is represented as `unavailable`, not as a compliant or unprotected result. `repository.validate` fails closed unless both required branches have verified active rulesets.

## Required status checks

`REPOSITORY_REQUIRED_STATUS_CHECKS` is a comma-separated list used as the default for new registry entries. Each repository can override its own list using `repository.register` or `repository.update`. Configure the exact GitHub check-run context, not the workflow display name. For this repository, the current CI job context is `quality`.

## CI and deployment separation

The CI workflow must run on pushes to and pull requests targeting both long-lived branches. `scripts/check-branch-policy.mjs` runs in CI and rejects incorrect pull-request direction:

- Task/feature branches target `development`.
- Release PRs use `development` → `main` and include a non-empty release summary.
- A `hotfix/*` PR to `main` must include a non-empty `Development reconciliation` section.
- A `fix/*` maintenance PR to `main` must include a non-empty `Development reconciliation` section; arbitrary feature branches remain prohibited from targeting `main`.
- Direct PRs from `main` are rejected. After a production promotion, reconcile `main` back into `development` through a `reconcile/*` PR with a non-empty `Main reconciliation` section. PRs into branches other than `main`/`development` are rejected.

Any deployment job must declare the `production` or `development` GitHub Actions environment so deployment secrets are environment-scoped. A production deployment must be gated by the successful `quality` job, a push-event check, an exact `refs/heads/main` guard, a serialized concurrency group, and the explicit repository Actions variable `VPS_PRODUCTION_DEPLOY_ENABLED == 'true'`. It is disabled until the host-side restricted SSH access and production environment secrets have been provisioned. Development deployment jobs, when configured, must use the `development` environment and an exact `development` branch guard. The workflow validator checks trigger filters, job guards, quality dependencies and concurrency to prevent cross-environment deployments.

The production deployment runs from the CI workflow after `quality` succeeds. It sends the exact pushed commit SHA over a dedicated SSH key whose `authorized_keys` entry forces a fixed gateway command. The gateway accepts only `deploy <40-character-sha>` and invokes one fixed root-owned deployment script through a single sudoers command. The script runs Git and the fixed systemd restart as root, but normalizes only `node_modules` and `dist` ownership and runs npm install/build as the unprivileged `vps-mcp` service account. The SSH account cannot obtain a shell, forward ports, use an agent or execute arbitrary commands. The deployment script verifies the clean `main` checkout and canonical origin, fetches the exact main ref, skips superseded workflow SHAs, performs a fast-forward only, installs locked dependencies, builds, restarts the service, and checks that the unauthenticated MCP endpoint returns the expected HTTP 401. Build or health-check failures trigger a best-effort rollback to the previous commit and rebuild. The deployment does not read, replace or print the production environment file.

The ruleset and CI validator are complementary: branch rulesets enforce server-side merge requirements, while the workflow validator enforces repository-specific PR direction and deployment wiring.
