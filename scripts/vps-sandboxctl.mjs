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

function cgroupChecks(unitName) {
  const ownCgroup = `/sys/fs/cgroup/system.slice/${unitName}.service`;
  return [
    'set -eu',
    `CGROUP=${ownCgroup}`,
    'echo "Delegated cgroup: $CGROUP"',
    'test -d "$CGROUP"',
    'test -w "$CGROUP/cgroup.subtree_control"',
    'test ! -w /sys/fs/cgroup/cgroup.subtree_control',
    'test ! -w /sys/fs/cgroup/system.slice/cgroup.subtree_control',
    'echo "CGROUP DELEGATION CHECK PASSED"',
  ].join(String.fromCharCode(10));
}

function buildUnitScript(operation, unitName) {
  const checks = cgroupChecks(unitName);
  const preflight = `${NODE} ${PREFLIGHT}`;
  const info = `${PODMAN} --cgroup-manager=cgroupfs info --debug`;
  const smoke = `${PODMAN} --cgroup-manager=cgroupfs run --rm --pull=missing ${ALPINE_IMAGE} id`;
  const acceptance = `${NODE} ${ACCEPTANCE}`;

  if (operation === 'preflight') return `${preflight}\n${checks}`;
  if (operation === 'info') return info;
  if (operation === 'smoke') return [preflight, checks, info, smoke, 'echo "ROOTLESS ACCEPTANCE SMOKE PASSED"'].join('\n');
  if (operation === 'acceptance') return [preflight, checks, acceptance].join('\n');
  throw new Error('Unsupported operation');
}

export function buildSystemdRunArgs(operation, unitName, sandboxUid) {
  if (!OPERATIONS.has(operation)) throw new Error('Unsupported runtime operation');
  if (!/^vps-sandboxctl-(preflight|info|smoke|acceptance)-[0-9]+$/.test(unitName)) throw new Error('Invalid transient unit name');
  if (!/^[0-9]+$/.test(String(sandboxUid))) throw new Error('Invalid sandbox UID');

  return [
    '--wait', '--pipe', '--collect', `--unit=${unitName}`,
    `--uid=${SANDBOX_USER}`,
    '--setenv=HOME=/var/lib/vps-sandbox',
    `--setenv=XDG_RUNTIME_DIR=/run/user/${sandboxUid}`,
    '--property=Delegate=cpu memory pids',
    '--property=ProtectControlGroups=no',
    '--property=NoNewPrivileges=no',
    '--property=CapabilityBoundingSet=CAP_SETUID CAP_SETGID',
    '--property=RestrictSUIDSGID=yes',
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
