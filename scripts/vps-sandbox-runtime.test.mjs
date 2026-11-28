import { describe, expect, it } from 'vitest';
import { assertWorkloadTypeMatch, buildContainerCreateArgs, expectedTaskWorkspacePath, parseRuntimeRequest, buildSandboxExecArgs, buildSandboxFilesystemScript, buildSandboxFilesystemArgs, parseSandboxDirectoryListing, decodeSandboxFile, assertTaskWorkspaceWritable, assertTaskSandboxWorkload, validateProjectServiceCgroupV2Limits, boundedSandboxOutput, hasSandboxCapacity, isSandboxBusy, safeImage, reconcileSandboxOperationRecord, workspacePathsForStorageScan, workspaceMountRecoveryCandidates, durableLockKeys, isNewWorkOperation, normalizePodmanTimestamp, parseNetworkNamespaceCounters, parsePodmanInspectResult, projectServiceBootRecoveryAction, projectDependencyBootRecoveryAction, projectServiceMissingWorkloadReconciliationAllowed, buildPodmanEnvironment, projectServiceHealthProbeCommand, waitForProjectServiceHealth, configuredProjectEnvironmentRoots, expectedProjectServiceMountSources, validateProjectServiceContainerMounts } from './vps-sandbox-runtime.mjs';
import { resourceReservationMatches } from './resource-governance.mjs';
import { projectPodName } from './project-pod.mjs';
import { projectDependencyWorkloadId } from './project-dependency.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

describe('Podman subprocess environment', () => {
  it('preserves the runtime service temporary directory for image pulls', () => {
    expect(buildPodmanEnvironment({ TMPDIR: '/var/lib/vps-sandbox/tmp' }).TMPDIR).toBe('/var/lib/vps-sandbox/tmp');
  });

  it('falls back to Podman default temporary directory when TMPDIR is unset', () => {
    expect(buildPodmanEnvironment({}).TMPDIR).toBe('/var/tmp');
  });
});


describe('persistent project-service PHP-FPM health checks', () => {
  it('probes the configured TCP listener as the non-root application user', () => {
    const probe = projectServiceHealthProbeCommand();
    expect(probe.slice(0, 2)).toEqual(['php', '-r']);
    expect(probe[2]).toContain("fsockopen('127.0.0.1', 9000");
    expect(probe[2]).toContain("new PDO('mysql:host=127.0.0.1;port=3306;dbname='");
    expect(probe[2]).toContain("$redis->auth([$env['REDIS_USERNAME'] ?? 'app', $env['REDIS_PASSWORD']])");
    expect(probe[2]).not.toContain('DB_PASSWORD=');
    expect(probe[2]).not.toContain('REDIS_PASSWORD=');
  });

  it('retries transient startup failures and returns verified health evidence', async () => {
    let calls = 0;
    const health = await waitForProjectServiceHealth(async () => {
      calls += 1;
      if (calls < 3) throw new Error('not ready');
    }, { attempts: 4, intervalMs: 0 });
    expect(calls).toBe(3);
    expect(health).toMatchObject({ status: 'healthy', checks: ['php-fpm'], attempts: 3 });
    expect(Number.isNaN(Date.parse(health.checkedAt))).toBe(false);
  });

  it('fails closed after the bounded health-check retry budget', async () => {
    let calls = 0;
    await expect(waitForProjectServiceHealth(async () => {
      calls += 1;
      throw new Error('not ready');
    }, { attempts: 3, intervalMs: 0 })).rejects.toThrow('PHP-FPM health check failed after 3 attempts');
    expect(calls).toBe(3);
  });

  it('rejects unbounded or invalid retry settings', async () => {
    await expect(waitForProjectServiceHealth(async () => {}, { attempts: 100 })).rejects.toThrow('between 1 and 30');
    await expect(waitForProjectServiceHealth(async () => {}, { attempts: 1, intervalMs: 6000 })).rejects.toThrow('between 0 and 5000ms');
  });
});

describe('project-service container mount contract', () => {
  const root = '/var/lib/vps-sandbox-mounts/projects/repo/workload';
  const mounts = { release: `${root}/release`, storage: `${root}/storage`, cache: `${root}/cache`, logs: `${root}/logs`, runtimeEnv: `${root}/runtime-config/runtime.env` };
  const inspected = { Mounts: [
    { Type: 'bind', Source: mounts.release, Destination: '/app', RW: false },
    { Type: 'bind', Source: mounts.storage, Destination: '/app/storage', RW: true },
    { Type: 'bind', Source: mounts.cache, Destination: '/app/bootstrap/cache', RW: true },
    { Type: 'bind', Source: mounts.logs, Destination: '/app/storage/logs', RW: true },
    { Type: 'bind', Source: mounts.runtimeEnv, Destination: '/app/.env', RW: false },
  ] };
  it('accepts only the canonical read-only release and runtime config plus writable data mounts', () => {
    expect(validateProjectServiceContainerMounts(inspected, mounts)).toEqual({ verified: true, count: 5 });
  });
  it('rejects unexpected host mounts and writable application configuration', () => {
    expect(() => validateProjectServiceContainerMounts({ Mounts: [...inspected.Mounts, { Type: 'bind', Source: '/etc/shadow', Destination: '/run/shadow', RW: false }] }, mounts)).toThrow('unexpected host bind mount');
    expect(() => validateProjectServiceContainerMounts({ Mounts: inspected.Mounts.map((mount) => mount.Destination === '/app/.env' ? { ...mount, RW: true } : mount) }, mounts)).toThrow('canonical read/write contract');
  });
});

describe('project-service boot recovery policy', () => {
  const project = (status) => ({ workloadType: 'project-service', status });
  it.each([
    [project('running'), 'running', 'start'],
    [project('starting'), 'exited', 'start'],
    [project('running'), 'missing', 'operator-review'],
    [project('stopping'), 'running', 'stop'],
    [project('stopping'), 'missing', 'operator-review'],
    [project('removing'), 'missing', 'remove'],
    [project('creating'), 'created', 'reconcile-create'],
    [project('creating'), 'missing', 'operator-review'],
    [project('created'), 'running', 'stop'],
    [project('created'), 'exited', 'reconcile-create'],
    [project('created'), 'created', 'skip'],
    [project('stopped'), 'exited', 'skip'],
    [project('stopped'), 'missing', 'operator-review'],
    [project('removed'), 'missing', 'skip'],
    [{ workloadType: 'task', status: 'running' }, 'running', 'skip'],
  ])('chooses %s / %s -> %s', (record, runtimeState, expected) => {
    expect(projectServiceBootRecoveryAction(record, runtimeState)).toBe(expected);
  });
  it('follows durable desired state when lifecycle status alone is ambiguous', () => {
    expect(projectServiceBootRecoveryAction(project('stopped'), 'exited')).toBe('skip');
    expect(projectServiceBootRecoveryAction({ ...project('stopped'), desiredState: 'running' }, 'exited')).toBe('start');
    expect(projectServiceBootRecoveryAction({ ...project('running'), desiredState: 'stopped' }, 'running')).toBe('stop');
    expect(projectServiceBootRecoveryAction({ ...project('stopped'), desiredState: 'stopped' }, 'missing')).toBe('operator-review');
  });
});

