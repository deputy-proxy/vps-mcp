# Branch governance operations

## Initial setup

1. Confirm `main` and `development` exist. `repository.register` and `repository.inspect` report missing branches but never create them. Verify the intended source history before any branch bootstrap and obtain explicit approval.
2. Confirm the required check context. For `vps-mcp`, the current CI job is `quality`. Set `REPOSITORY_REQUIRED_STATUS_CHECKS=quality` or set the repository-specific `requiredStatusChecks` metadata.
3. For public repositories, inspect rulesets without a token. For private repositories, configure `REPOSITORY_GITHUB_TOKEN` with `Metadata: read`.
4. Call `repository.branch-policy.inspect` and review both branches.
5. Call `repository.branch-policy.apply` with `confirm=false` (the default) to obtain a dry-run plan.
6. Review the plan. Then call `repository.branch-policy.apply` with `confirm=true`. The token must have `Administration: write` for the target repository.
7. Inspect again and run `repository.validate`. Do not treat an unavailable API result as a pass.

## Release promotion

- Feature/task PR: `feature-branch` → `development`.
- Release PR: `development` → `main`.
- Release PR descriptions must contain a non-empty `## Release summary`, `## Release notes`, or `## Summary` section.
- The required CI check must pass on the latest target-branch base (`strict_required_status_checks_policy=true`).
- Production hotfix exception: `hotfix/*` → `main`, with a non-empty `## Development reconciliation` section. Reconcile the fix to `development` immediately after production acceptance.
- Maintenance exception: `fix/*` → `main`, with a non-empty `## Development reconciliation` section describing how the maintenance change will be carried into `development`. This exception does not permit `feat/*` or arbitrary branches to target `main`.

## Deployment guardrails

- Deployment jobs must declare a GitHub Actions environment; store deployment credentials in environment-scoped secrets, not repository-level secrets. Development deployment jobs use the `development` environment, trigger only on `development`, and include a job-level `github.ref == 'refs/heads/development'` (or equivalent `github.ref_name`) condition.
- Production deployment jobs use the `production` environment, depend on the successful `quality` job, require a push event and exact `main` ref guard, and serialize deployments with `cancel-in-progress: false`.
- The `vps-mcp` production job additionally requires `VPS_PRODUCTION_DEPLOY_ENABLED == 'true'`. Leave this variable unset until the VPS restricted deployment access and GitHub environment secrets are provisioned and tested.
- Never make environment selection depend solely on a user-supplied input or an unvalidated branch name. The workflow validator rejects deployment jobs without an environment, quality gate, branch guard or concurrency control.
- `npm run check:branch-policy` parses all workflow YAML and fails on missing CI branch coverage or cross-environment deployment triggers/guards. It also validates the current GitHub pull-request event when run in Actions.

## Production auto-deployment

See [`production-deployment.md`](production-deployment.md) for the one-time VPS provisioning, SSH key setup, GitHub `production` environment configuration, deployment behavior, rollback and operational recovery. The workflow is intentionally disabled until its explicit enable variable is set.

## Development auto-deployment

See [`development-deployment.md`](development-deployment.md) for the isolated development runtime, WorkOS audience, DNS/TLS, restricted SSH deployment identity, GitHub `development` environment and rollback behavior. Pushes to `development` deploy only to the development service; production remains tied to `main`.

## Credential requirements

Use a fine-grained personal access token or GitHub App installation token, scoped only to repositories managed by this service:

- `Metadata: read` for private-repository ruleset inspection.
- `Administration: write` for ruleset creation.

Keep the token in the root-owned `/etc/vps-mcp/vps-mcp.env` file (or the deployment's equivalent secret environment), never in `.env.example`, Git URLs, registry metadata, issue comments or logs. The service must be restarted after changing its environment. Do not grant `Contents: write` or `Pull requests: write` solely for branch protection; this implementation does not create release PRs or push commits.

## Drift and remediation

Run `repository.branch-policy.inspect` periodically or during onboarding. A compliant result means both branches have all required active rules. A non-compliant result lists missing protections. An unavailable result means GitHub could not verify the rules and must be treated as unresolved. `repository.validate` also checks remote branch presence, bare-cache health, branch drift and branch governance.

If a same-named managed ruleset already exists but is not compliant, the apply operation refuses to overwrite it. Review its current settings and resolve the drift manually before retrying. If a required branch is missing, verify its source history and create it only through an explicitly approved GitHub operation.
