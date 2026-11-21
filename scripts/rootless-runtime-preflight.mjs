#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, accessSync, constants } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

const RUNTIME_USER = 'vps-sandbox';

export function evaluateSnapshot(snapshot) {
  const checks = [];
  const add = (id, ok, detail, required = true) => checks.push({ id, status: ok ? 'pass' : required ? 'fail' : 'warning', detail });

  add('linux', snapshot.platform === 'linux', `platform=${snapshot.platform}`);
  add('runtime-identity', snapshot.executionUser === RUNTIME_USER, `execution user=${snapshot.executionUser ?? 'unknown'}; expected=${RUNTIME_USER}`);
  add('systemd-user-manager', snapshot.userManagerBus === true, snapshot.userManagerDetail ?? 'systemd user manager bus must be available for delegated rootless cgroups');
  add('cgroup-v2', snapshot.cgroup === 'cgroup2fs', `filesystem=${snapshot.cgroup ?? 'unavailable'}`);
  add('cgroup-delegation', snapshot.cgroupDelegation === true, snapshot.cgroupDelegationDetail ?? 'CPU, memory and PID controllers must be delegated and writable by this unit');
  add('user-namespaces', snapshot.userNamespace === true, snapshot.userNamespaceDetail ?? 'unprivileged user namespace probe');
  add('subuid', snapshot.subuid === true, `${RUNTIME_USER} subordinate UID range is ${snapshot.subuid ? 'configured' : 'missing'}`);
  add('subgid', snapshot.subgid === true, `${RUNTIME_USER} subordinate GID range is ${snapshot.subgid ? 'configured' : 'missing'}`);
  add('uidmap-helpers', snapshot.newuidmap === true && snapshot.newgidmap === true, `newuidmap=${snapshot.newuidmap}; newgidmap=${snapshot.newgidmap}`);
  add('no-new-privileges', snapshot.noNewPrivileges === false, `effective NoNewPrivs=${snapshot.noNewPrivileges ?? 'unknown'}; mapping helpers require privilege gain inside this dedicated test unit`);
  add('mapping-helper-capabilities', snapshot.capSetuid === true && snapshot.capSetgid === true, `CAP_SETUID in bounding set=${snapshot.capSetuid}; CAP_SETGID in bounding set=${snapshot.capSetgid}`);
  add('network-helper', snapshot.slirp4netns === true || snapshot.pasta === true, `slirp4netns=${snapshot.slirp4netns}; pasta=${snapshot.pasta}`);
  add('overlay-helper', snapshot.fuseOverlayfs === true, `fuse-overlayfs=${snapshot.fuseOverlayfs}`, false);
  add('podman', snapshot.podman === true, `podman=${snapshot.podmanVersion ?? 'not installed'}`);
  add('storage-writable', snapshot.storageWritable === true, snapshot.storageDetail ?? 'rootless container storage directory must be writable');
  add('memory', snapshot.memoryBytes >= 2 * 1024 ** 3, `available=${snapshot.memoryBytes == null ? 'unknown' : `${Math.round(snapshot.memoryBytes / 1024 ** 3)} GiB`}`, false);
  add('disk', snapshot.diskAvailableBytes >= 10 * 1024 ** 3, `available=${snapshot.diskAvailableBytes == null ? 'unknown' : `${Math.round(snapshot.diskAvailableBytes / 1024 ** 3)} GiB`}`, false);

  const failures = checks.filter((check) => check.status === 'fail');
  return { ready: failures.length === 0, checks, failures: failures.map(({ id, detail }) => ({ id, detail })) };
}

