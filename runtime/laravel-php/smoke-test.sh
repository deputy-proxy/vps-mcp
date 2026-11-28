#!/usr/bin/env bash
set -Eeuo pipefail

image="${1:?Usage: smoke-test.sh IMAGE}"
container="laravel-runtime-smoke-$$"
cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT

output="$(docker run --rm \
  --network=none \
  --read-only \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m \
  --entrypoint sh \
  "$image" -eu -c '
    test "$(id -u)" -ne 0
    php -v
    php -m
    composer --version --no-ansi
    node --version
    npm --version
    php-fpm -t
  ' 2>&1)"

printf '%s\n' "$output"
grep -Eq '^PHP 8\.4\.' <<<"$output"
grep -Eq '^Composer version 2\.' <<<"$output"
grep -Eq '^v22\.' <<<"$output"

for extension in bcmath exif gd intl mbstring PDO pdo_mysql redis 'Zend OPcache' pcntl sockets zip; do
  grep -Fxq "$extension" <<<"$output" || {
    printf 'Missing PHP extension: %s\n' "$extension" >&2
    exit 1
  }
done

docker run -d --name "$container" \
  --network=none \
  --read-only \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m \
  "$image" >/dev/null
sleep 2
test "$(docker inspect --format '{{.State.Running}}' "$container")" = true
docker exec "$container" php -r '$socket = @fsockopen("127.0.0.1", 9000, $errno, $error, 2); if (!$socket) { fwrite(STDERR, $error . "\\n"); exit(1); } fclose($socket);'
printf '%s\n' 'Laravel PHP runtime image smoke test passed.'
