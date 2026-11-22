# Development deployment

The persistent VPS development environment is separate from production at every runtime boundary.

| Property | Development |
|---|---|
| Branch | `development` |
| Hostname | `vps.mcp.dev.cr8or.be` |
| MCP URL | `https://vps.mcp.dev.cr8or.be/mcp` |
| Checkout | `/opt/vps-mcp-development` |
| Service | `vps-mcp-development.service` |
| Listener | `127.0.0.1:3001` |
| Service account | `vps-mcp-development` |
| Data/config | `/var/lib/vps-mcp-development`, `/etc/vps-mcp-development` |
| Deployment identity | `vps-mcp-development-deploy` |

Production continues to use `main`, `/opt/vps-mcp`, `vps-mcp.service` and port 3000. Do not share deployment credentials, data directories, OAuth audiences or service accounts between the two environments.

## Prerequisites

1. Create an `A` record named `vps.mcp.dev` in `cr8or.be`, pointing to the VPS IPv4 address. Wait until the authoritative nameservers and public resolvers return the expected address.
2. In WorkOS AuthKit, add `https://vps.mcp.dev.cr8or.be/mcp` as a separate MCP resource indicator. Keep the same issuer as production, but issue tokens with this development URL in `aud`.
3. Confirm that the WorkOS authorization flow returns an access token with the exact development audience. A DNS record alone does not prove the AuthKit resource is configured correctly.

## Provision the runtime

From a clean checkout of the repository's `development` branch on the VPS, run:

```bash
sudo bash scripts/provision-development-runtime.sh
```

The script refuses to overwrite existing paths or services and checks that the development hostname resolves to the VPS address before changing the host. It creates a dedicated unprivileged service account, checkout, data directory, OAuth environment file, hardened systemd unit and Caddy site. It builds the application and verifies the local MCP endpoint returns the expected unauthenticated HTTP 401. It does not alter the production systemd unit or production Caddy sites.

Review the resulting service:

```bash
systemctl status vps-mcp-development.service --no-pager
journalctl -u vps-mcp-development.service -n 100 --no-pager
curl -i https://vps.mcp.dev.cr8or.be/mcp
```

Caddy obtains and renews the public certificate automatically after DNS is resolvable. The public MCP endpoint must present a publicly trusted certificate.

## Provision restricted deployment access

Generate a dedicated Ed25519 key pair on a trusted operator workstation. Do not reuse the production deployment key:

```bash
ssh-keygen -t ed25519 -f ./vps-mcp-development-deploy -C github-actions-vps-mcp-development
```

Run the following from the VPS repository checkout after the runtime has been provisioned:

```bash
sudo bash scripts/provision-development-deploy-access.sh 'ssh-ed25519 AAAA... your-key-comment'
```

The script installs a forced-command SSH key and a sudoers rule that permits only the root-owned development deployment runner. The deployment account is not granted a general shell, unrestricted sudo or membership in privileged groups.

Store the private key in the GitHub repository's **development environment** as `VPS_DEVELOPMENT_DEPLOY_KEY`. Configure these additional environment values:

- `VPS_DEVELOPMENT_HOST`: VPS SSH hostname or IP address.
- `VPS_DEVELOPMENT_PORT`: SSH port, normally `22`.
- `VPS_DEVELOPMENT_KNOWN_HOSTS`: verified SSH host-key entry for the VPS.

The workflow validates all values and deploys only the exact pushed commit SHA.

## Deployment behavior

- The development deployment job runs only after `quality` succeeds and only for a push to `refs/heads/development`.
- The GitHub Actions job uses the `development` environment and a dedicated non-cancelling concurrency group.
- The forced SSH command accepts only `deploy-development <full-commit-sha>`.
- The runner verifies the canonical remote, clean checkout, current branch and fast-forward ancestry. It skips superseded workflow commits.
- Dependencies are installed and the application is built as `vps-mcp-development`.
- The service is restarted and checked locally. The expected unauthenticated response is HTTP 401.
- On build, restart or health-check failure, the runner restores the previous commit, rebuilds it, restarts the service and repeats the health check. If rollback fails, operator intervention is required.

A deployment is not considered complete until the GitHub Actions job passes and the public endpoint is verified using a valid WorkOS token whose audience is the development resource indicator.
