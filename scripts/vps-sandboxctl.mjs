#!/usr/bin/node
import { execFileSync } from 'node:child_process';

const SANDBOX_USER = 'vps-sandbox';
const PREFLIGHT = '/usr/local/libexec/vps-mcp/rootless-runtime-preflight.mjs';
const ACCEPTANCE = '/usr/local/libexec/vps-mcp/rootless-runtime-acceptance.mjs';
const PODMAN = '/usr/bin/podman';
const NODE = '/usr/bin/node';
const BASH = '/usr/bin/bash';
const ALPINE_IMAGE = 'docker.io/library/alpine:3.21';
const OPERATIONS = new Set(['preflight', 'info', 'smoke', 'acceptance']);

function fail(message, code = 2) {
  console.error(message);
  process.exit(code);
}

function assertCaller() {
  if (process.getuid() !== 0) fail('vps-sandboxctl must be invoked by the root-owned diagnostics broker.', 77);
}

function cgroupChecks() {
  return [
    'set -eu',
    'UNIT="${VPS_SANDBOXCTL_UNIT:?missing transient unit identity}"',
    'case "$UNIT" in vps-sandboxctl-*) ;; *) echo "Invalid transient unit identity" >&2; exit 1 ;; esac',
    'EXPECTED_INVOCATION=$(systemctl show "$UNIT" --property=InvocationID --value)',
    'test -n "$INVOCATION_ID" && test "$INVOCATION_ID" = "$EXPECTED_INVOCATION"',
    'CGROUP=$(systemctl show "$UNIT" --property=ControlGroup --value)',
    'case "$CGROUP" in /system.slice/vps-sandboxctl-*.service) ;; *) echo "Transient unit is outside the expected system.slice boundary: $CGROUP" >&2; exit 1 ;; esac',
    'MOUNT_ROOT=/sys/fs/cgroup',
    'DELEGATED_CGROUP="$MOUNT_ROOT$CGROUP"',
    'echo "Delegated system-service cgroup: $CGROUP (mount root: $MOUNT_ROOT)"',
    'test -d "$DELEGATED_CGROUP"',
    'test -w "$DELEGATED_CGROUP/cgroup.subtree_control"',
    'test -w "$DELEGATED_CGROUP/cgroup.procs"',
    'INIT_CGROUP="$DELEGATED_CGROUP/init.scope"',
    'mkdir "$INIT_CGROUP"',
    'printf "%s\\n" "$" > "$INIT_CGROUP/cgroup.procs"',
    'for CONTROLLER in cpu memory pids; do printf "+%s\\\\n" "$CONTROLLER" > "$DELEGATED_CGROUP/cgroup.subtree_control" || { echo "Failed to enable delegated controller: $CONTROLLER" >&2; exit 1; }; done',
    'ENABLED_CONTROLLERS=$(cat "$DELEGATED_CGROUP/cgroup.subtree_control")',
    'for CONTROLLER in cpu memory pids; do case " $ENABLED_CONTROLLERS " in *" $CONTROLLER "*) ;; *) echo "Controller not enabled in delegated subtree: $CONTROLLER" >&2; exit 1 ;; esac; done',
    'export VPS_SANDBOXCTL_CGROUP="$CGROUP"',
    'echo "Delegated controllers enabled: $ENABLED_CONTROLLERS"',
    'echo "SYSTEM-SERVICE CGROUP DELEGATION CHECK PASSED"'
  ].join(String.fromCharCode(10));
}

function buildUnitScript(operation, unitName) {
  const checks = cgroupChecks();
  const preflight = `${NODE} ${PREFLIGHT}`;
  const info = `${PODMAN} --cgroup-manager=cgroupfs info --debug`;
  const smoke = `${PODMAN} --cgroup-manager=cgroupfs run --cgroup-parent="$CGROUP" --rm --pull=missing ${ALPINE_IMAGE} id`;
  const acceptanceCommand = `${NODE} ${ACCEPTANCE}`;

  if (operation === 'preflight') return `${preflight}\n${checks}`;
  if (operation === 'info') return info;
  if (operation === 'smoke') return [preflight, checks, info, smoke, 'echo "ROOTLESS ACCEPTANCE SMOKE PASSED"'].join('\n');
  if (operation === 'acceptance') return [preflight, checks, acceptanceCommand].join('\n');
  throw new Error('Unsupported operation');
}

export function buildSystemdRunArgs(operation, unitName, sandboxUid) {
  if (!OPERATIONS.has(operation)) throw new Error('Unsupported runtime operation');
  if (!/^vps-sandboxctl-(preflight|info|smoke|acceptance)-[0-9]+$/.test(unitName)) throw new Error('Invalid transient unit name');
  if (!/^[0-9]+$/.test(String(sandboxUid))) throw new Error('Invalid sandbox UID');

  return [
    '--system',
    '--wait', '--pipe', '--collect', `--unit=${unitName}`,
    `--uid=${SANDBOX_USER}`,
    `--setenv=HOME=/var/lib/vps-sandbox`,
    `--setenv=VPS_SANDBOXCTL_UNIT=${unitName}`,
    `--setenv=XDG_RUNTIME_DIR=/run/user/${sandboxUid}`,
    `--setenv=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${sandboxUid}/bus`,
    '--setenv=PATH=/usr/sbin:/usr/bin:/sbin:/bin',
    '--property=WorkingDirectory=/var/lib/vps-sandbox',
    '--property=Delegate=cpu memory pids',
    '--property=NoNewPrivileges=no',
    // The system manager performs capability and namespace setup before dropping to the dedicated sandbox UID.
    // cgroupfs keeps Podman-created cgroups inside this service's delegated subtree.
    '--property=ProtectSystem=strict',
    '--property=ProtectHome=read-only',
    '--property=ProtectKernelTunables=yes',
    '--property=ProtectKernelModules=yes',
    '--property=PrivateTmp=yes',
    `--property=ReadWritePaths=/var/lib/vps-sandbox /run/user/${sandboxUid}`,
    BASH, '-lc', buildUnitScript(operation, unitName),
  ];
}

function main() {
  assertCaller();
  if (process.argv.length !== 3 || !OPERATIONS.has(process.argv[2])) {
    fail('Usage: vps-sandboxctl {preflight|info|smoke|acceptance}');
  }

  const operation = process.argv[2];
  const unitName = `vps-sandboxctl-${operation}-${process.pid}`;
  const sandboxUid = execFileSync('/usr/bin/id', ['-u', SANDBOX_USER], { encoding: 'utf8' }).trim();
  const args = buildSystemdRunArgs(operation, unitName, sandboxUid);

  try {
    execFileSync('/usr/bin/systemd-run', args, {
      stdio: 'inherit',
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', SYSTEMD_COLORS: '0' },
      timeout: 900_000,
    });
  } catch (error) {
    if (error.status !== null && error.status !== undefined) process.exit(error.status);
    fail(`Failed to execute the approved ${operation} operation: ${error.message}`, 1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