describe('project-service boot recovery policy', () => {
  const project = (status) => ({ workloadType: 'project-service', status });
  it.each([
    [project('running'), 'running', 'start'],
    [project('starting'), 'exited', 'start'],
    [project('running'), 'missing', 'operator-review'],
    [project('stopping'), 'running', 'stop'],
    [project('stopping'), 'missing', 'operator-review'],
    [project('removing'), 'missing', 'remove'],
    [project('creating'), 'created', 'reconcile-create'],
    [project('creating'), 'missing', 'operator-review'],
    [project('created'), 'running', 'stop'],
    [project('created'), 'exited', 'reconcile-create'],
    [project('created'), 'created', 'skip'],
    [project('stopped'), 'exited', 'skip'],
    [project('stopped'), 'missing', 'operator-review'],
    [project('removed'), 'missing', 'skip'],
    [{ workloadType: 'task', status: 'running' }, 'running', 'skip'],
  ])('chooses %s / %s -> %s', (record, runtimeState, expected) => {
    expect(projectServiceBootRecoveryAction(record, runtimeState)).toBe(expected);
  });
});

describe('explicit project-service missing-record reconciliation', () => {
  const record = { id: '134e5321-b4d7-4d4f-be92-ce56a984adaa', workloadType: 'project-service', status: 'unknown' };
  it('allows reconciliation only for an unknown project service with no runtime identity or matching container', () => {
    expect(projectServiceMissingWorkloadReconciliationAllowed(record, null, [])).toBe(true);
  });
  it.each([
    [{ ...record, status: 'running' }, null, [], false],
    [record, 'abcdef123456', [], false],
    [record, null, [{ workloadId: record.id }], false],
    [record, null, [], true],
    [{ ...record, workloadType: 'task' }, null, [], false],
  ])('rejects unsafe reconciliation evidence %#', (candidate, runtimeId, containers, namedContainerExists) => {
    expect(projectServiceMissingWorkloadReconciliationAllowed(candidate, runtimeId, containers, namedContainerExists)).toBe(false);
  });
});

describe('dashboard runtime metric parsers', () => {
  it('normalizes Podman Go timestamps with timezone abbreviations', () => {
    expect(normalizePodmanTimestamp('2026-11-26 00:25:29.41056272 +0100 CET')).toBe('2026-11-25T23:25:29.410Z');
    expect(normalizePodmanTimestamp('0001-01-01 00:00:00 +0000 UTC')).toBe('0001-01-01T00:00:00.000Z');
    expect(normalizePodmanTimestamp('not-a-date')).toBeNull();
  });

  it('reads Podman inspect output in either object or array form', () => {
    const state = { Running: true, Pid: 4321, StartedAt: '2026-11-26 00:25:29.41056272 +0100 CET' };
    const expected = { startedAt: '2026-11-25T23:25:29.410Z', networkPid: 4321 };
    expect(parsePodmanInspectResult([{ State: state }])).toEqual(expected);
    expect(parsePodmanInspectResult({ State: state })).toEqual(expected);
    expect(parsePodmanInspectResult({ State: { Running: false, Pid: 0 } })).toEqual({ startedAt: null, networkPid: null });
  });

  it('sums per-network-namespace byte counters and excludes loopback', () => {
    const sample = [
      'Inter-|   Receive                                                |  Transmit',
      ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
      '    lo: 900 9 0 0 0 0 0 0 900 9 0 0 0 0 0 0',
      '  eth0: 1200 12 0 0 0 0 0 0 3400 34 0 0 0 0 0 0',
      '  eth1: 800 8 0 0 0 0 0 0 600 6 0 0 0 0 0 0',
    ].join(String.fromCharCode(10));
    expect(parseNetworkNamespaceCounters(sample)).toEqual({ rxBytes: 2000, txBytes: 4000 });
    expect(parseNetworkNamespaceCounters('bad')).toBeNull();
  });
});

describe('project-service effective cgroup limits', () => {
  const resources = { cpuMilli: 500, memoryMiB: 1024, pids: 128 };
  const valid = { memoryMax: String(1024 * 1024 * 1024), memorySwapMax: '0', cpuMax: '50000 100000', pidsMax: '128' };
  it('accepts bounded effective CPU, memory, zero-swap and PID limits', () => {
    expect(validateProjectServiceCgroupV2Limits(valid, resources)).toEqual({ memoryMax: valid.memoryMax, cpuMax: valid.cpuMax, pidsMax: valid.pidsMax });
  });
  it('rejects missing, unbounded, over-reserved and swap-enabled limits', () => {
    expect(() => validateProjectServiceCgroupV2Limits({ ...valid, memoryMax: 'max' }, resources)).toThrow('memory.max');
    expect(() => validateProjectServiceCgroupV2Limits({ ...valid, memoryMax: String(2 * 1024 * 1024 * 1024) }, resources)).toThrow('memory.max');
    expect(() => validateProjectServiceCgroupV2Limits({ ...valid, memorySwapMax: '1' }, resources)).toThrow('memory.swap.max');
    expect(() => validateProjectServiceCgroupV2Limits({ ...valid, cpuMax: 'max 100000' }, resources)).toThrow('cpu.max');
    expect(() => validateProjectServiceCgroupV2Limits({ ...valid, cpuMax: '60000 100000' }, resources)).toThrow('CPU quota');
    expect(() => validateProjectServiceCgroupV2Limits({ ...valid, pidsMax: 'max' }, resources)).toThrow('pids.max');
    expect(() => validateProjectServiceCgroupV2Limits({ ...valid, pidsMax: '256' }, resources)).toThrow('pids.max');
  });
});

describe('persistent project resource reservation idempotency', () => {
  const resources = { cpuMilli: 500, memoryMiB: 1024, pids: 128, diskMiB: 10240 };

  it('recognizes an identical active reservation as a no-op', () => {
    expect(resourceReservationMatches({ status: 'reserved', resources }, resources)).toBe(true);
  });

  it('does not treat released or changed reservations as identical', () => {
    expect(resourceReservationMatches({ status: 'released', resources }, resources)).toBe(false);
    expect(resourceReservationMatches({ status: 'reserved', resources: { ...resources, memoryMiB: 2048 } }, resources)).toBe(false);
    expect(resourceReservationMatches(null, resources)).toBe(false);
  });
});

