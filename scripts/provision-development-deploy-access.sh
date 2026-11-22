#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this provisioning script as root." >&2
  exit 1
fi
if [[ "$#" -ne 1 ]]; then
  echo "Usage: sudo bash scripts/provision-development-deploy-access.sh '<ssh-ed25519 public key>'" >&2
  exit 64
fi

public_key=$1
if [[ "$public_key" == *$'\n'* || ! "$public_key" =~ ^ssh-ed25519[[:space:]]+[A-Za-z0-9+/]+={0,3}([[:space:]][^[:cntrl:]]*)?$ ]]; then
  echo "Only one valid ssh-ed25519 public key is accepted." >&2
  exit 64
fi

for command in useradd getent passwd install visudo ssh-keygen node id chown; do
  command -v "$command" >/dev/null 2>&1 || { echo "Required command is missing: $command" >&2; exit 1; }
done
[[ -f scripts/deploy-development-gateway.sh && -f scripts/deploy-development.mjs ]] || {
  echo "Run from the repository root; development deployment scripts are missing." >&2
  exit 1
}
getent passwd vps-mcp-development >/dev/null || {
  echo "Development service account does not exist; provision the development runtime first." >&2
  exit 1
}

key_tmp=$(mktemp)
sudoers_tmp=$(mktemp)
trap 'rm -f "$key_tmp" "$sudoers_tmp"' EXIT
printf '%s\n' "$public_key" > "$key_tmp"
ssh-keygen -lf "$key_tmp" >/dev/null

if ! getent passwd vps-mcp-development-deploy >/dev/null; then
  useradd --system --create-home --home-dir /var/lib/vps-mcp-development-deploy --shell /bin/sh vps-mcp-development-deploy
fi
passwd --lock vps-mcp-development-deploy >/dev/null
account_groups=" $(id -nG vps-mcp-development-deploy) "
case "$account_groups" in
  *" sudo "*|*" wheel "*|*" admin "*|*" docker "*|*" lxd "*)
    echo "Deployment account belongs to a privileged group; refusing." >&2
    exit 1
    ;;
esac

[[ ! -L /usr/local/libexec/vps-mcp-development ]] || { echo "Helper directory is a symlink." >&2; exit 1; }
install -d -o root -g root -m 0755 /usr/local/libexec/vps-mcp-development
install -o root -g root -m 0755 scripts/deploy-development-gateway.sh /usr/local/libexec/vps-mcp-development/deploy-development-gateway.sh
install -o root -g root -m 0755 scripts/deploy-development.mjs /usr/local/libexec/vps-mcp-development/deploy-development.mjs

install -d -o vps-mcp-development-deploy -g vps-mcp-development-deploy -m 0700 /var/lib/vps-mcp-development-deploy/.ssh
key_line="restrict,command=\"/usr/local/libexec/vps-mcp-development/deploy-development-gateway.sh\" ${public_key}"
authorized_keys=/var/lib/vps-mcp-development-deploy/.ssh/authorized_keys
[[ ! -L "$authorized_keys" ]] || { echo "authorized_keys is a symlink." >&2; exit 1; }
if [[ -f "$authorized_keys" ]] && ! grep -Fxq -- "$key_line" "$authorized_keys"; then
  echo "Existing development deployment authorized_keys is non-empty; inspect manually." >&2
  exit 1
fi
if [[ ! -f "$authorized_keys" ]]; then
  printf '%s\n' "$key_line" > "$authorized_keys"
fi
chown vps-mcp-development-deploy:vps-mcp-development-deploy "$authorized_keys"
chmod 0600 "$authorized_keys"

[[ ! -L /etc/sudoers.d/vps-mcp-development-deploy ]] || { echo "Development sudoers file is a symlink." >&2; exit 1; }
cat > "$sudoers_tmp" <<'SUDOERS'
# GitHub Actions may invoke only the fixed development deployment entry point.
vps-mcp-development-deploy ALL=(root) NOPASSWD: /usr/bin/node /usr/local/libexec/vps-mcp-development/deploy-development.mjs
SUDOERS
visudo -cf "$sudoers_tmp"
install -o root -g root -m 0440 "$sudoers_tmp" /etc/sudoers.d/vps-mcp-development-deploy

printf '\nDevelopment deployment access provisioned.\n'
printf 'SSH user: vps-mcp-development-deploy\n'
printf 'Public key fingerprint: '
ssh-keygen -lf "$key_tmp"
printf '\nConfigure the matching private key and VPS host details in the GitHub development environment.\n'
