# Branch and release governance

## Branch model

Every managed repository has exactly two mandatory long-lived branches:

- `main`: production source.
- `development`: integration branch and source for the persistent VPS development environment.

Task branches must be created from `development` and merge back into `development`. The branch-policy service exposes `validateTaskBranchCreation`, which rejects any task branch whose base is not `development` or whose name is a protected long-lived branch. Task/worktree orchestration in issue #32 must call it before creating a workspace. The active ruleset separately prevents direct pushes to the long-lived branches. A release is promoted only by a pull request with `development` as head and `main` as base. A production hotfix may use a short-lived `hotfix/*` branch, but its PR must include a development-reconciliation plan and the fix must be reconciled into `development` immediately. Permanent third long-lived branches are not permitted.

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
- PRs from `main` or into branches other than `main`/`development` are rejected.

Any deployment job must declare the `production` or `development` GitHub Actions environment so deployment secrets are environment-scoped. A job using `production` must be triggered only by `main` and include a job-level `refs/heads/main` guard. A `development` environment must be triggered only by `development` and include a matching job-level guard. The workflow validator checks both the trigger filters and job guard to prevent cross-environment deployments.

The ruleset and CI validator are complementary: branch rulesets enforce server-side merge requirements, while the workflow validator enforces repository-specific PR direction and deployment wiring.
