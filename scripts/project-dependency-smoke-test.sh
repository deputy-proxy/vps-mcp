#!/usr/bin/env bash
set -euo pipefail

MYSQL_IMAGE="${1:?usage: project-dependency-smoke-test.sh MYSQL_IMAGE REDIS_IMAGE}"
REDIS_IMAGE="${2:?usage: project-dependency-smoke-test.sh MYSQL_IMAGE REDIS_IMAGE}"
TMP_DIR="$(mktemp -d)"
MYSQL_NAME="vps-mcp-ci-mysql-$$"
REDIS_NAME="vps-mcp-ci-redis-$$"
cleanup() {
  docker rm -f "$MYSQL_NAME" "$REDIS_NAME" >/dev/null 2>&1 || true
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

chown_for_container() {
  if [[ "$(id -u)" -eq 0 ]]; then
    chown 65532:65532 "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo chown 65532:65532 "$@"
  else
    echo 'Changing secret-file ownership requires root or sudo' >&2
    return 1
  fi
}

mkdir -m 0700 \
  "$TMP_DIR/mysql-runtime-secrets" \
  "$TMP_DIR/mysql-client-secrets" \
  "$TMP_DIR/redis-runtime-secrets"
MYSQL_ROOT_PASSWORD="$(openssl rand -base64 36 | tr -d '\n')"
MYSQL_APP_PASSWORD="$(openssl rand -base64 36 | tr -d '\n')"
REDIS_APP_PASSWORD="$(openssl rand -base64 36 | tr -d '\n')"
printf '%s\n' "$MYSQL_ROOT_PASSWORD" > "$TMP_DIR/mysql-runtime-secrets/mysql-root-password"
cat > "$TMP_DIR/mysql-runtime-secrets/mysql-root.cnf" <<EOF_MYSQL_ROOT
[client]
user=root
password=$MYSQL_ROOT_PASSWORD
host=127.0.0.1
protocol=TCP
EOF_MYSQL_ROOT
cat > "$TMP_DIR/mysql-client-secrets/mysql-app.cnf" <<EOF_MYSQL_APP
[client]
user=app
password=$MYSQL_APP_PASSWORD
host=127.0.0.1
protocol=TCP
EOF_MYSQL_APP
chmod 0440 "$TMP_DIR/mysql-runtime-secrets/"* "$TMP_DIR/mysql-client-secrets/"*
chown_for_container "$TMP_DIR/mysql-runtime-secrets/"* "$TMP_DIR/mysql-client-secrets/"*

# Exercise the DHI entrypoint contract: only MYSQL_ROOT_PASSWORD_FILE and an
# explicit mysqld command are supplied. The server never receives app credentials.
docker run --detach --name "$MYSQL_NAME" --network none --read-only \
  --cap-drop ALL --security-opt no-new-privileges:true --pids-limit 128 \
  --memory 768m --cpus 0.5 \
  --tmpfs /var/lib/mysql:rw,nosuid,nodev,size=512m,uid=65532,gid=65532,mode=0700 \
  --tmpfs /run/mysqld:rw,nosuid,nodev,size=64m,uid=65532,gid=65532,mode=0700 \
  --tmpfs /tmp:rw,nosuid,nodev,size=64m,uid=65532,gid=65532,mode=0700 \
  --mount "type=bind,src=$TMP_DIR/mysql-runtime-secrets/mysql-root-password,dst=/run/secrets/mysql-root-password,readonly" \
  --mount "type=bind,src=$TMP_DIR/mysql-runtime-secrets/mysql-root.cnf,dst=/run/secrets/mysql-root.cnf,readonly" \
  --env MYSQL_ROOT_PASSWORD_FILE=/run/secrets/mysql-root-password \
  "$MYSQL_IMAGE" mysqld >/dev/null

ready=false
for _ in $(seq 1 90); do
  if docker exec "$MYSQL_NAME" mysqladmin --defaults-extra-file=/run/secrets/mysql-root.cnf ping --silent >/dev/null 2>&1; then ready=true; break; fi
  sleep 2
done
[[ "$ready" == true ]]
printf '%s\n' \
  "CREATE DATABASE app CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;" \
  "CREATE USER 'app'@'%' IDENTIFIED BY '$MYSQL_APP_PASSWORD';" \
  "GRANT ALL PRIVILEGES ON app.* TO 'app'@'%';" \
  'FLUSH PRIVILEGES;' \
  | docker exec -i "$MYSQL_NAME" mysql --defaults-extra-file=/run/secrets/mysql-root.cnf
# The application credential is mounted only into a separate client, never the server.
docker run --rm --network "container:$MYSQL_NAME" --read-only \
  --cap-drop ALL --security-opt no-new-privileges:true --pids-limit 32 \
  --memory 128m --cpus 0.1 \
  --tmpfs /tmp:rw,nosuid,nodev,size=16m,uid=65532,gid=65532,mode=0700 \
  --mount "type=bind,src=$TMP_DIR/mysql-client-secrets/mysql-app.cnf,dst=/run/secrets/mysql-app.cnf,readonly" \
  --entrypoint mysql "$MYSQL_IMAGE" --defaults-extra-file=/run/secrets/mysql-app.cnf -e 'SELECT 1' app >/dev/null
# Verify the runtime's secret-safe stdin configuration path without placing
# credentials in argv or environment variables.
printf '[client]\nuser=app\npassword=%s\nhost=127.0.0.1\nprotocol=TCP\n' "$MYSQL_APP_PASSWORD" \
  | docker exec -i "$MYSQL_NAME" mysql --defaults-extra-file=/dev/stdin -e 'SELECT 1' app >/dev/null

cat > "$TMP_DIR/redis-runtime-secrets/redis-users.acl" <<EOF_REDIS_ACL
user default off
user app on >$REDIS_APP_PASSWORD ~* &* +@all
EOF_REDIS_ACL
cat > "$TMP_DIR/redis-runtime-secrets/redis.conf" <<'EOF_REDIS_CONF'
bind 0.0.0.0
protected-mode yes
aclfile /run/secrets/redis-users.acl
dir /data
save ""
appendonly no
EOF_REDIS_CONF
chmod 0440 "$TMP_DIR/redis-runtime-secrets/"*
chown_for_container "$TMP_DIR/redis-runtime-secrets/"*

docker run --detach --name "$REDIS_NAME" --network none --read-only \
  --cap-drop ALL --security-opt no-new-privileges:true --pids-limit 64 \
  --memory 256m --cpus 0.2 \
  --tmpfs /data:rw,nosuid,nodev,size=64m,uid=65532,gid=65532,mode=0700 \
  --tmpfs /tmp:rw,nosuid,nodev,size=32m,uid=65532,gid=65532,mode=0700 \
  --mount "type=bind,src=$TMP_DIR/redis-runtime-secrets/redis-users.acl,dst=/run/secrets/redis-users.acl,readonly" \
  --mount "type=bind,src=$TMP_DIR/redis-runtime-secrets/redis.conf,dst=/run/secrets/redis.conf,readonly" \
  "$REDIS_IMAGE" redis-server /run/secrets/redis.conf >/dev/null

ready=false
for _ in $(seq 1 45); do
  if printf 'AUTH app %s\nPING\n' "$REDIS_APP_PASSWORD" \
    | docker run --rm -i --network "container:$REDIS_NAME" --entrypoint redis-cli "$REDIS_IMAGE" 2>/dev/null \
    | tail -n 1 | grep -qx PONG; then ready=true; break; fi
  sleep 1
done
[[ "$ready" == true ]]
unauthenticated_response="$(docker run --rm --network "container:$REDIS_NAME" --entrypoint redis-cli "$REDIS_IMAGE" ping 2>&1 || true)"
if [[ "$unauthenticated_response" == "PONG" ]]; then
  echo 'Redis accepted an unauthenticated command' >&2
  exit 1
fi
if [[ "$unauthenticated_response" != *NOAUTH* ]]; then
  echo "Redis returned an unexpected unauthenticated response: $unauthenticated_response" >&2
  exit 1
fi

echo 'Project dependency image smoke tests passed.'
