#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, accessSync, constants } from 'node:fs';
import os from 'node:os';

const SERVICE_USER = process.env.VPS_MCP_SERVICE_USER ?? 'vps-mcp';
const UNIT_PATHS = (process.env.VPS_MCP_UNIT_PATHS ?? '/etc/systemd/system/vps-mcp.service,/lib/systemd/system/vps-mcp.service,/usr/lib/systemd/system/vps-mcp.service').split(',');

export function evaluateSnapshot(snapshot) {
  const checks = [];
  const add = (id, ok, detail, required = true) => checks.push({ id, status: ok ? 'pass' : required ? 'fail' : 'warning', detail });
  add('linux', snapshot.platform === 'linux', `platform=${snapshot.platform}`);
  add('cgroup-v2', snapshot.cgroup === 'cgroup2fs', `filesystem=${snapshot.cgroup ?? 'unavailable'}`);
  add('cgroup-delegation', snapshot.cgroupDelegation === true, snapshot.cgroupDelegationDetail ?? 'CPU, memory and PID controllers must be delegated and writable by the service');
  add('user-namespaces', snapshot.userNamespace === true, snapshot.userNamespaceDetail ?? 'unprivileged user namespace probe');
  add('subuid', snapshot.subuid === true, snapshot.subuidDetail ?? `${SERVICE_USER} subordinate UID range`);
  add('subgid', snapshot.subgid === true, snapshot.subgidDetail ?? `${SERVICE_USER} subordinate GID range`);
  add('uidmap-helpers', snapshot.newuidmap && snapshot.newgidmap, `newuidmap=${snapshot.newuidmap}; newgidmap=${snapshot.newgidmap}`);
  add('mapping-helper-capabilities', snapshot.capSetuid && snapshot.capSetgid, `CAP_SETUID in bounding set=${snapshot.capSetuid}; CAP_SETGID in bounding set=${snapshot.capSetgid}`);
  add('network-helper', snapshot.slirp4netns || snapshot.pasta, `slirp4netns=${snapshot.slirp4netns}; pasta=${snapshot.pasta}`);
  add('overlay-helper', snapshot.fuseOverlayfs, `fuse-overlayfs=${snapshot.fuseOverlayfs}`, false);
  add('podman', snapshot.podman, `podman=${snapshot.podmanVersion ?? 'not installed'}`);
  add('service-hardening', snapshot.unitReadable && snapshot.noNewPrivileges !== null, snapshot.unitReadable ? `NoNewPrivileges=${snapshot.noNewPrivileges}; ProtectSystem=${snapshot.protectSystem}; ProtectControlGroups=${snapshot.protectControlGroups}` : `systemd unit is not readable from this execution context; effective NoNewPrivs=${snapshot.noNewPrivileges}; administrator must verify the deployed unit`, false);
  if (snapshot.noNewPrivileges === true) add('setuid-helper-compatibility', false, 'NoNewPrivileges=true blocks privilege gain through setuid newuidmap/newgidmap helpers; a single-ID mapping must not be assumed equivalent.', false);
  add('service-context-probe', snapshot.serviceContextProbe === true, snapshot.serviceContextDetail ?? 'rootless user namespace probe in the MCP execution context');
  add('storage-writable', snapshot.storageWritable === true, snapshot.storageDetail ?? 'rootless storage directory is writable');
  add('memory', snapshot.memoryBytes >= 2 * 1024 ** 3, `available=${snapshot.memoryBytes == null ? 'unknown' : `${Math.round(snapshot.memoryBytes / 1024 ** 3)} GiB`}`, false);
  add('disk', snapshot.diskAvailableBytes >= 10 * 1024 ** 3, `available=${snapshot.diskAvailableBytes == null ? 'unknown' : `${Math.round(snapshot.diskAvailableBytes / 1024 ** 3)} GiB`}`, false);
  const failures = checks.filter((check) => check.status === 'fail');
  return { ready: failures.length === 0, checks, failures: failures.map(({ id, detail }) => ({ id, detail })) };
}