describe('rootless workload runtime request validation', () => {
  it.each([
    { operation: 'image.inspect', image: `docker.io/library/node@sha256:${'a'.repeat(64)}` },
    { operation: 'container.list' },
    { operation: 'dashboard.inventory' },
    { operation: 'project-dependency.prepare-secrets', repositoryId: 'deputy-proxy-vps-mcp', environmentId: '134e5321-b4d7-4d4f-be92-ce56a984adaa', mysqlEnabled: true, redisEnabled: true },
    {
      operation: 'project-dependency.create',
      workloadId: projectDependencyWorkloadId('134e5321-b4d7-4d4f-be92-ce56a984adaa', 'mysql'),
      environmentId: '134e5321-b4d7-4d4f-be92-ce56a984adaa', repositoryId: 'deputy-proxy-vps-mcp', dependency: 'mysql',
      image: 'dhi.io/mysql@sha256:50f6fc4ce3fe8c156e912236124ad0efbcfcb02e910158acf6fea3ec18d131f1',
      resources: { cpuMilli: 500, memoryMiB: 768, pids: 128, diskMiB: 10240 },
      reservationResources: { cpuMilli: 1200, memoryMiB: 2048, pids: 320, diskMiB: 21504 },
      restartPolicy: 'no', podName: projectPodName('deputy-proxy-vps-mcp'),
    },
    { operation: 'project-dependency.inspect', workloadId: projectDependencyWorkloadId('134e5321-b4d7-4d4f-be92-ce56a984adaa', 'mysql') },
    { operation: 'project-dependency.start', workloadId: projectDependencyWorkloadId('134e5321-b4d7-4d4f-be92-ce56a984adaa', 'mysql') },
    { operation: 'project-dependency.stop', workloadId: projectDependencyWorkloadId('134e5321-b4d7-4d4f-be92-ce56a984adaa', 'mysql') },
    { operation: 'project-dependency.remove', workloadId: projectDependencyWorkloadId('134e5321-b4d7-4d4f-be92-ce56a984adaa', 'mysql'), repositoryId: 'deputy-proxy-vps-mcp', dependency: 'mysql' },
    { operation: 'project-dependency.recover' },
    {
      operation: 'project-backup.create', repositoryId: 'deputy-proxy-vps-mcp',
      environmentId: '134e5321-b4d7-4d4f-be92-ce56a984adaa', profileId: 'laravel-php', profileVersion: 4,
      applicationWorkloadId: '334e5321-b4d7-4d4f-be92-ce56a984adaa', enabledDependencies: ['mysql'],
      backupId: '234e5321-b4d7-4d4f-be92-ce56a984adaa',
    },
    {
      operation: 'project-backup.restore', repositoryId: 'deputy-proxy-vps-mcp',
      environmentId: '134e5321-b4d7-4d4f-be92-ce56a984adaa', profileId: 'laravel-php', profileVersion: 4,
      applicationWorkloadId: '334e5321-b4d7-4d4f-be92-ce56a984adaa', enabledDependencies: ['mysql', 'redis'],
      backupId: '234e5321-b4d7-4d4f-be92-ce56a984adaa', confirm: true,
    },
    { operation: 'container.inspect', workloadId: '134e5321-b4d7-4d4f-be92-ce56a984adaa' },
    {
      operation: 'container.create',
      workloadId: '134e5321-b4d7-4d4f-be92-ce56a984adaa',
      workloadType: 'task',
      repositoryId: 'deputy-proxy-vps-mcp',
      image: `docker.io/library/node@sha256:${'a'.repeat(64)}`,
      network: 'none',
      readOnlyRootfs: true,
      resources: { cpuMilli: 500, memoryMiB: 512, pids: 64 },
    },
  ])('accepts the approved request shape %#', (request) => {
    expect(parseRuntimeRequest(JSON.stringify(request))).toEqual(request);
  });

  it('accepts dedicated project-service lifecycle operations and rejects generic project-service container creation', () => {
    const id = '134e5321-b4d7-4d4f-be92-ce56a984adaa';
    const image = 'ghcr.io/deputy-proxy/vps-mcp-laravel-php@sha256:' + 'a'.repeat(64);
    const previous = process.env.VPS_SANDBOX_ALLOWED_IMAGES;
    process.env.VPS_SANDBOX_ALLOWED_IMAGES = image;
    const create = { operation: 'project-service.create', workloadId: id, environmentId: id, profileId: 'laravel-php', profileVersion: 4, dependencies: [], repositoryId: 'deputy-proxy-vps-mcp', releaseId: id, image, resources: { cpuMilli: 500, memoryMiB: 1024, pids: 128, diskMiB: 10240 }, reservationResources: { cpuMilli: 1200, memoryMiB: 2048, pids: 320, diskMiB: 21504 }, restartPolicy: 'unless-stopped', command: ['--nodaemonize'] };
    expect(parseRuntimeRequest(JSON.stringify(create))).toEqual(create);
    expect(() => parseRuntimeRequest(JSON.stringify({ ...create, reservationResources: { cpuMilli: 1200, memoryMiB: 2048, pids: 320 } }))).toThrow('Aggregate project reservation must define all four resource dimensions');
    expect(() => parseRuntimeRequest(JSON.stringify({ ...create, resources: { cpuMilli: 500, memoryMiB: 1024, pids: 128 } }))).toThrow('Project-service resources must define all four resource dimensions');
    expect(() => parseRuntimeRequest(JSON.stringify({ ...create, restartPolicy: 'on-failure' }))).toThrow('restart policy');
    if (previous === undefined) delete process.env.VPS_SANDBOX_ALLOWED_IMAGES; else process.env.VPS_SANDBOX_ALLOWED_IMAGES = previous;
    for (const operation of ['project-service.inspect','project-service.start','project-service.stop','project-service.remove']) {
      expect(parseRuntimeRequest(JSON.stringify(operation === 'project-service.remove'
        ? { operation, workloadId: id, repositoryId: 'deputy-proxy-vps-mcp', releaseId: id }
        : { operation, workloadId: id }))).toMatchObject({ operation, workloadId: id });
    }
    expect(() => parseRuntimeRequest(JSON.stringify({ operation: 'container.create', workloadId: id, workloadType: 'project-service', repositoryId: 'repo', image }))).toThrow('task workloads');
    expect(() => parseRuntimeRequest(JSON.stringify({ operation: 'project-service.create', ...create, arbitraryHostPath: '/etc' }))).toThrow('unsupported properties');
  });
  it('accepts dashboard inventory as a read-only operation with no caller-controlled arguments', () => {
    expect(parseRuntimeRequest(JSON.stringify({ operation: 'dashboard.inventory' })))
      .toEqual({ operation: 'dashboard.inventory' });
    expect(() => parseRuntimeRequest(JSON.stringify({ operation: 'dashboard.inventory', workloadId: '134e5321-b4d7-4d4f-be92-ce56a984adaa' })))
      .toThrow('unsupported properties');
    expect(isNewWorkOperation({ operation: 'dashboard.inventory' })).toBe(false);
  });

  it('validates workspace write lease operations and serializes them with maintenance pause', () => {
    const worktreeId = '134e5321-b4d7-4d4f-be92-ce56a984adaa';
    expect(parseRuntimeRequest(JSON.stringify({ operation: 'workspace.write.begin', repositoryId: 'repo-123', worktreeId })))
      .toMatchObject({ operation: 'workspace.write.begin', repositoryId: 'repo-123', worktreeId });
    expect(parseRuntimeRequest(JSON.stringify({ operation: 'workspace.write.finish', leaseId: worktreeId })))
      .toMatchObject({ operation: 'workspace.write.finish', leaseId: worktreeId });
    expect(() => parseRuntimeRequest(JSON.stringify({ operation: 'workspace.write.begin', repositoryId: '../repo', worktreeId }))).toThrow('Invalid repository ID');
    expect(() => parseRuntimeRequest(JSON.stringify({ operation: 'workspace.write.finish', leaseId: 'not-a-uuid' }))).toThrow('Invalid workload ID');
    expect(isNewWorkOperation({ operation: 'workspace.write.begin' })).toBe(true);
    expect(durableLockKeys({ operation: 'workspace.write.begin', worktreeId })).toEqual(['maintenance:global', `worktree:${worktreeId}`]);
    expect(durableLockKeys({ operation: 'cleanup.pause' })).toEqual(['maintenance:global']);
    expect(isNewWorkOperation({ operation: 'sandbox.fs.write' })).toBe(true);
  });

  it('derives task workspace mounts from the registered repository/worktree identity', () => {
    expect(expectedTaskWorkspacePath('/var/lib/vps-mcp/task-workspaces/worktrees', 'deputy-proxy-vps-mcp', '134e5321-b4d7-4d4f-be92-ce56a984adaa'))
      .toBe('/var/lib/vps-mcp/task-workspaces/worktrees/deputy-proxy-vps-mcp/134e5321-b4d7-4d4f-be92-ce56a984adaa');
    expect(() => expectedTaskWorkspacePath('/var/lib/vps-mcp/task-workspaces', 'repo', '134e5321-b4d7-4d4f-be92-ce56a984adaa')).toThrow('not approved');
    expect(() => expectedTaskWorkspacePath('/srv/vps-mcp-workspaces', '../etc', '134e5321-b4d7-4d4f-be92-ce56a984adaa')).toThrow('Invalid repository ID');
  });

  it('requires administrator approval for exact immutable image digests', () => {
    const previous = process.env.VPS_SANDBOX_ALLOWED_IMAGES;
    const approvedImage = 'docker.io/library/node@sha256:' + 'a'.repeat(64);
    process.env.VPS_SANDBOX_ALLOWED_IMAGES = approvedImage;
    expect(safeImage(approvedImage)).toBe(approvedImage);
    expect(() => safeImage('docker.io/library/alpine@sha256:' + 'b'.repeat(64))).toThrow('allowlist');
    if (previous === undefined) delete process.env.VPS_SANDBOX_ALLOWED_IMAGES;
    else process.env.VPS_SANDBOX_ALLOWED_IMAGES = previous;
  });

  it('accepts task sandbox operations with strict request schemas', () => {
    const sandboxId = '134e5321-b4d7-4d4f-be92-ce56a984adaa';
    expect(parseRuntimeRequest(JSON.stringify({ operation: 'sandbox.exec', sandboxId, command: ['node', '-v'], cwd: 'src', timeoutMs: 5000, maxOutputBytes: 8192, env: { CI: 'true' } }))).toMatchObject({ operation: 'sandbox.exec', sandboxId });
    expect(parseRuntimeRequest(JSON.stringify({ operation: 'sandbox.fs.list', sandboxId, path: '' }))).toMatchObject({ operation: 'sandbox.fs.list' });
    expect(parseRuntimeRequest(JSON.stringify({ operation: 'sandbox.fs.read', sandboxId, path: 'README.md' }))).toMatchObject({ operation: 'sandbox.fs.read' });
    expect(parseRuntimeRequest(JSON.stringify({ operation: 'sandbox.fs.write', sandboxId, path: 'notes.txt', content: 'hello' }))).toMatchObject({ operation: 'sandbox.fs.write' });
    expect(parseRuntimeRequest(JSON.stringify({ operation: 'sandbox.execution.start', sandboxId, command: ['node', 'build.js'], cwd: 'src', timeoutMs: 60_000 }))).toMatchObject({ operation: 'sandbox.execution.start', sandboxId });
    expect(parseRuntimeRequest(JSON.stringify({ operation: 'sandbox.execution.list', sandboxId }))).toMatchObject({ operation: 'sandbox.execution.list', sandboxId });
    expect(parseRuntimeRequest(JSON.stringify({ operation: 'sandbox.execution.status', sandboxId, executionId: '234e5321-b4d7-4d4f-be92-ce56a984adaa' }))).toMatchObject({ operation: 'sandbox.execution.status' });
    expect(parseRuntimeRequest(JSON.stringify({ operation: 'sandbox.execution.logs', sandboxId, executionId: '234e5321-b4d7-4d4f-be92-ce56a984adaa', offset: 128, maxBytes: 8192 }))).toMatchObject({ operation: 'sandbox.execution.logs' });
    expect(parseRuntimeRequest(JSON.stringify({ operation: 'sandbox.execution.cancel', sandboxId, executionId: '234e5321-b4d7-4d4f-be92-ce56a984adaa' }))).toMatchObject({ operation: 'sandbox.execution.cancel' });
    expect(() => parseRuntimeRequest(JSON.stringify({ operation: 'sandbox.execution.status', sandboxId, executionId: 'not-a-uuid' }))).toThrow('Invalid execution ID');
    expect(() => parseRuntimeRequest(JSON.stringify({ operation: 'sandbox.execution.start', sandboxId, command: ['id'], timeoutMs: 90_000_000 }))).toThrow('timeoutMs');
    expect(() => parseRuntimeRequest(JSON.stringify({ operation: 'sandbox.execution.logs', sandboxId, executionId: '234e5321-b4d7-4d4f-be92-ce56a984adaa', maxBytes: 300_000 }))).toThrow('maxBytes');
    expect(() => parseRuntimeRequest(JSON.stringify({ operation: 'sandbox.exec', sandboxId, command: ['id'], cwd: '../etc' }))).toThrow('unsafe component');
    expect(() => parseRuntimeRequest(JSON.stringify({ operation: 'sandbox.exec', sandboxId, command: ['id'], env: { PATH: '/tmp' } }))).toThrow('Environment');
    expect(() => parseRuntimeRequest(JSON.stringify({ operation: 'sandbox.fs.read', sandboxId, path: '/etc/passwd' }))).toThrow('workspace-relative');
    expect(() => parseRuntimeRequest(JSON.stringify({ operation: 'sandbox.fs.read', sandboxId, path: 'src\\file.txt' }))).toThrow('workspace-relative');
    expect(() => parseRuntimeRequest(JSON.stringify({ operation: 'sandbox.fs.read', sandboxId, path: 'a'.repeat(4097) }))).toThrow('workspace-relative');
    expect(() => parseRuntimeRequest(JSON.stringify({ operation: 'sandbox.fs.write', sandboxId, path: 'file', content: 'x'.repeat(1024 * 1024 + 1) }))).toThrow('1 MiB');
    expect(() => parseRuntimeRequest(JSON.stringify({ operation: 'sandbox.exec', sandboxId, command: ['id'], extra: true }))).toThrow('unsupported properties');
    expect(parseRuntimeRequest(JSON.stringify({ operation: 'resource.inspect' }))).toMatchObject({ operation: 'resource.inspect' });
    expect(parseRuntimeRequest(JSON.stringify({ operation: 'sandbox.retention.set', sandboxId, retained: true }))).toMatchObject({ operation: 'sandbox.retention.set', retained: true });
    expect(parseRuntimeRequest(JSON.stringify({ operation: 'sandbox.exec', sandboxId, operationId: sandboxId, command: ['id'] }))).toMatchObject({ operation: 'sandbox.exec', operationId: sandboxId });
    expect(parseRuntimeRequest(JSON.stringify({ operation: 'sandbox.execution.start', sandboxId, executionId: sandboxId, command: ['sleep', '1'] }))).toMatchObject({ operation: 'sandbox.execution.start', executionId: sandboxId });
    expect(() => parseRuntimeRequest(JSON.stringify({ operation: 'sandbox.retention.set', sandboxId, retained: 'yes' }))).toThrow('retained must be a boolean');
    expect(parseRuntimeRequest(JSON.stringify({ operation: 'resource.reserve', repositoryId: 'repo-123', resources: { cpuMilli: 500, memoryMiB: 512, pids: 64, diskMiB: 4096 } }))).toMatchObject({ operation: 'resource.reserve' });
    expect(parseRuntimeRequest(JSON.stringify({ operation: 'cleanup.run', dryRun: true }))).toMatchObject({ operation: 'cleanup.run' });
    expect(parseRuntimeRequest(JSON.stringify({ operation: 'cleanup.pause', paused: true }))).toMatchObject({ operation: 'cleanup.pause' });
    expect(parseRuntimeRequest(JSON.stringify({ operation: 'audit.list', limit: 20 }))).toMatchObject({ operation: 'audit.list' });
    expect(() => parseRuntimeRequest(JSON.stringify({ operation: 'resource.reserve', repositoryId: 'repo-123', resources: { cpuMilli: 500, memoryMiB: 512, pids: 64, admin: true } }))).toThrow('unsupported properties');
    const create = { operation: 'container.create', workloadId: sandboxId, workloadType: 'task', repositoryId: 'repo-123', worktreeId: '234e5321-b4d7-4d4f-be92-ce56a984adaa', image: `docker.io/library/node@sha256:${'a'.repeat(64)}`, network: 'host', readOnlyRootfs: true };
    expect(() => parseRuntimeRequest(JSON.stringify(create))).toThrow('Only network=none');
    expect(() => parseRuntimeRequest(JSON.stringify({ ...create, workloadType: 'project-service', network: 'none' }))).toThrow('task workloads');
  });

  it('runs list/read/write operations within the workspace root and rejects escapes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vps-mcp-sandbox-fs-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'vps-mcp-sandbox-other-'));
    const runScript = (operation, relative, input) => {
      const script = buildSandboxFilesystemScript(operation, root);
      return spawnSync('/bin/sh', ['-c', script, '--', relative], { input, encoding: 'utf8' });
    };
    try {
      await fs.mkdir(path.join(root, 'src'));
      await fs.writeFile(path.join(root, 'src', 'main.ts'), 'before');
      await fs.symlink(outside, path.join(root, 'outside-link'));
      await fs.symlink(path.join(outside, 'secret.txt'), path.join(root, 'secret-link'));
      await fs.writeFile(path.join(outside, 'secret.txt'), 'not for this sandbox');

      const listed = runScript('sandbox.fs.list', '', '');
      expect(listed.status).toBe(0);
      const entries = parseSandboxDirectoryListing(listed.stdout);
      expect(entries.map((entry) => entry.name)).toContain('src');
      expect(entries.map((entry) => entry.name)).not.toContain('outside-link');
      expect(entries.map((entry) => entry.name)).not.toContain('secret-link');

      const read = runScript('sandbox.fs.read', 'src/main.ts', '');
      expect(read.status).toBe(0);
      expect(decodeSandboxFile(read.stdout)).toMatchObject({ content: 'before' });
      expect(runScript('sandbox.fs.read', 'secret-link', '').status).not.toBe(0);
      expect(runScript('sandbox.fs.read', 'outside-link/secret.txt', '').status).not.toBe(0);
      expect(runScript('sandbox.fs.list', 'outside-link', '').status).not.toBe(0);
      expect(runScript('sandbox.fs.read', '../' + path.basename(outside) + '/secret.txt', '').status).not.toBe(0);

      const write = runScript('sandbox.fs.write', 'src/main.ts', 'after');
      expect(write.status).toBe(0);
      expect(decodeSandboxFile(runScript('sandbox.fs.read', 'src/main.ts', '').stdout)).toMatchObject({ content: 'after' });
      expect(runScript('sandbox.fs.write', 'secret-link', 'overwrite').status).not.toBe(0);
      expect(runScript('sandbox.fs.write', '../other/secret.txt', 'overwrite').status).not.toBe(0);
      expect(runScript('sandbox.fs.write', 'src/new.txt', 'x'.repeat(1024 * 1024)).status).toBe(0);
      expect((await fs.readFile(path.join(root, 'src', 'new.txt'), 'utf8')).length).toBe(1024 * 1024);

      await fs.writeFile(path.join(root, 'large.txt'), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61));
      const large = runScript('sandbox.fs.read', 'large.txt', '');
      expect(large.status).not.toBe(0);
      await fs.writeFile(path.join(root, 'invalid-utf8.txt'), Buffer.from([0xff, 0xfe]));
      expect(() => decodeSandboxFile(runScript('sandbox.fs.read', 'invalid-utf8.txt', '').stdout)).toThrow('valid UTF-8');
      execFileSync('/usr/bin/mkfifo', [path.join(root, 'pipe')]);
      expect(runScript('sandbox.fs.read', 'pipe', '').status).not.toBe(0);
      expect(parseSandboxDirectoryListing(runScript('sandbox.fs.list', '', '').stdout).map((entry) => entry.name)).not.toContain('pipe');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('enforces read-only workspace mounts and bounds/redacts command output', () => {
    expect(() => assertTaskSandboxWorkload({ workloadType: 'project-service' })).toThrow('only for task workloads');
    expect(() => assertTaskSandboxWorkload({ workloadType: 'task' })).not.toThrow();
    expect(() => assertTaskWorkspaceWritable({ workloadType: 'task', workspaceMount: { access: 'read-only' } })).toThrow('read-only');
    expect(() => assertTaskWorkspaceWritable({ workloadType: 'task', workspaceMount: { access: 'read-write' } })).not.toThrow();
    expect(hasSandboxCapacity(3)).toBe(true);
    expect(hasSandboxCapacity(4)).toBe(false);
    expect(isSandboxBusy(0)).toBe(false);
    expect(isSandboxBusy(1)).toBe(true);
    expect(boundedSandboxOutput('ghp_' + 'a'.repeat(30), 'Bearer ' + 'b'.repeat(30), 20)).toMatchObject({ truncated: true });
    const output = boundedSandboxOutput('Bearer ' + 'b'.repeat(30), '', 100);
    expect(output.stdout).toBe('Bearer [REDACTED]');
    const credentials = boundedSandboxOutput('password=synthetic-password\nx-api-key: synthetic-api-key', '', 200);
    expect(credentials.stdout).toContain('password=[REDACTED]');
    expect(credentials.stdout).toContain('x-api-key: [REDACTED]');
    expect(credentials.stdout).not.toContain('synthetic-');
  });

  it('always routes sandbox filesystem operations through the selected container', () => {
    for (const operation of ['sandbox.fs.list', 'sandbox.fs.read']) {
      expect(buildSandboxFilesystemArgs({ runtimeId: 'selected-container', operation, path: 'src' }).slice(0, 4)).toEqual(['exec', 'selected-container', 'sh', '-c']);
    }
    expect(buildSandboxFilesystemArgs({ runtimeId: 'selected-container', operation: 'sandbox.fs.write', path: 'src/file.txt' }).slice(0, 5)).toEqual(['exec', '-i', 'selected-container', 'sh', '-c']);
  });

  it('builds sandbox execution commands with the selected runtime ID and validated cwd', () => {
    expect(buildSandboxExecArgs({ runtimeId: 'container-runtime-id', cwd: 'src', command: ['node', '-v'], env: { CI: 'true' } })).toEqual([
      'exec', '--workdir', '/workspace', '--env', 'CI=true', 'container-runtime-id', 'sh', '-c', expect.any(String), '--', 'src', 'node', '-v',
    ]);
    expect(() => buildSandboxExecArgs({ runtimeId: 'container-runtime-id', cwd: '', command: [''] })).toThrow('Invalid command argument');
  });


  it('requires explicit confirmation for identity-bound backup restoration', () => {
    const base = {
      operation: 'project-backup.restore', repositoryId: 'deputy-proxy-vps-mcp',
      environmentId: '134e5321-b4d7-4d4f-be92-ce56a984adaa', profileId: 'laravel-php', profileVersion: 4,
      applicationWorkloadId: '334e5321-b4d7-4d4f-be92-ce56a984adaa', enabledDependencies: ['mysql'],
      backupId: '234e5321-b4d7-4d4f-be92-ce56a984adaa', confirm: true,
    };
    expect(() => parseRuntimeRequest(JSON.stringify({ ...base, confirm: false }))).toThrow('confirm=true');
    expect(() => parseRuntimeRequest(JSON.stringify({ ...base, enabledDependencies: ['redis'] }))).toThrow('requires MySQL');
    expect(isNewWorkOperation({ operation: 'project-backup.create' })).toBe(true);
    expect(isNewWorkOperation({ operation: 'project-backup.restore' })).toBe(true);
    expect(durableLockKeys({ ...base, operation: 'project-backup.restore' })).toContain('repository:deputy-proxy-vps-mcp');
  });

  it('rejects unsafe dependency identities, unpinned images and resource overcommit', () => {
    const environmentId = '134e5321-b4d7-4d4f-be92-ce56a984adaa';
    const workloadId = projectDependencyWorkloadId(environmentId, 'mysql');
    const base = {
      operation: 'project-dependency.create', workloadId, environmentId, repositoryId: 'deputy-proxy-vps-mcp', dependency: 'mysql',
      image: 'dhi.io/mysql@sha256:50f6fc4ce3fe8c156e912236124ad0efbcfcb02e910158acf6fea3ec18d131f1',
      resources: { cpuMilli: 500, memoryMiB: 768, pids: 128, diskMiB: 10240 },
      reservationResources: { cpuMilli: 1200, memoryMiB: 2048, pids: 320, diskMiB: 21504 },
      restartPolicy: 'no', podName: projectPodName('deputy-proxy-vps-mcp'),
    };
    expect(() => parseRuntimeRequest(JSON.stringify({ ...base, image: 'mysql:8' }))).toThrow('sha256 digest');
    expect(() => parseRuntimeRequest(JSON.stringify({ ...base, workloadId: '234e5321-b4d7-4d4f-be92-ce56a984adaa' }))).toThrow('does not match');
    expect(() => parseRuntimeRequest(JSON.stringify({ ...base, resources: { ...base.resources, cpuMilli: 1300 } }))).toThrow('exceeds aggregate');
    expect(() => parseRuntimeRequest(JSON.stringify({ operation: 'project-dependency.prepare-secrets', repositoryId: 'deputy-proxy-vps-mcp', environmentId, mysqlEnabled: 'true', redisEnabled: true }))).toThrow('booleans');
  });

  it('rejects unknown operations and extra request properties', () => {
    expect(() => parseRuntimeRequest('{"operation":"exec","command":"id"}')).toThrow('Unsupported');
    expect(() => parseRuntimeRequest('{"operation":"container.list","command":"id"}')).toThrow('unsupported properties');
  });

  it('rejects malformed, oversized and non-object requests', () => {
    expect(() => parseRuntimeRequest('{')).toThrow('valid JSON');
    expect(() => parseRuntimeRequest('[]')).toThrow('object');
    expect(() => parseRuntimeRequest(' '.repeat(2 * 1024 * 1024 + 1))).toThrow('too large');
  });
});



describe('runtime restart recovery and storage scans', () => {
  it('marks interrupted running operations unknown after a runtime restart', () => {
    const record = {
      sandboxId: '134e5321-b4d7-4d4f-be92-ce56a984adaa',
      operationId: '234e5321-b4d7-4d4f-be92-ce56a984adaa',
      status: 'running',
      fingerprint: 'a'.repeat(64),
    };

    expect(reconcileSandboxOperationRecord(record, '2026-11-24T00:00:00.000Z')).toEqual({
      ...record,
      status: 'unknown',
      finishedAt: '2026-11-24T00:00:00.000Z',
      recoveryReason: 'runtime_agent_restarted',
    });
  });

  it.each(['unknown', 'completed', 'failed'])('preserves an already %s operation', (status) => {
    const record = { status, fingerprint: 'b'.repeat(64) };
    expect(reconcileSandboxOperationRecord(record)).toBe(record);
  });

  it('excludes removed workloads and deduplicates workspace paths', () => {
    const records = [
      { status: 'running', workspaceMount: { path: '/workspaces/active' } },
      { status: 'created', workspaceMount: { path: '/workspaces/active' } },
      { status: 'removed', workspaceMount: { path: '/workspaces/removed' } },
      { status: 'removed', workspaceMount: null },
    ];

    expect(workspacePathsForStorageScan(records)).toEqual(['/workspaces/active']);
  });

  it('reconciles only interrupted task creations and never probes removed records', () => {
    const creating = { id: 'creating-id', workloadType: 'task', status: 'creating', workspaceMount: { path: '/workspaces/creating' } };
    const records = [
      { id: 'removed-id', workloadType: 'task', status: 'removed', runtimeId: null, workspaceMount: { path: '/workspaces/removed' } },
      creating,
      { id: 'project-id', workloadType: 'project-service', status: 'creating', workspaceMount: { path: '/workspaces/project' } },
      { id: 'no-mount-id', workloadType: 'task', status: 'creating', workspaceMount: null },
    ];

    expect(workspaceMountRecoveryCandidates(records)).toEqual([creating]);
  });
});

describe('rootless workload lifecycle isolation', () => {
  it('requires the expected workload type for stop/remove lifecycle operations', () => {
    const record = { workloadType: 'project-service' };
    expect(() => assertWorkloadTypeMatch(record, 'task')).toThrow('type mismatch');
    expect(() => assertWorkloadTypeMatch(record, 'project-service')).not.toThrow();
  });

  it('builds only the hardened container create policy and never mounts a workspace implicitly', () => {
    const args = buildContainerCreateArgs({
      id: '134e5321-b4d7-4d4f-be92-ce56a984adaa',
      workloadType: 'task',
      repositoryId: 'deputy-proxy-vps-mcp',
      image: `docker.io/library/node@sha256:${'a'.repeat(64)}`,
      resources: { cpuMilli: 500, memoryMiB: 512, pids: 64 },
      workspaceMount: null,
      executionMount: { path: '/var/lib/vps-sandbox/execution-logs/134e5321-b4d7-4d4f-be92-ce56a984adaa', destination: '/run/vps-mcp-executions' },
    });
    expect(args).toContain('--cgroup-parent');
    expect(args).toContain('/system.slice/vps-sandbox-runtime.service');
    expect(args).toContain('--network=none');
    expect(args).toContain('--http-proxy=false');
    expect(args.some((arg) => arg.startsWith('HTTP_PROXY='))).toBe(false);
    expect(args).toContain('--userns=keep-id');
    expect(args).toContain('--user');
    expect(args).toContain('--security-opt=seccomp=/usr/share/containers/seccomp.json');
    expect(args).toContain('--read-only');
    expect(args).toContain('--memory-swap=1024m');
    expect(args).toContain('--cap-drop=ALL');
    expect(args).toContain('--security-opt=no-new-privileges');
    expect(args).toContain('--pids-limit');
    expect(args).not.toContain('--privileged');
    expect(args).not.toContain('--pid=host');
    expect(args).not.toContain('--network=host');
    expect(args).toContain('type=bind,src=/var/lib/vps-sandbox/execution-logs/134e5321-b4d7-4d4f-be92-ce56a984adaa,dst=/run/vps-mcp-executions,rw');
    expect(args).not.toContain('/workspace');
  });
  it('uses the broker staging path for the workspace bind while preserving access mode', () => {
    const args = buildContainerCreateArgs({
      id: '134e5321-b4d7-4d4f-be92-ce56a984adaa', workloadType: 'task', repositoryId: 'deputy-proxy-vps-mcp',
      worktreeId: '234e5321-b4d7-4d4f-be92-ce56a984adaa', image: `docker.io/library/node@sha256:${'a'.repeat(64)}`,
      resources: { cpuMilli: 500, memoryMiB: 512, pids: 64 },
      workspaceMount: { path: '/var/lib/vps-mcp/task-workspaces/worktrees/deputy-proxy-vps-mcp/234e5321-b4d7-4d4f-be92-ce56a984adaa', stagedPath: '/var/lib/vps-sandbox-mounts/deputy-proxy-vps-mcp/234e5321-b4d7-4d4f-be92-ce56a984adaa/134e5321-b4d7-4d4f-be92-ce56a984adaa', access: 'read-only', destination: '/workspace' },
      executionMount: { path: '/var/lib/vps-sandbox/execution-logs/134e5321-b4d7-4d4f-be92-ce56a984adaa', destination: '/run/vps-mcp-executions' },
    });
    expect(args).toContain('type=bind,src=/var/lib/vps-sandbox-mounts/deputy-proxy-vps-mcp/234e5321-b4d7-4d4f-be92-ce56a984adaa/134e5321-b4d7-4d4f-be92-ce56a984adaa,dst=/workspace,ro');
    expect(args.some((arg) => arg.includes('/var/lib/vps-mcp/task-workspaces/worktrees/deputy-proxy-vps-mcp/234e5321-b4d7-4d4f-be92-ce56a984adaa'))).toBe(false);
  });

  it('derives the repository-private pod when a project-service caller omits podName', () => {
    const id = '134e5321-b4d7-4d4f-be92-ce56a984adaa';
    const base = '/var/lib/vps-sandbox-mounts/projects/deputy-proxy-vps-mcp/' + id;
    const args = buildContainerCreateArgs({
      id, workloadType: 'project-service', repositoryId: 'deputy-proxy-vps-mcp', environmentId: id, profileId: 'laravel-php', profileVersion: 4,
      image: 'ghcr.io/deputy-proxy/vps-mcp-laravel-php@sha256:' + 'a'.repeat(64),
      resources: { cpuMilli: 500, memoryMiB: 1024, pids: 128, diskMiB: 10240 },
      projectMounts: { releaseId: '234e5321-b4d7-4d4f-be92-ce56a984adaa', release: base + '/release', storage: base + '/storage', cache: base + '/cache', logs: base + '/logs', runtimeEnv: base + '/runtime.env' },
      restartPolicy: 'unless-stopped', executionMount: null,
    });

    expect(args).toContain('--pod');
    expect(args).toContain(projectPodName('deputy-proxy-vps-mcp'));
    expect(args).toContain('io.cr8or.vps-mcp.pod=' + projectPodName('deputy-proxy-vps-mcp'));
  });

  it('builds project-service mounts from broker staging paths and maps the image app UID', () => {
    const id = '134e5321-b4d7-4d4f-be92-ce56a984adaa';
    const base = '/var/lib/vps-sandbox-mounts/projects/deputy-proxy-vps-mcp/' + id;
    const args = buildContainerCreateArgs({
      id, workloadType: 'project-service', repositoryId: 'deputy-proxy-vps-mcp', environmentId: id, profileId: 'laravel-php', profileVersion: 4,
      image: 'ghcr.io/deputy-proxy/vps-mcp-laravel-php@sha256:' + 'a'.repeat(64),
      resources: { cpuMilli: 500, memoryMiB: 1024, pids: 128, diskMiB: 10240 },
      projectMounts: { releaseId: '234e5321-b4d7-4d4f-be92-ce56a984adaa', release: base + '/release', storage: base + '/storage', cache: base + '/cache', logs: base + '/logs', runtimeEnv: base + '/runtime.env' },
      restartPolicy: 'unless-stopped', executionMount: null, podName: projectPodName('deputy-proxy-vps-mcp'),
    });
    expect(args).toContain('--pod');
    expect(args).toContain(projectPodName('deputy-proxy-vps-mcp'));
    expect(args).not.toContain('--cgroup-parent');
    expect(args.some((arg) => arg.startsWith('--network='))).toBe(false);
    expect(args).toContain('--read-only');
    expect(args).toContain('--memory-swap=1024m');
    expect(args).toContain('--restart=unless-stopped');
    expect(args).toContain('--cap-drop=ALL');
    expect(args).toContain('--security-opt=no-new-privileges');
    expect(args).toContain('--security-opt=seccomp=/usr/share/containers/seccomp.json');
    expect(args).toContain('--tmpfs');
    expect(args).toContain('/tmp:rw,noexec,nosuid,nodev,size=64m');
    expect(args.join(' ')).not.toMatch(/--device|--privileged|--pid=host|--ipc=host|--uts=host|\/dev|vps-sandbox-runtime\\.sock|vps-sandbox-quota\\.sock|task-workspaces|execution-logs/);
    expect(args.join(' ')).not.toContain('/workspace');
    expect(args.join(' ')).not.toContain('/run/vps-mcp-executions');
    // Podman 4.9 rejects --userns together with --pod. Keep the explicit\n    // non-root application UID; the runtime service owns the pod and members.\n    expect(args).not.toContain('--userns');
    expect(args).toContain('--label');
    expect(args).toContain('io.cr8or.vps-mcp.release=234e5321-b4d7-4d4f-be92-ce56a984adaa');
    expect(args).toContain('--userns=keep-id:uid=10001,gid=10001');
    expect(args).toContain('--user');
    expect(args).toContain('10001:10001');
    expect(args).toContain('type=bind,src=' + base + '/release,dst=/app,ro,nosuid,nodev');
    expect(args).toContain('type=bind,src=' + base + '/storage,dst=/app/storage,rw,nosuid,nodev');
    expect(args).toContain('type=bind,src=' + base + '/cache,dst=/app/bootstrap/cache,rw,nosuid,nodev');
    expect(args).toContain('type=bind,src=' + base + '/logs,dst=/app/storage/logs,rw,nosuid,nodev');
    // The dedicated logs bind intentionally overlays the storage bind. Keep
    // the parent mount first so the nested target exists before Podman applies it.
    const storageMountIndex = args.indexOf('type=bind,src=' + base + '/storage,dst=/app/storage,rw,nosuid,nodev');
    const logsMountIndex = args.indexOf('type=bind,src=' + base + '/logs,dst=/app/storage/logs,rw,nosuid,nodev');
    expect(storageMountIndex).toBeGreaterThan(-1);
    expect(logsMountIndex).toBeGreaterThan(storageMountIndex);
    expect(base + '/storage').not.toBe(base + '/logs');
    expect(args).not.toContain('--privileged');
    expect(args).not.toContain('--device');
    expect(args.join(' ')).not.toContain('/var/lib/vps-mcp/task-workspaces');
    expect(args.join(' ')).not.toContain('/var/lib/vps-sandbox/execution-logs');
  });
  it('allows task egress only through the administrator-pinned proxy network mode', () => {
    const image = 'docker.io/library/node@sha256:' + 'a'.repeat(64);
    const args = buildContainerCreateArgs({
      id: '134e5321-b4d7-4d4f-be92-ce56a984adaa',
      workloadType: 'task',
      repositoryId: 'deputy-proxy-vps-mcp',
      worktreeId: '234e5321-b4d7-4d4f-be92-ce56a984adaa',
      image,
      resources: { cpuMilli: 500, memoryMiB: 512, pids: 64 },
      workspaceMount: null,
      executionMount: { path: '/var/lib/vps-sandbox/execution-logs/134e5321-b4d7-4d4f-be92-ce56a984adaa', destination: '/run/vps-mcp-executions' },
      network: 'slirp4netns:allow_host_loopback=true',
      proxyUrl: 'http://10.0.2.2:3128',
    });
    expect(args).toContain('--network=slirp4netns:allow_host_loopback=true');
    expect(args).toContain('--http-proxy=false');
    expect(args).toEqual(expect.arrayContaining([
      '--env', 'HTTP_PROXY=http://10.0.2.2:3128',
      '--env', 'HTTPS_PROXY=http://10.0.2.2:3128',
      '--env', 'http_proxy=http://10.0.2.2:3128',
      '--env', 'https_proxy=http://10.0.2.2:3128',
      '--env', 'NO_PROXY=localhost,127.0.0.1,::1',
      '--env', 'no_proxy=localhost,127.0.0.1,::1',
    ]));
    expect(args).not.toContain('--network=host');
    expect(() => buildContainerCreateArgs({
      id: '134e5321-b4d7-4d4f-be92-ce56a984adaa',
      workloadType: 'task',
      repositoryId: 'deputy-proxy-vps-mcp',
      worktreeId: '234e5321-b4d7-4d4f-be92-ce56a984adaa',
      image,
      resources: { cpuMilli: 500, memoryMiB: 512, pids: 64 },
      workspaceMount: null,
      executionMount: { path: '/var/lib/vps-sandbox/execution-logs/134e5321-b4d7-4d4f-be92-ce56a984adaa', destination: '/run/vps-mcp-executions' },
      network: 'slirp4netns:allow_host_loopback=true',
      proxyUrl: 'http://attacker.invalid:3128',
    })).toThrow('Unsupported workload network policy');
  });

});


describe('multi-root project-service mount verification', () => {
  const repositoryId = 'deputy-proxy-vps-mcp';
  const releaseId = '134e5321-b4d7-4d4f-be92-ce56a984adaa';
  const roots = [
    { root: '/var/lib/vps-mcp/project-environments', owner: 'vps-mcp' },
    { root: '/var/lib/vps-mcp-development/project-environments', owner: 'vps-mcp-development' },
  ];

  it('parses both configured roots and retains their dedicated owners', () => {
    expect(configuredProjectEnvironmentRoots({
      VPS_SANDBOX_PROJECT_ENV_ROOTS_JSON: JSON.stringify(roots),
    })).toEqual(roots);
  });

  it('derives canonical mount sources for each approved root', () => {
    expect(expectedProjectServiceMountSources(repositoryId, releaseId, roots)).toEqual([
      {
        release: '/var/lib/vps-mcp/project-environments/' + repositoryId + '/releases/' + releaseId,
        storage: '/var/lib/vps-mcp/project-environments/' + repositoryId + '/storage',
        cache: '/var/lib/vps-mcp/project-environments/' + repositoryId + '/cache',
        logs: '/var/lib/vps-mcp/project-environments/' + repositoryId + '/logs',
        runtimeConfig: '/var/lib/vps-mcp/project-environments/' + repositoryId + '/secrets/application',
      },
      {
        release: '/var/lib/vps-mcp-development/project-environments/' + repositoryId + '/releases/' + releaseId,
        storage: '/var/lib/vps-mcp-development/project-environments/' + repositoryId + '/storage',
        cache: '/var/lib/vps-mcp-development/project-environments/' + repositoryId + '/cache',
        logs: '/var/lib/vps-mcp-development/project-environments/' + repositoryId + '/logs',
        runtimeConfig: '/var/lib/vps-mcp-development/project-environments/' + repositoryId + '/secrets/application',
      },
    ]);
  });

  it('preserves the legacy single-root configuration', () => {
    expect(configuredProjectEnvironmentRoots({
      VPS_SANDBOX_PROJECT_ENV_ROOT: '/srv/project-environments',
      VPS_SANDBOX_PROJECT_ENV_OWNER: 'project-owner',
    })).toEqual([{ root: '/srv/project-environments', owner: 'project-owner' }]);
  });

  it.each([
    ['invalid JSON', { VPS_SANDBOX_PROJECT_ENV_ROOTS_JSON: '{' }, 'valid JSON'],
    ['empty roots', { VPS_SANDBOX_PROJECT_ENV_ROOTS_JSON: '[]' }, 'between 1 and 8 roots'],
    ['relative root', { VPS_SANDBOX_PROJECT_ENV_ROOTS_JSON: JSON.stringify([{ root: 'relative', owner: 'vps-mcp' }]) }, 'configuration is invalid'],
    ['comma root', { VPS_SANDBOX_PROJECT_ENV_ROOTS_JSON: JSON.stringify([{ root: '/srv/project,environments', owner: 'vps-mcp' }]) }, 'configuration is invalid'],
    ['invalid owner', { VPS_SANDBOX_PROJECT_ENV_ROOTS_JSON: JSON.stringify([{ root: '/srv/project-environments', owner: 'not a user' }]) }, 'configuration is invalid'],
    ['duplicate roots', { VPS_SANDBOX_PROJECT_ENV_ROOTS_JSON: JSON.stringify([{ root: '/srv/project-environments', owner: 'vps-mcp' }, { root: '/srv/./project-environments', owner: 'vps-mcp-development' }]) }, 'must be unique'],
  ])('rejects %s', (_name, env, message) => {
    expect(() => configuredProjectEnvironmentRoots(env)).toThrow(message);
  });

  it('rejects an empty or malformed root list when deriving mount sources', () => {
    expect(() => expectedProjectServiceMountSources(repositoryId, releaseId, [])).toThrow('At least one approved');
    expect(() => expectedProjectServiceMountSources('../other', releaseId, roots)).toThrow('repository ID');
  });
});


describe('project dependency boot recovery policy', () => {
  const dependency = { workloadType: 'project-dependency', status: 'running', desiredState: 'running' };
  it.each([
    [dependency, 'running', 'running', 'verify'],
    [dependency, 'exited', 'running', 'start'],
    [dependency, 'missing', 'running', 'operator-review'],
    [{ ...dependency, desiredState: 'stopped' }, 'running', 'stopped', 'stop'],
    [{ ...dependency, desiredState: 'running' }, 'running', 'stopped', 'stop'],
    [{ ...dependency, desiredState: 'stopped' }, 'exited', 'stopped', 'skip'],
    [{ ...dependency, desiredState: 'stopped' }, 'missing', 'stopped', 'operator-review'],
    [{ ...dependency, status: 'removed' }, 'missing', undefined, 'skip'],
    [dependency, 'running', undefined, 'operator-review'],
    [{ ...dependency, desiredState: 'stopped' }, 'running', 'running', 'operator-review'],
  ])('reconciles dependency %s / %s / parent %s -> %s', (record, state, parent, expected) => {
    expect(projectDependencyBootRecoveryAction(record, state, parent)).toBe(expected);
  });
});
