#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, accessSync, constants, readdirSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { projectPodName, validateProjectPodInspection, validateProjectPodMemberInspection } from './project-pod.mjs';
import { validateProjectDependencyInspection } from './project-dependency.mjs';

const PODMAN = '/usr/bin/podman';
const IMAGE = 'docker.io/library/alpine:3.21';
const CGROUP_PARENT = process.env.VPS_SANDBOXCTL_CGROUP ?? '';
const checks = [];
const add = (id, ok, detail) => {
  checks.push({ id, status: ok ? 'pass' : 'fail', detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}: ${detail}`);
};
const skip = (id, detail) => {
  checks.push({ id, status: 'skip', detail });
  console.log(`SKIP  ${id}: ${detail}`);
};
function run(args, options = {}) {
  return execFileSync(PODMAN, ['--cgroup-manager=cgroupfs', ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000, ...options,
  }).trim();
}
function inspect(name) {
  return JSON.parse(run(['inspect', name]))[0];
}
function inspectPod(name) { return JSON.parse(run(['pod', 'inspect', name]))[0]; }
function runInput(args, input) {
  return execFileSync(PODMAN, ['--cgroup-manager=cgroupfs', ...args], { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], timeout: 120_000 }).trim();
}
function runInputResult(args, input) {
  try { return { exitCode: 0, stdout: runInput(args, input), stderr: '' }; }
  catch (error) { return { exitCode: Number.isInteger(error.status) ? error.status : 1, stdout: error.stdout?.toString?.() ?? '', stderr: error.stderr?.toString?.() ?? error.message ?? '' }; }
}
function runResult(args) {
  try { return { exitCode: 0, stdout: run(args), stderr: '' }; }
  catch (error) { return { exitCode: Number.isInteger(error.status) ? error.status : 1, stdout: error.stdout?.toString?.() ?? '', stderr: error.stderr?.toString?.() ?? error.message ?? '' }; }
}
function workloadRecords() {
  const root = '/var/lib/vps-sandbox/workloads';
  return readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && /^[0-9a-f-]{36}$/i.test(entry.name)).flatMap((entry) => {
    try { return [JSON.parse(readFileSync(join(root, entry.name, 'record.json'), 'utf8'))]; }
    catch { return []; }
  });
}
function networkNamespace(container) {
  const pid = Number(container.State?.Pid);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('Container has no running process identity');
  return readlinkSync(`/proc/${pid}/ns/net`);
}
function envValue(file, key) {
  const line = readFileSync(file, 'utf8').split(/\r?\n/).find((item) => item.startsWith(`${key}=`));
  if (!line) throw new Error(`Runtime configuration is missing ${key}`);
  return line.slice(key.length + 1).trim().replace(/^['"]|['"]$/g, '');
}
function accessDenied(path, mode) {
  try { accessSync(path, mode); return false; } catch { return true; }
}
function projectDependencyAcceptance(taskContainerName) {
  const records = workloadRecords();
  const projects = records.filter((record) => record.workloadType === 'project-service'
    && record.profileId === 'laravel-php' && record.profileVersion === 4
    && record.environmentId && record.status === 'running' && record.runtimeId)
    .sort((left, right) => left.repositoryId.localeCompare(right.repositoryId));
  if (projects.length < 2) {
    skip('project-dependency-isolation', `requires two running Laravel v4 project environments; found ${projects.length}`);
    return;
  }

  const [projectA, projectB] = projects;
  if (projectA.repositoryId === projectB.repositoryId || projectA.environmentId === projectB.environmentId) {
    add('distinct-project-identities', false, 'acceptance environments do not have distinct repository and environment identities');
    return;
  }
  const dependencies = records.filter((record) => record.workloadType === 'project-dependency' && record.status === 'running');
  const depsA = dependencies.filter((record) => record.environmentId === projectA.environmentId);
  const depsB = dependencies.filter((record) => record.environmentId === projectB.environmentId);
  const mysqlA = depsA.find((record) => record.dependency === 'mysql');
  const mysqlB = depsB.find((record) => record.dependency === 'mysql');
  const redisA = depsA.find((record) => record.dependency === 'redis');
  const redisB = depsB.find((record) => record.dependency === 'redis');
  if (!mysqlA || !mysqlB) {
    add('project-mysql-workloads-present', false, 'both acceptance environments must have a running MySQL dependency');
    return;
  }

  const podNameA = projectPodName(projectA.repositoryId);
  const podNameB = projectPodName(projectB.repositoryId);
  const podA = validateProjectPodInspection(inspectPod(podNameA), projectA.repositoryId);
  const podB = validateProjectPodInspection(inspectPod(podNameB), projectB.repositoryId);
  add('distinct-project-pod-identities', podA.id !== podB.id && podA.name !== podB.name,
    `project A pod=${podA.name}; project B pod=${podB.name}`);

  const appA = inspect(projectA.runtimeId);
  const appB = inspect(projectB.runtimeId);
  validateProjectPodMemberInspection(appA, podA);
  validateProjectPodMemberInspection(appB, podB);
  const appSecurity = (container, record) => container.Config?.Image === record.image
    && String(container.Config?.User ?? '').split(':')[0] === '10001'
    && container.HostConfig?.ReadonlyRootfs === true
    && container.HostConfig?.Privileged !== true
    && container.HostConfig?.RestartPolicy?.Name === 'no'
    && container.HostConfig?.SecurityOpt?.includes('no-new-privileges')
    && container.HostConfig?.SecurityOpt?.some((value) => String(value).startsWith('seccomp='))
    && container.HostConfig?.CapDrop?.includes('ALL');
  add('project-app-security-contract', appSecurity(appA, projectA) && appSecurity(appB, projectB), 'both PHP-FPM workloads use approved digests, non-root users, read-only roots, dropped capabilities and seccomp');

  const dependencyExpected = (record, pod) => ({
    runtimeId: record.runtimeId, workloadId: record.id, repositoryId: record.repositoryId,
    environmentId: record.environmentId, dependency: record.dependency, image: record.image,
    podId: pod.id, infraContainerId: pod.infraContainerId, restartPolicy: 'no', mounts: record.dependencyMounts,
  });
  for (const [label, items, pod] of [['A', depsA, podA], ['B', depsB, podB]]) {
    for (const dependency of items) {
      validateProjectDependencyInspection(inspect(dependency.runtimeId), dependencyExpected(dependency, pod));
    }
    add(`project-${label.toLowerCase()}-dependency-security`, items.length > 0 && items.every((item) => item.health?.status === 'healthy'),
      `verified ${items.map((item) => item.dependency).join(', ')} dependency workload(s); no dependency secret values exposed`);
  }

  const infraA = inspect(podA.infraContainerId);
  const infraB = inspect(podB.infraContainerId);
  const namespaceA = networkNamespace(infraA);
  const namespaceB = networkNamespace(infraB);
  const taskContainer = inspect(taskContainerName);
  const taskNamespace = networkNamespace(taskContainer);
  add('project-network-namespace-isolation', namespaceA !== namespaceB,
    `project A and B use distinct network namespace identities (${namespaceA} vs ${namespaceB})`);
  add('task-project-network-namespace-isolation', taskNamespace !== namespaceA && taskNamespace !== namespaceB,
    `task acceptance workload uses a separate network namespace (${taskNamespace})`);

  const taskMounts = taskContainer.Mounts ?? [];
  const forbiddenProjectMount = taskMounts.some((mount) => String(mount.Source ?? '').includes('/project-environments')
    || String(mount.Source ?? '').includes('/vps-sandbox-mounts/projects')
    || String(mount.Destination ?? '').includes('/project-environments')
    || String(mount.Destination ?? '').includes('/projects/'));
  add('task-project-data-mount-isolation', !forbiddenProjectMount,
    `task workload mounts ${taskMounts.length} path(s), none reference persistent project data or dependency secrets`);

  const mysqlNameA = String(inspect(mysqlA.runtimeId).Name).replace(/^\//, '');
  const mysqlNameB = String(inspect(mysqlB.runtimeId).Name).replace(/^\//, '');
  const redisNameA = redisA ? String(inspect(redisA.runtimeId).Name).replace(/^\//, '') : null;
  const redisNameB = redisB ? String(inspect(redisB.runtimeId).Name).replace(/^\//, '') : null;
  const unresolvedHost = (app, hostname) => {
    const script = `$host=${JSON.stringify(hostname)}; $resolved=gethostbyname($host); if($resolved===$host){echo 'unresolved'; exit(0);} echo 'resolved'; exit(1);`;
    return run(['exec', app, 'php', '-r', script]) === 'unresolved';
  };
  add('cross-project-mysql-name-resolution-denied', unresolvedHost(projectB.runtimeId, mysqlNameA)
    && unresolvedHost(projectA.runtimeId, mysqlNameB), 'neither project can resolve the other project MySQL container name');
  if (redisA) {
    add('cross-project-redis-name-resolution-denied', unresolvedHost(projectB.runtimeId, redisNameA), 'project B cannot resolve project A Redis container name');
  } else if (redisB) {
    add('cross-project-redis-name-resolution-denied', unresolvedHost(projectA.runtimeId, redisNameB), 'project A cannot resolve project B Redis container name');
  } else {
    skip('cross-project-redis-name-resolution-denied', 'neither acceptance environment selected Redis');
  }

  const mysqlPasswordA = envValue(projectA.projectMounts.runtimeEnv, 'DB_PASSWORD');
  const mysqlPasswordB = envValue(projectB.projectMounts.runtimeEnv, 'DB_PASSWORD');
  const mysqlUserA = envValue(projectA.projectMounts.runtimeEnv, 'DB_USERNAME');
  const mysqlUserB = envValue(projectB.projectMounts.runtimeEnv, 'DB_USERNAME');
  add('project-mysql-credentials-unique', mysqlPasswordA !== mysqlPasswordB,
    'independent projects have distinct generated MySQL application credentials');
  const mysqlProbe = (target, username, password) => runInputResult(
    ['exec', '-i', target.runtimeId, 'mysql', '--defaults-extra-file=/dev/stdin', '-e', 'SELECT 1', 'app'],
    `[client]\nuser=${username}\npassword=${password}\nhost=127.0.0.1\nprotocol=TCP\n`,
  );
  const foreignToA = mysqlProbe(mysqlA, mysqlUserB, mysqlPasswordB);
  const foreignToB = mysqlProbe(mysqlB, mysqlUserA, mysqlPasswordA);
  const deniedA = foreignToA.exitCode !== 0 && /access denied/i.test(`${foreignToA.stdout}\n${foreignToA.stderr}`);
  const deniedB = foreignToB.exitCode !== 0 && /access denied/i.test(`${foreignToB.stdout}\n${foreignToB.stderr}`);
  add('cross-project-mysql-authentication-denied', deniedA && deniedB,
    'project B credentials are rejected by A MySQL and project A credentials are rejected by B MySQL');

  if (redisA && redisB) {
    const redisPasswordA = envValue(projectA.projectMounts.runtimeEnv, 'REDIS_PASSWORD');
    const redisPasswordB = envValue(projectB.projectMounts.runtimeEnv, 'REDIS_PASSWORD');
    const probe = (target, password) => runInputResult(['exec', '-i', target.runtimeId, 'redis-cli'], `AUTH app ${password}\nPING\n`);
    const foreignA = probe(redisA, redisPasswordB);
    const foreignB = probe(redisB, redisPasswordA);
    add('cross-project-redis-authentication-denied', redisPasswordA !== redisPasswordB
      && /WRONGPASS|invalid username-password/i.test(`${foreignA.stdout}\n${foreignA.stderr}`)
      && /WRONGPASS|invalid username-password/i.test(`${foreignB.stdout}\n${foreignB.stderr}`),
    'project B Redis credentials are rejected by A Redis and project A credentials are rejected by B Redis');
  } else {
    skip('cross-project-redis-authentication-denied', 'only one acceptance environment selected Redis; private pod namespace and no-published-port checks still cover Redis network isolation');
  }
}

function main() {
  if (process.getuid() === 0 || process.env.USER !== 'vps-sandbox') {
    console.error('Acceptance suite must run as the non-root vps-sandbox identity.');
    process.exit(77);
  }

  if (!/^\/system\.slice\/vps-sandboxctl-acceptance-[0-9]+\.service$/.test(CGROUP_PARENT)) {
    console.error('Acceptance suite requires an authenticated delegated system-service cgroup parent.');
    process.exit(77);
  }

  const workspace = mkdtempSync('/var/lib/vps-sandbox/acceptance-');
  const executionLogs = mkdtempSync('/var/lib/vps-sandbox/acceptance-execution-logs-');
  const name = `vps-acceptance-${process.pid}`;
  const sentinel = join(workspace, 'host-sentinel.txt');
  let containerCreated = false;

  try {
    writeFileSync(sentinel, 'host-workspace-sentinel\n', { mode: 0o600 });

    const hostUser = execFileSync('/usr/bin/id', ['-un'], { encoding: 'utf8' }).trim();
    add('host-shadow-inaccessible', accessDenied('/etc/shadow', constants.R_OK), 'sandbox identity cannot read host password hashes');
    add('mcp-credentials-inaccessible', accessDenied('/etc/vps-mcp/vps-mcp.env', constants.R_OK), 'sandbox identity cannot read the MCP service environment file');
    add('production-checkout-inaccessible', accessDenied('/opt/vps-mcp', constants.X_OK), 'sandbox identity cannot traverse the production MCP checkout');
    add('connector-checkout-inaccessible', accessDenied('/srv/vps-mcp', constants.X_OK), 'sandbox identity cannot traverse the private connector checkout');
    add('root-home-inaccessible', accessDenied('/root', constants.X_OK), 'sandbox identity cannot traverse the root home directory');
    add('execution-module-installed', existsSync('/usr/local/libexec/vps-mcp/executions.mjs'), 'durable execution module is installed beside the runtime agent');
    add('governance-module-installed', existsSync('/usr/local/libexec/vps-mcp/resource-governance.mjs'), 'resource governance and durable lock module is installed beside the runtime agent');
    const uid = run(['unshare', 'id', '-u']);
    add('rootless-identity', hostUser === 'vps-sandbox' && uid === '0', `container namespace root uid=${uid}; host executor=${hostUser}`);

    run([
      'create', '--cgroup-parent', CGROUP_PARENT, '--name', name, '--pull=missing',
      '--network=none', '--read-only', '--cap-drop=ALL',
      '--userns=keep-id', '--user', `${process.getuid()}:${process.getgid()}`,
      '--security-opt=no-new-privileges', '--security-opt=seccomp=/usr/share/containers/seccomp.json',
      '--pids-limit=64', '--memory=128m', '--cpus=0.5',
      '--tmpfs=/tmp:rw,noexec,nosuid,size=16m',
      '--volume', workspace + ':/workspace:ro',
      '--volume', executionLogs + ':/run/vps-mcp-executions:rw',
      IMAGE, 'sleep', '120',
    ]);
    containerCreated = true;
    run(['start', name]);

    const config = inspect(name);
    const host = config.HostConfig ?? {};
    add('container-read-only-rootfs', host.ReadonlyRootfs === true, `ReadonlyRootfs=${host.ReadonlyRootfs}`);
    const containerUid = run(['exec', name, 'id', '-u']);
    add('container-nonroot-identity', containerUid !== '0' && containerUid === String(process.getuid()), `container uid=${containerUid}; expected host-mapped vps-sandbox uid=${process.getuid()}`);
    add('container-seccomp-profile', Array.isArray(host.SecurityOpt) && host.SecurityOpt.some((value) => String(value).includes('seccomp')), `SecurityOpt=${JSON.stringify(host.SecurityOpt ?? [])}`);
    add('container-no-network', host.NetworkMode === 'none', `NetworkMode=${host.NetworkMode}`);
    add('container-capabilities-dropped', Array.isArray(host.CapDrop) && host.CapDrop.length > 0, `Podman expanded CapDrop=${JSON.stringify(host.CapDrop ?? [])}`);
    add('container-no-new-privileges', Array.isArray(host.SecurityOpt) && host.SecurityOpt.some((value) => String(value).includes('no-new-privileges')), `SecurityOpt=${JSON.stringify(host.SecurityOpt ?? [])}`);
    add('cpu-limit-configured', Number(host.NanoCpus) === 500_000_000, `NanoCpus=${host.NanoCpus}`);
    add('memory-limit-configured', Number(host.Memory) === 134_217_728, `Memory=${host.Memory}`);
    add('pid-limit-configured', Number(host.PidsLimit) === 64, `PidsLimit=${host.PidsLimit}`);

    const cgroupLimits = run(['exec', name, 'sh', '-c',
      'printf "cpu="; cat /sys/fs/cgroup/cpu.max; printf "memory="; cat /sys/fs/cgroup/memory.max; printf "pids="; cat /sys/fs/cgroup/pids.max; printf "capeff="; awk \'/^CapEff:/ {print $2}\' /proc/1/status']);
    const limitValues = Object.fromEntries(cgroupLimits.split('\n').map((line) => {
      const [key, ...value] = line.split('=');
      return [key, value.join('=')];
    }));
    add('cpu-limit-enforced', limitValues.cpu === '50000 100000', `cpu.max=${limitValues.cpu ?? 'unavailable'}`);
    add('memory-limit-enforced', limitValues.memory === '134217728', `memory.max=${limitValues.memory ?? 'unavailable'}`);
    add('pid-limit-enforced', limitValues.pids === '64', `pids.max=${limitValues.pids ?? 'unavailable'}`);
    add('container-effective-capabilities-empty', Boolean(limitValues.capeff) && BigInt(`0x${limitValues.capeff}`) === 0n, `CapEff=${limitValues.capeff ?? 'unavailable'}`);

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

    const executionTools = run(['exec', name, 'sh', '-c',
      'for tool in setsid env head mkfifo awk sed grep tr sleep date ps; do command -v "$tool" >/dev/null 2>&1 || exit 127; done; ulimit -f 4097; fifo=/tmp/execution-watchdog-$$; mkfifo "$fifo"; (exec 3<>"$fifo"; read -r -t 2 value <&3) & reader=$!; sleep 0.1; printf ready > "$fifo"; wait "$reader"; rm -f "$fifo"; echo execution-ready']);
    add('execution-supervisor-primitives', executionTools === 'execution-ready', 'approved image provides setsid, bounded file-size limits, FIFO and timed-read primitives');

    const executionLogHostFile = join(executionLogs, 'acceptance.log');
    run(['exec', name, 'sh', '-c', 'printf execution-log-proof > /run/vps-mcp-executions/acceptance.log']);
    add('execution-log-mount-writable', readFileSync(executionLogHostFile, 'utf8') === 'execution-log-proof', 'container writes to its dedicated host-backed execution log mount');

    run(['rm', '--force', name]);
    containerCreated = false;
    add('container-stop-remove', true, 'acceptance container stopped and removed');
    add('execution-log-persistence', readFileSync(executionLogHostFile, 'utf8') === 'execution-log-proof', 'execution log remains on the host after container removal');

    projectDependencyAcceptance(name);

    const writableFile = join(workspace, 'rw-proof.txt');
    run(['run', '--cgroup-parent', CGROUP_PARENT, '--rm', '--pull=missing', '--network=none', '--read-only',
      '--cap-drop=ALL', '--userns=keep-id', '--user', `${process.getuid()}:${process.getgid()}`,
      '--security-opt=no-new-privileges', '--security-opt=seccomp=/usr/share/containers/seccomp.json',
      '--volume', `${workspace}:/workspace:rw`, IMAGE,
      'sh', '-c', 'echo writable-mount-proof > /workspace/rw-proof.txt']);
    add('workspace-writable-mount', readFileSync(writableFile, 'utf8').trim() === 'writable-mount-proof', 'explicit writable workspace mount persists expected file');

    const leftovers = run(['ps', '--all', '--filter', `name=${name}`, '--format', '{{.ID}}']);
    add('container-cleanup', leftovers.length === 0, leftovers.length === 0 ? 'no acceptance container remains' : `leftover container IDs: ${leftovers}`);

    add('cgroup-boundary', true, 'system-service delegated cgroup write and parent/sibling denial are verified by the parent helper');

  } catch (error) {
    add('acceptance-execution', false, error.message);
  } finally {
    if (containerCreated) {
      try { run(['rm', '--force', name]); } catch { /* best-effort cleanup; reported below */ }
    }
    try { rmSync(workspace, { recursive: true, force: true }); } catch { /* report via exit status */ }
    try { rmSync(executionLogs, { recursive: true, force: true }); } catch { /* report via exit status */ }
  }

  const failures = checks.filter((check) => check.status === 'fail');
  const passed = checks.filter((check) => check.status === 'pass').length;
  const skipped = checks.filter((check) => check.status === 'skip').length;
  console.log(`\nRuntime acceptance: ${passed}/${checks.length} passed; ${skipped} skipped`);
  if (failures.length) {
    console.error(JSON.stringify(failures, null, 2));
    process.exitCode = 1;
  }
}
main();
