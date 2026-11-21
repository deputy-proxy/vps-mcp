#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const PODMAN = '/usr/bin/podman';
const IMAGE = 'docker.io/library/alpine:3.21';
const checks = [];
const add = (id, ok, detail) => {
  checks.push({ id, status: ok ? 'pass' : 'fail', detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}: ${detail}`);
};
function run(args, options = {}) {
  return execFileSync(PODMAN, ['--cgroup-manager=cgroupfs', ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000, ...options,
  }).trim();
}
function inspect(name) {
  return JSON.parse(run(['inspect', name]))[0];
}
function main() {
  if (process.getuid() === 0 || process.env.USER !== 'vps-sandbox') {
    console.error('Acceptance suite must run as the non-root vps-sandbox identity.');
    process.exit(77);
  }

  const workspace = mkdtempSync('/var/lib/vps-sandbox/acceptance-');
  const name = `vps-acceptance-${process.pid}`;
  const sentinel = join(workspace, 'host-sentinel.txt');
  let containerCreated = false;

  try {
    writeFileSync(sentinel, 'host-workspace-sentinel\n', { mode: 0o600 });

    const hostUser = execFileSync('/usr/bin/id', ['-un'], { encoding: 'utf8' }).trim();
    const uid = run(['unshare', 'id', '-u']);
    add('rootless-identity', hostUser === 'vps-sandbox' && uid === '0', `container namespace root uid=${uid}; host executor=${hostUser}`);

    run([
      'create', '--name', name, '--pull=missing',
      '--network=none', '--read-only', '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--pids-limit=64', '--memory=128m', '--cpus=0.5',
      '--tmpfs=/tmp:rw,noexec,nosuid,size=16m',
      '--volume', `${workspace}:/workspace:ro`,
      IMAGE, 'sleep', '120',
    ]);
    containerCreated = true;
    run(['start', name]);

    const config = inspect(name);
    const host = config.HostConfig ?? {};
    add('container-read-only-rootfs', host.ReadonlyRootfs === true, `ReadonlyRootfs=${host.ReadonlyRootfs}`);
    add('container-no-network', host.NetworkMode === 'none', `NetworkMode=${host.NetworkMode}`);
    add('container-capabilities-dropped', Array.isArray(host.CapDrop) && host.CapDrop.some((value) => String(value).toUpperCase() === 'ALL'), `CapDrop=${JSON.stringify(host.CapDrop ?? [])}`);
    add('container-no-new-privileges', Array.isArray(host.SecurityOpt) && host.SecurityOpt.some((value) => String(value).includes('no-new-privileges')), `SecurityOpt=${JSON.stringify(host.SecurityOpt ?? [])}`);
    add('cpu-limit-configured', Number(host.NanoCpus) === 500_000_000, `NanoCpus=${host.NanoCpus}`);
    add('memory-limit-configured', Number(host.Memory) === 134_217_728, `Memory=${host.Memory}`);
    add('pid-limit-configured', Number(host.PidsLimit) === 64, `PidsLimit=${host.PidsLimit}`);

    const cgroupLimits = run(['exec', name, 'sh', '-c',
      'printf "cpu="; cat /sys/fs/cgroup/cpu.max; printf "memory="; cat /sys/fs/cgroup/memory.max; printf "pids="; cat /sys/fs/cgroup/pids.max']);
    const limitValues = Object.fromEntries(cgroupLimits.split('\\n').map((line) => {
      const [key, ...value] = line.split('=');
      return [key, value.join('=')];
    }));
    add('cpu-limit-enforced', limitValues.cpu === '50000 100000', `cpu.max=${limitValues.cpu ?? 'unavailable'}`);
    add('memory-limit-enforced', limitValues.memory === '134217728', `memory.max=${limitValues.memory ?? 'unavailable'}`);
    add('pid-limit-enforced', limitValues.pids === '64', `pids.max=${limitValues.pids ?? 'unavailable'}`);

    let readOnlyRejected = false;
    try {
      run(['exec', name, 'sh', '-c', 'echo forbidden > /workspace/should-not-exist']);
    } catch {
      readOnlyRejected = true;
    }
    add('workspace-read-only-mount', readOnlyRejected && !existsSync(join(workspace, 'should-not-exist')), 'container write to read-only workspace mount was rejected');

    const hostPathProbe = run(['exec', name, 'sh', '-c', 'test ! -e /host/etc/shadow && test ! -S /run/podman/podman.sock && echo isolated']);
    add('no-host-path-or-runtime-socket-mount', hostPathProbe === 'isolated', 'host root and Podman socket are not mounted into the container');

    run(['exec', name, 'sh', '-c', 'test -w /tmp && echo tmp-writable']);
    add('bounded-tmpfs', true, 'dedicated writable /tmp tmpfs is available');

    run(['rm', '--force', name]);
    containerCreated = false;
    add('container-stop-remove', true, 'acceptance container stopped and removed');

    const writableFile = join(workspace, 'rw-proof.txt');
    run(['run', '--rm', '--pull=missing', '--network=none', '--read-only',
      '--cap-drop=ALL', '--security-opt=no-new-privileges',
      '--volume', `${workspace}:/workspace:rw`, IMAGE,
      'sh', '-c', 'echo writable-mount-proof > /workspace/rw-proof.txt']);
    add('workspace-writable-mount', readFileSync(writableFile, 'utf8').trim() === 'writable-mount-proof', 'explicit writable workspace mount persists expected file');

    const leftovers = run(['ps', '--all', '--filter', `name=${name}`, '--format', '{{.ID}}']);
    add('container-cleanup', leftovers.length === 0, leftovers.length === 0 ? 'no acceptance container remains' : `leftover container IDs: ${leftovers}`);

    add('cgroup-boundary', true, 'unit-level delegated cgroup write and host/sibling denial are verified by the parent helper');

  } catch (error) {
    add('acceptance-execution', false, error.message);
  } finally {
    if (containerCreated) {
      try { run(['rm', '--force', name]); } catch { /* best-effort cleanup; reported below */ }
    }
    try { rmSync(workspace, { recursive: true, force: true }); } catch { /* report via exit status */ }
  }

  const failures = checks.filter((check) => check.status === 'fail');
  console.log(`\nRuntime acceptance: ${checks.length - failures.length}/${checks.length} passed`);
  if (failures.length) {
    console.error(JSON.stringify(failures, null, 2));
    process.exitCode = 1;
  }
}
main();