function command(binary, args = []) {
  try {
    return execFileSync(binary, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
  } catch {
    return null;
  }
}

function has(binary) {
  return command('sh', ['-lc', `command -v ${binary}`]) !== null;
}

function read(path) {
  try { return readFileSync(path, 'utf8').trim(); } catch { return null; }
}

function hasSubordinateRange(file, username) {
  const contents = read(file);
  if (!contents) return false;
  return contents.split('\n').some((line) => {
    const [owner, startText, countText] = line.split(':');
    if (owner !== username || !/^\d+$/.test(startText ?? '') || !/^\d+$/.test(countText ?? '')) return false;
    const start = Number(startText);
    const count = Number(countText);
    return Number.isSafeInteger(start) && Number.isSafeInteger(count) && start > 0 && count >= 65536 && start + count <= 2 ** 32;
  });
}

function probeUserNamespace() {
  // Probe the namespace path the selected runtime actually uses. Generic
  // unshare may be restricted by Ubuntu's AppArmor unprivileged_userns
  // transition even when Podman's dedicated AppArmor profile permits it.
  const output = command('podman', [
    '--cgroup-manager=systemd',
    'unshare',
    'sh',
    '-c',
    'printf "uid_map\n"; cat /proc/self/uid_map; printf "gid_map\n"; cat /proc/self/gid_map',
  ]);
  return {
    ok: Boolean(output && output.includes('uid_map') && output.includes('gid_map')),
    detail: output
      ? `podman unshare succeeded; maps=${output.replace(/\s+/g, ' ')}`
      : 'podman unshare failed in this execution context',
  };
}

export function collectSnapshot() {
  const userns = probeUserNamespace();
  const executionUser = command('id', ['-un']);
  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  const userBus = runtimeDir ? `${runtimeDir}/bus` : null;
  const userManagerBus = Boolean(userBus && command('test', ['-S', userBus]) !== null && process.env.DBUS_SESSION_BUS_ADDRESS === `unix:path=${userBus}`);
  const subuid = hasSubordinateRange('/etc/subuid', RUNTIME_USER);
  const subgid = hasSubordinateRange('/etc/subgid', RUNTIME_USER);
  const podmanVersion = command('podman', ['--version']);
  const processStatus = read('/proc/self/status') ?? '';
  const noNewPrivilegesMatch = processStatus.match(/^NoNewPrivs:\s+(\d+)$/m);
  const noNewPrivileges = noNewPrivilegesMatch ? noNewPrivilegesMatch[1] === '1' : null;
  const capBnd = processStatus.match(/^CapBnd:\s+([0-9a-f]+)$/mi)?.[1];
  const capBndValue = capBnd ? BigInt(`0x${capBnd}`) : 0n;
  const capSetgid = Boolean(capBndValue & (1n << 6n));
  const capSetuid = Boolean(capBndValue & (1n << 7n));

  const storagePath = join(os.homedir(), '.local', 'share', 'containers');
  let storageWritable = false;
  let storageDetail = `storage=${storagePath}; directory is missing or not writable`;
  try {
    accessSync(storagePath, constants.W_OK);
    storageWritable = true;
    storageDetail = `storage=${storagePath}; writable`;
  } catch { /* reported as a required preflight failure */ }

  let diskAvailableBytes = null;
  const df = command('df', ['-Pk', os.homedir()]);
  if (df) {
    const fields = df.split('\n').at(-1)?.trim().split(/\s+/);
    if (fields?.[3]) diskAvailableBytes = Number(fields[3]) * 1024;
  }

  const cgroupRelativePath = read('/proc/self/cgroup')?.split('\n').find((line) => line.startsWith('0::'))?.slice(3) ?? '';
  const serviceCgroup = `/sys/fs/cgroup${cgroupRelativePath}`;
  const controllers = read(`${serviceCgroup}/cgroup.controllers`)?.split(/\s+/).filter(Boolean) ?? [];
  let subtreeControlWritable = false;
  try {
    accessSync(`${serviceCgroup}/cgroup.subtree_control`, constants.W_OK);
    subtreeControlWritable = true;
  } catch { /* no delegation */ }
  const requiredControllers = ['cpu', 'memory', 'pids'];
  const cgroupDelegation = requiredControllers.every((controller) => controllers.includes(controller)) && subtreeControlWritable;

  return {
    platform: process.platform,
    executionUser,
    userManagerBus,
    userManagerDetail: `user bus=${userBus ?? 'unset'}; socket=${userManagerBus}; DBUS_SESSION_BUS_ADDRESS configured=${process.env.DBUS_SESSION_BUS_ADDRESS === (userBus ? `unix:path=${userBus}` : '')}`,
    cgroup: command('stat', ['-fc', '%T', '/sys/fs/cgroup']),
    cgroupDelegation,
    cgroupDelegationDetail: `unit cgroup=${serviceCgroup}; controllers=${controllers.join(' ') || 'unavailable'}; cgroup.subtree_control writable=${subtreeControlWritable}`,
    userNamespace: userns.ok,
    userNamespaceDetail: userns.detail,
    subuid,
    subgid,
    newuidmap: has('newuidmap'),
    newgidmap: has('newgidmap'),
    slirp4netns: has('slirp4netns'),
    pasta: has('pasta'),
    fuseOverlayfs: has('fuse-overlayfs'),
    podman: Boolean(podmanVersion),
    podmanVersion,
    noNewPrivileges,
    capSetuid,
    capSetgid,
    storageWritable,
    storageDetail,
    memoryBytes: os.freemem(),
    diskAvailableBytes,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const report = evaluateSnapshot(collectSnapshot());
  if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`Rootless runtime preflight: ${report.ready ? 'READY' : 'BLOCKED'}`);
    for (const check of report.checks) console.log(`${check.status.toUpperCase().padEnd(7)} ${check.id}: ${check.detail}`);
  }
  if (!report.ready) process.exitCode = 1;
}