function command(binary, args = []) {
  try { return execFileSync(binary, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore',], timeout: 5000 }).trim(); }
  catch { return null; }
}

function has(binary) { return command('sh', ['-lc', `command -v ${binary}`]) !== null; }
function read(path) { try { return readFileSync(path, 'utf8').trim(); } catch { return null; } }
function probeUserNamespace() {
  const output = command('unshare', ['-Ur', 'sh', '-c', 'cat /proc/self/uid_map']);
  return { ok: Boolean(output), detail: output ? `unshare succeeded; uid_map=${output.replace(/\s+/g, ' ')}` : 'unshare -Ur failed in this process context' };
}

export function collectSnapshot() {
  const unitPath = UNIT_PATHS.find(existsSync);
  const unit = unitPath ? read(unitPath) : null;
  const userns = probeUserNamespace();
  const user = command('id', ['-un']) ?? SERVICE_USER;
  const subuid = read('/etc/subuid')?.split('\n').some((line) => line.startsWith(`${SERVICE_USER}:`)) ?? false;
  const subgid = read('/etc/subgid')?.split('\n').some((line) => line.startsWith(`${SERVICE_USER}:`)) ?? false;
  const podmanVersion = command('podman', ['--version']);
  const processStatus = read('/proc/self/status') ?? '';
  const noNewPrivileges = /^NoNewPrivs:\s+1$/m.test(processStatus);
  const capBnd = processStatus.match(/^CapBnd:\s+([0-9a-f]+)$/mi)?.[1];
  const capBndValue = capBnd ? BigInt(`0x${capBnd}`) : 0n;
  const capSetgid = Boolean(capBndValue & (1n << 6n));
  const capSetuid = Boolean(capBndValue & (1n << 7n));
  let storageWritable = false;
  let storageDetail = 'HOME is not writable';
  try { accessSync(os.homedir(), constants.W_OK); storageWritable = true; storageDetail = `HOME=${os.homedir()}`; } catch { /* reported below */ }
  let diskAvailableBytes = null;
  const df = command('df', ['-Pk', os.homedir()]);
  if (df) { const fields = df.split('\n').at(-1)?.trim().split(/\s+/); if (fields?.[3]) diskAvailableBytes = Number(fields[3]) * 1024; }
  const memoryBytes = os.freemem();
  const cgroupRelativePath = read('/proc/self/cgroup')?.split('\n').find((line) => line.startsWith('0::'))?.slice(3) ?? '';
  const serviceCgroup = `/sys/fs/cgroup${cgroupRelativePath}`;
  const controllers = read(`${serviceCgroup}/cgroup.controllers`)?.split(/\s+/).filter(Boolean) ?? [];
  let subtreeControlWritable = false;
  try { accessSync(`${serviceCgroup}/cgroup.subtree_control`, constants.W_OK); subtreeControlWritable = true; } catch { /* no delegation */ }
  const requiredControllers = ['cpu', 'memory', 'pids'];
  const cgroupDelegation = requiredControllers.every((controller) => controllers.includes(controller)) && subtreeControlWritable;
  return {
    platform: process.platform,
    cgroup: command('stat', ['-fc', '%T', '/sys/fs/cgroup']),
    cgroupDelegation,
    cgroupDelegationDetail: `service cgroup=${serviceCgroup}; controllers=${controllers.join(' ') || 'unavailable'}; cgroup.subtree_control writable=${subtreeControlWritable}`,
    userNamespace: userns.ok,
    userNamespaceDetail: userns.detail,
    serviceContextProbe: userns.ok && user === SERVICE_USER,
    serviceContextDetail: `execution user=${user}; ${userns.detail}`,
    subuid, subgid,
    newuidmap: has('newuidmap'), newgidmap: has('newgidmap'),
    slirp4netns: has('slirp4netns'), pasta: has('pasta'),
    fuseOverlayfs: has('fuse-overlayfs'),
    podman: Boolean(podmanVersion), podmanVersion,
    unitReadable: Boolean(unit),
    noNewPrivileges,
    capSetuid, capSetgid,
    protectSystem: unit?.match(/^ProtectSystem\s*=\s*(.+)$/im)?.[1] ?? null,
    protectControlGroups: unit?.match(/^ProtectControlGroups\s*=\s*(.+)$/im)?.[1] ?? null,
    storageWritable, storageDetail, memoryBytes, diskAvailableBytes,
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
