# Laravel PHP runtime image

This is the first immutable runtime image for the `laravel-php` project service profile.

## Contract

- Target platform: `linux/amd64` (the current VPS host architecture).
- PHP: 8.4.28 with FPM and the Laravel extensions listed in `smoke-test.sh`.
- Composer: 2.9.2.
- Node.js: 22.23.0 and npm 12.2.3 (installed at an exact version to replace vulnerable npm-bundled dependencies).
- Default image user: UID/GID 10001 (`app`), never root.
- FPM listens on TCP port 9000 and writes diagnostics to stderr.
- Runtime containers must use a read-only root filesystem, no network by default, all capabilities dropped, `no-new-privileges`, bounded tmpfs, and explicit project-owned writable mounts.

## Pinned upstream inputs

All upstream references are amd64 manifest digests, not mutable tags:

| Component | Version | Immutable reference |
| --- | --- | --- |
| PHP-FPM base | 8.4.28, Debian Bookworm | `docker.io/library/php:8.4.28-fpm-bookworm@sha256:1472c4a0440979669c27e93c6f60f80107cf49e285d326780f29bedd5393501b` |
| Composer | 2.9.2 | `docker.io/library/composer:2.9.2@sha256:ebf71d99335126039325670627d3168fba3a1678e97740e9fbda69525f2831bf` |
| Node.js | 22.23.0, Debian Bookworm slim | `docker.io/library/node:22.23.0-bookworm-slim@sha256:dc73bdac873c82e6cbfa496e35dd6e27a20302ebba043d0d9646708df19a9996` |

The image is multi-stage. PHP extensions are compiled in a build stage; the final stage contains only the runtime libraries, PHP-FPM, Composer, Node/npm, Git and unzip. Upstream image inputs and npm are version-pinned. Debian Bookworm packages are resolved from the Bookworm repositories at build time, so the immutable digest emitted by CI is the artifact identity; do not assume a later rebuild from the same Dockerfile will produce the same digest.

## Build and validate locally

From the repository root:

```sh
docker build --pull -f runtime/laravel-php/Dockerfile -t vps-mcp/laravel-php:local .
runtime/laravel-php/smoke-test.sh vps-mcp/laravel-php:local
```

The smoke test runs without network access, with a read-only root filesystem, all capabilities dropped, `no-new-privileges`, and a bounded `/tmp` tmpfs. It verifies non-root execution, PHP/extensions, Composer, Node/npm and FPM configuration.

CI also scans the built image for unfixed-excluded high and critical vulnerabilities. A successful push to `development` publishes a commit-tagged image to GHCR with BuildKit SBOM and provenance attestations. The workflow summary records the resulting immutable digest.

## Approval and deployment gate

A published digest is evidence, not automatic approval. Do not add it to `src/service-profiles.ts`, allow it in the host runtime image allowlist, or enable the profile until:

1. The exact digest is captured from a successful CI publish.
2. SBOM and provenance are retained and inspected.
3. Vulnerability results are reviewed.
4. The image passes the rootless runtime acceptance suite on the VPS.
5. The project-service mount, dependency-network and resource-isolation contracts are accepted.

The profile therefore remains `definition-only` during this image-build milestone. Never deploy by tag.