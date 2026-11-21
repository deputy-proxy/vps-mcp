# Production auto-deployment

## Trigger and release gate

The `deploy-production` job is part of `.github/workflows/ci.yml` and runs only when all of the following are true:

- The workflow event is a `push`.
- The pushed ref is exactly `refs/heads/main`.
- The `quality` job has succeeded.
- The `production` GitHub Actions environment variable `VPS_PRODUCTION_DEPLOY_ENABLED` is exactly `true`.

Pull requests, `development` pushes and feature-branch pushes cannot run the production job. GitHub Actions serializes deployments with the `vps-mcp-production-deploy` concurrency group and does not cancel an active deployment.

The enable variable is deliberately opt-in. Create `VPS_PRODUCTION_DEPLOY_ENABLED` as a repository Actions variable (not an environment-level variable, because the job condition is evaluated before environment secrets are loaded). Do not set it to `true` until the VPS access and GitHub production environment configuration below are complete.

## One-time VPS provisioning

Create a dedicated Ed25519 key pair on a trusted administrator workstation. Keep the private key out of the VPS and out of the repository:

```bash
ssh-keygen -t ed25519 -C github-actions-vps-mcp-production -f ./vps-mcp-production-deploy -N ''
```

After this release has been merged to `main`, run the provisioning script from the production checkout on the VPS, passing only the public key:

```bash
cd /opt/vps-mcp
sudo bash scripts/provision-production-deploy-access.sh 'ssh-ed25519 AAAA... github-actions-vps-mcp-production'
```

The script:

- Creates the locked `vps-mcp-deploy` system account if it does not already exist with the expected home and shell.
- Installs root-owned fixed deployment and SSH gateway scripts under `/usr/local/libexec/vps-mcp/`.
- Installs a root-owned `authorized_keys` file with `restrict` and a forced command. The key cannot open a shell, allocate a PTY, forward ports or use SSH agent/X11 forwarding.
- Adds a sudoers policy allowing `vps-mcp-deploy` to invoke only the fixed Node deployment entry point as `vps-mcp`.
- Adds a sudoers policy allowing `vps-mcp` to run only `systemctl restart vps-mcp.service` as root.
- Validates the sudoers file with `visudo` before installing it.

It does not change the public service unit, production environment file, repository remote, firewall or SSH daemon configuration. It does not install a private key on the VPS.

The SSH gateway accepts only `deploy <full-commit-sha>`. It treats the SSH client command as data, validates the SHA and passes it through standard input. Arbitrary client commands are rejected.

## GitHub production environment

Create or update the repository's GitHub Actions environment named `production`.

Set repository Actions variable:

- `VPS_PRODUCTION_DEPLOY_ENABLED`: `true` only after the provisioning and validation steps below are complete.

Set `production` environment variables:

- `VPS_PRODUCTION_HOST`: the VPS DNS name or IP reachable from GitHub-hosted runners.
- `VPS_PRODUCTION_PORT`: SSH port, normally `22`.

Set environment secrets:

- `VPS_PRODUCTION_DEPLOY_KEY`: contents of the private key generated above.
- `VPS_PRODUCTION_KNOWN_HOSTS`: a verified known-hosts entry for the VPS SSH host key.

Do not use `StrictHostKeyChecking=no` or runtime `ssh-keyscan` as a trust substitute. Obtain the server host-key fingerprint from the VPS console:

```bash
sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

On a trusted workstation, collect the public host key and compare its fingerprint with the console value before saving it as the `VPS_PRODUCTION_KNOWN_HOSTS` secret:

```bash
ssh-keyscan -p YOUR_VPS_PRODUCTION_PORT -t ed25519 YOUR_VPS_HOST > vps-production-known-hosts
ssh-keygen -lf vps-production-known-hosts
```

The private deployment key belongs only in the GitHub `production` environment secret. Never commit it, paste it into an issue, or place it in `/etc/vps-mcp/vps-mcp.env`.

## Deployment behavior

The runner sends the exact `github.sha` for the successful main push. On the VPS, the deployment script:

1. Acquires an exclusive lock under `/var/lib/vps-mcp/`.
2. Verifies the production checkout is clean, on `main`, and points to the canonical `deputy-proxy/vps-mcp` origin.
3. Fetches `origin/main`. If the workflow SHA has been superseded by a newer main commit, it exits without changing files; the newer queued deployment handles the latest commit.
4. Requires the currently deployed commit to be an ancestor of the requested SHA and updates with `git pull --ff-only` only.
5. Runs `npm ci` and `npm run build` as the unprivileged `vps-mcp` account.
6. Restarts only `vps-mcp.service` through the narrowly scoped sudoers rule.
7. Verifies systemd reports the service active and `GET http://127.0.0.1:3000/mcp` returns the expected unauthenticated HTTP 401.

No production environment variables or tokens are passed to Git or npm by the deployment script. The service environment file is not read, rewritten or logged by the deployment workflow.

## Failure and rollback

If dependency installation, build, service restart or health verification fails after the checkout advances, the script resets the checkout to the previous commit, reinstalls dependencies, rebuilds and restarts the previous version. The workflow remains failed even when rollback succeeds, so the failed release is visible. If rollback also fails, the script reports that operator intervention is required.

The script refuses to deploy from a dirty checkout, a non-main branch, a non-canonical origin or a non-fast-forward history. It never runs `git clean` and never discards pre-existing local changes.

If the host is interrupted while deploying, inspect `/var/lib/vps-mcp/deploy-production.lock/pid` and verify that the recorded process is no longer running before removing a stale lock directory. Never remove the lock while a deployment process is active.

## First-run validation

Before enabling the workflow variable:

1. Confirm the deploy account, root-owned authorized key and sudoers file are installed.
2. Verify the public-key fingerprint matches the private key configured in GitHub.
3. Verify the SSH host key in `VPS_PRODUCTION_KNOWN_HOSTS` against the VPS console fingerprint.
4. Run the deployment workflow manually only after the workflow is merged, or perform a controlled test release to `main` after reviewing its changes.
5. Confirm the job logs show the exact deployed SHA, successful service restart and expected HTTP 401 health response.
6. Confirm a normal authenticated MCP client can still call tools.
7. Only then set `VPS_PRODUCTION_DEPLOY_ENABLED=true`.

## Scope boundary

This workflow deploys only the `vps-mcp` production checkout at `/opt/vps-mcp`. It does not deploy other managed repositories. A development deployment workflow is not configured here because its target checkout and runtime must be explicitly registered and verified before automation; do not infer a development target from a hostname or overwrite an existing checkout.
