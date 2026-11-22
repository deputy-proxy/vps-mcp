#!/usr/bin/env bash
set -Eeuo pipefail
if [[ $EUID -ne 0 ]]; then echo "Run as root: sudo bash scripts/provision-vps-sandbox-quotas.sh" >&2; exit 2; fi
WORKSPACE_ROOT=/var/lib/vps-mcp/task-workspaces/worktrees
[[ -d "$WORKSPACE_ROOT" ]] || { echo "Missing task workspace root: $WORKSPACE_ROOT" >&2; exit 2; }
apt-get update\nDEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends quota e2fsprogs\nfor tool in findmnt tune2fs chattr setquota quotaon; do command -v "$tool" >/dev/null || { echo "Missing required command: $tool (install quota and e2fsprogs)" >&2; exit 2; }; done
SOURCE=$(findmnt -n -o SOURCE -T "$WORKSPACE_ROOT")
DEVICE=$(printf '%s' "$SOURCE" | sed 's/\\[.*$//')
FSTYPE=$(findmnt -n -o FSTYPE -T "$WORKSPACE_ROOT")
[[ "$FSTYPE" == ext4 ]] || { echo "Task workspace filesystem must be ext4; found $FSTYPE" >&2; exit 2; }
FEATURES=$(tune2fs -l "$DEVICE" | sed -n 's/^Filesystem features: //p')
grep -qw project <<<"$FEATURES" || { echo "The ext4 project feature is not enabled on $DEVICE. Enable it only during a maintenance window with an offline filesystem check." >&2; exit 2; }
OPTIONS=$(findmnt -n -o OPTIONS -T "$WORKSPACE_ROOT")
grep -Eq '(^|,)(prjquota|pquota)(,|$)' <<<"$OPTIONS" || { echo "Project quotas are not enabled. Add prjquota to the filesystem mount configuration and remount during a reviewed maintenance window; refusing automatic root-filesystem remount." >&2; exit 2; }
FS_MOUNT=$(findmnt -n -o TARGET -T "$WORKSPACE_ROOT")
install -d -o root -g root -m 0750 /etc/vps-sandbox
if [[ ! -e /etc/vps-sandbox/project-quotas.json ]]; then printf '%s' '{}' > /etc/vps-sandbox/project-quotas.json; chown root:root /etc/vps-sandbox/project-quotas.json; chmod 0600 /etc/vps-sandbox/project-quotas.json; fi
[[ "$(stat -c '%u:%a' /etc/vps-sandbox/project-quotas.json)" == "0:600" ]] || { echo "Unsafe project quota registry ownership or mode" >&2; exit 2; }
quotaon -P "$FS_MOUNT"
echo "Project quota prerequisites verified on $FS_MOUNT ($DEVICE)."
