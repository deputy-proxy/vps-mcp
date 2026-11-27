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

The project-service start operation now performs a bounded PHP-FPM TCP readiness check against 127.0.0.1:9000 from inside the container as UID/GID 10001. It retries transient startup failures and stops the container if readiness is not achieved. Runtime inspection refreshes the persisted health status. This code-level check is not yet live project-service acceptance evidence.

## Validation evidence and remaining approval gate

Candidate digest for immutable profile version 3 (version 2 is retained unchanged):

`ghcr.io/deputy-proxy/vps-mcp-laravel-php@sha256:10a7f5152d0bea6be3bde3ea3c6697154f20245128372833629a6d547e298b72`

Validated evidence:

1. PR #196 records the published immutable digest and the exact-digest image evidence.
2. The GHCR artifact includes a BuildKit SBOM (SPDX 2.3) and SLSA provenance resolving to development commit `b947b4b1e7215afcda5779a3a5ca0eab375b6d3a`.
3. The CI Trivy scan reported zero HIGH/CRITICAL findings.
4. The digest is pullable from GHCR; the VPS rootless runtime acceptance baseline passed 31/31 checks. This baseline does not exercise project-service provisioning.

This validates the image artifact for further review, not administrator approval of the digest or the profile for live provisioning. The profile remains `definition-only` until a disposable registered repository demonstrates broker-staged release/storage/cache/log mounts, project quota enforcement, PHP-FPM health, lifecycle/reboot recovery, and safe deprovisioning. Database provisioning/isolation, release build/migration orchestration, backup/restore and rollback also remain separate gates. Do not enable the profile or provision a project service until those checks pass. Never deploy by tag.