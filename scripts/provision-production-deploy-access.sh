#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this provisioning script as root." >&2
  exit 1
fi
if [[ "$#" -ne 1 ]]; then
  echo "Usage: sudo bash scripts/provision-production-deploy-access.sh '<ssh-ed25519 public key>'" >&2
  exit 64
fi

public_key=$1
if [[ "$public_key" == *$'\n'* || ! "$public_key" =~ ^ssh-ed25519[[:space:]]+[A-Za-z0-9+/]+={0,3}([[:space:]][^[:cntrl:]]*)?$ ]]; then
  echo "Only one valid ssh-ed25519 public key is accepted." >&2
  exit 64
fi

for command in useradd getent passwd install visudo ssh-keygen node npm git curl systemctl id chown sudo runuser env; do
  command -v "$command" >/dev/null 2>&1 || { echo "Required command is missing: $command" >&2; exit 1; }
done
for executable in /usr/bin/node /usr/bin/npm /usr/bin/git /usr/bin/curl /usr/bin/systemctl /usr/bin/sudo /usr/sbin/runuser /usr/bin/env /usr/bin/chown; do
  [[ -x "$executable" ]] || { echo "Required executable is missing: $executable" >&2; exit 1; }
done
[[ -f scripts/deploy-gateway.sh && -f scripts/deploy-production.mjs ]] || { echo "Run from the repository root; deployment scripts are missing." >&2; exit 1; }

key_tmp=$(mktemp)
sudoers_tmp=$(mktemp)
trap 'rm -f "$key_tmp" "$sudoers_tmp"' EXIT
printf '%s\n' "$public_key" > "$key_tmp"
ssh-keygen -lf "$key_tmp" >/dev/null

if ! getent passwd vps-mcp >/dev/null; then
  echo "The vps-mcp service account does not exist; refusing to provision deployment access." >&2
  exit 1
fi
if getent passwd vps-mcp-deploy >/dev/null; then
  IFS=: read -r _ _ _ _ _ deploy_home deploy_shell < <(getent passwd vps-mcp-deploy)
  [[ "$deploy_home" == "/var/lib/vps-mcp-deploy" && "$deploy_shell" == "/bin/sh" ]] || {
    echo "Existing vps-mcp-deploy account has unexpected home or shell; inspect manually." >&2
    exit 1
  }
else
  useradd --system --create-home --home-dir /var/lib/vps-mcp-deploy --shell /bin/sh vps-mcp-deploy
fi
passwd --lock vps-mcp-deploy >/dev/null
for account in vps-mcp-deploy; do
  account_groups=" $(id -nG "$account") "
  case "$account_groups" in
    *" sudo "*|*" wheel "*|*" admin "*|*" docker "*|*" lxd "*)
      echo "$account belongs to a privileged group; refusing to grant deployment sudo rules." >&2
      exit 1
      ;;
  esac
done

[[ ! -L /usr/local/libexec/vps-mcp ]] || { echo "Deployment helper directory is a symlink; refusing to continue." >&2; exit 1; }
install -d -o root -g root -m 0755 /usr/local/libexec/vps-mcp
install -o root -g root -m 0755 scripts/deploy-gateway.sh /usr/local/libexec/vps-mcp/deploy-gateway.sh
install -o root -g root -m 0755 scripts/deploy-production.mjs /usr/local/libexec/vps-mcp/deploy-production.mjs

install -d -o root -g root -m 0700 /var/lib/vps-mcp-deploy/.ssh
chown root:root /var/lib/vps-mcp-deploy
chmod 0755 /var/lib/vps-mcp-deploy
key_line="restrict,command=\"/usr/local/libexec/vps-mcp/deploy-gateway.sh\" ${public_key}"
authorized_keys=/var/lib/vps-mcp-deploy/.ssh/authorized_keys
[[ ! -L "$authorized_keys" ]] || { echo "authorized_keys is a symlink; refusing to continue." >&2; exit 1; }
if [[ -f "$authorized_keys" ]]; then
  while IFS= read -r existing_line || [[ -n "$existing_line" ]]; do
    [[ -z "$existing_line" || "$existing_line" == \#* || "$existing_line" == "$key_line" ]] || {
      echo "Existing authorized_keys contains an entry outside this forced-command policy; inspect it manually." >&2
      exit 1
    }
  done < "$authorized_keys"
fi
if [[ ! -f "$authorized_keys" ]] || ! grep -Fxq -- "$key_line" "$authorized_keys"; then
  touch "$authorized_keys"
  printf '%s\n' "$key_line" >> "$authorized_keys"
fi
chown root:root "$authorized_keys"
chmod 0600 "$authorized_keys"

[[ ! -L /etc/sudoers.d/vps-mcp-deploy ]] || { echo "Deployment sudoers file is a symlink; refusing to continue." >&2; exit 1; }
cat > "$sudoers_tmp" <<'SUDOERS'
# GitHub Actions may invoke only the fixed deployment entry point.
vps-mcp-deploy ALL=(root) NOPASSWD: /usr/bin/node /usr/local/libexec/vps-mcp/deploy-production.mjs ""
SUDOERS
visudo -cf "$sudoers_tmp"
install -o root -g root -m 0440 "$sudoers_tmp" /etc/sudoers.d/vps-mcp-deploy

printf '\nDeployment access provisioned.\n'
printf 'SSH user: vps-mcp-deploy\n'
printf 'Forced command: /usr/local/libexec/vps-mcp/deploy-gateway.sh\n'
printf 'Allowed privileged action: fixed deployment script only\n'
printf 'Public key fingerprint: '
ssh-keygen -lf "$key_tmp"
printf '\nAdd the matching PRIVATE key to the GitHub production environment secret VPS_PRODUCTION_DEPLOY_KEY.\n'
printf 'Also configure VPS_PRODUCTION_HOST, VPS_PRODUCTION_PORT, and VPS_PRODUCTION_KNOWN_HOSTS.\n'
