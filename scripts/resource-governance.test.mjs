import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { auditSafeValue, cleanupEligibility, diskPressureLevel, calculateResourceUsage, createWorkloadReplayDecision, evaluateResourceRequest, operationReplayDecision, orphanContainerEligibility, resourceBudget, staleLockIsReapable, staleTemporaryFile, withDurableLocks } from './resource-governance.mjs';

const budget = resourceBudget({
  VPS_SANDBOX_GLOBAL_CPU_MILLI: '2000', VPS_SANDBOX_GLOBAL_MEMORY_MIB: '2048', VPS_SANDBOX_GLOBAL_PIDS: '256',
  VPS_SANDBOX_MAX_ACTIVE_TASKS: '2', VPS_SANDBOX_REPOSITORY_CPU_MILLI: '1500',
  VPS_SANDBOX_REPOSITORY_MEMORY_MIB: '1536', VPS_SANDBOX_REPOSITORY_PIDS: '192', VPS_SANDBOX_DISK_RESERVE_BYTES: '1024',
}, { cpuCount: 4, totalMemoryMiB: 4096 });

let temporary;
afterEach(async () => { if (temporary) await fs.rm(temporary, { recursive: true, force: true }); temporary = undefined; });

describe('resource governance', () => {
  it('derives conservative defaults and rejects malformed budget configuration', () => {
    expect(resourceBudget({}, { cpuCount: 8, totalMemoryMiB: 8192 })).toMatchObject({ globalCpuMilli: 5600, globalMemoryMiB: 5734, maxActiveTasks: 8, diskWarningBytes: 15 * 1024 ** 3, diskReserveBytes: 5 * 1024 ** 3 });
    expect(resourceBudget({ VPS_SANDBOX_DISK_WARNING_BYTES: '2000', VPS_SANDBOX_DISK_RESERVE_BYTES: '1000' })).toMatchObject({ diskWarningBytes: 2000, diskReserveBytes: 1000 });
    expect(() => resourceBudget({ VPS_SANDBOX_DISK_WARNING_BYTES: '1000', VPS_SANDBOX_DISK_RESERVE_BYTES: '1000' })).toThrow('must be greater than');
    expect(() => resourceBudget({ VPS_SANDBOX_DISK_WARNING_BYTES: '999', VPS_SANDBOX_DISK_RESERVE_BYTES: '1000' })).toThrow('must be greater than');
    expect(() => resourceBudget({ VPS_SANDBOX_GLOBAL_CPU_MILLI: '0' }, { cpuCount: 2, totalMemoryMiB: 1024 })).toThrow('positive safe integer');
  });

  it('classifies disk headroom at warning and critical thresholds', () => {
    const budget = { diskWarningBytes: 150, diskReserveBytes: 50 };
    expect(diskPressureLevel(151, budget)).toBe('normal');
    expect(diskPressureLevel(150, budget)).toBe('normal');
    expect(diskPressureLevel(149, budget)).toBe('warning');
    expect(diskPressureLevel(50, budget)).toBe('warning');
    expect(diskPressureLevel(49, budget)).toBe('critical');
    expect(() => diskPressureLevel(-1, budget)).toThrow('non-negative');
  });

  it('accounts for active workloads and project reservations without counting released reservations', () => {
    const usage = calculateResourceUsage([
      { status: 'running', workloadType: 'task', repositoryId: 'repo-a', resources: { cpuMilli: 500, memoryMiB: 512, pids: 64 } },
      { status: 'stopped', workloadType: 'task', repositoryId: 'repo-a', resources: { cpuMilli: 500, memoryMiB: 512, pids: 64, diskMiB: 2048 } },
    ], [
      { status: 'reserved', repositoryId: 'repo-b', resources: { cpuMilli: 700, memoryMiB: 768, pids: 80, diskMiB: 1024 } },
      { status: 'released', repositoryId: 'repo-c', resources: { cpuMilli: 900, memoryMiB: 900, pids: 90 } },
    ]);
    expect(usage).toMatchObject({ cpuMilli: 1200, memoryMiB: 1280, pids: 144, diskMiB: 3072, activeTasks: 1 });
  });

  it('keeps a project reservation as the capacity envelope after the service starts', () => {
    const usage = calculateResourceUsage([
      { status: 'running', workloadType: 'project-service', repositoryId: 'repo-a', resources: { cpuMilli: 300, memoryMiB: 512, pids: 64, diskMiB: 4096 } },
    ], [
      { status: 'reserved', workloadType: 'project-service', repositoryId: 'repo-a', resources: { cpuMilli: 700, memoryMiB: 1024, pids: 128, diskMiB: 8192 } },
    ]);
    expect(usage).toMatchObject({ cpuMilli: 700, memoryMiB: 1024, pids: 128, diskMiB: 8192 });
  });

  it('rejects global, per-repository, task-count, worktree and disk overcommit', () => {
    const records = [
      { status: 'running', workloadType: 'task', repositoryId: 'repo-a', worktreeId: 'worktree-1', resources: { cpuMilli: 1000, memoryMiB: 1024, pids: 128 } },
      { status: 'running', workloadType: 'task', repositoryId: 'repo-b', resources: { cpuMilli: 500, memoryMiB: 512, pids: 64 } },
    ];
    const result = evaluateResourceRequest({ records, requested: { workloadType: 'task', repositoryId: 'repo-a', worktreeId: 'worktree-1', resources: { cpuMilli: 1000, memoryMiB: 1024, pids: 128, diskMiB: 1 } }, budget, freeDiskBytes: 1500 });
    expect(result.allowed).toBe(false);
    expect(result.reasons.join(' ')).toContain('global CPU');
    expect(result.reasons.join(' ')).toContain('repository CPU');
    expect(result.reasons.join(' ')).toContain('maximum active task');
    expect(result.reasons.join(' ')).toContain('already registered');
    expect(result.reasons.join(' ')).toContain('disk');
  });

  it('cleans only expired stopped task containers with terminal executions', () => {
    const old = new Date(Date.now() - 10 * 86400_000).toISOString();
    expect(cleanupEligibility({ workloadType: 'task', status: 'stopped', createdAt: old, stoppedAt: old }, Date.now(), 7 * 86400_000, [{ status: 'completed' }]).eligible).toBe(true);
    expect(cleanupEligibility({ workloadType: 'project-service', status: 'stopped', createdAt: old }).reason).toBe('persistent_or_non_task_workload');
    expect(cleanupEligibility({ workloadType: 'task', status: 'running', createdAt: old }).reason).toBe('workload_not_stopped');
    expect(cleanupEligibility({ workloadType: 'task', status: 'stopped', createdAt: old, stoppedAt: old, retained: true }).reason).toBe('retained_or_protected');
    expect(cleanupEligibility({ workloadType: 'task', status: 'stopped', createdAt: old, stoppedAt: old }, Date.now(), 7 * 86400_000, [{ status: 'unknown' }]).reason).toBe('active_or_unknown_execution');
  });

  it('consumes project-service resources from the repository reservation without double-counting', () => {
    const budget = resourceBudget({ VPS_SANDBOX_GLOBAL_CPU_MILLI: '8000', VPS_SANDBOX_GLOBAL_MEMORY_MIB: '16000', VPS_SANDBOX_GLOBAL_PIDS: '2048', VPS_SANDBOX_GLOBAL_DISK_MIB: '100000', VPS_SANDBOX_PER_REPOSITORY_CPU_MILLI: '4000', VPS_SANDBOX_PER_REPOSITORY_MEMORY_MIB: '8000', VPS_SANDBOX_PER_REPOSITORY_PIDS: '1024', VPS_SANDBOX_PER_REPOSITORY_DISK_MIB: '50000' });
    const reservation = { repositoryId: 'repo', status: 'active', resources: { cpuMilli: 2000, memoryMiB: 4096, pids: 256, diskMiB: 10240 } };
    const existing = [{ id: 'service-1', repositoryId: 'repo', workloadType: 'project-service', status: 'running', resources: { cpuMilli: 500, memoryMiB: 1024, pids: 64, diskMiB: 2048 } }];
    const request = { repositoryId: 'repo', workloadType: 'project-service', resources: { cpuMilli: 1500, memoryMiB: 3072, pids: 192, diskMiB: 8192 } };
    const result = evaluateResourceRequest({ records: existing, reservations: [reservation], requested: request, budget, freeDiskBytes: 100 * 1024 ** 3 });
    expect(result.allowed).toBe(true);
    expect(result.charged).toEqual({ cpuMilli: 0, memoryMiB: 0, pids: 0, diskMiB: 0 });
    expect(result.usage.cpuMilli).toBe(2000);
    expect(evaluateResourceRequest({ records: existing, reservations: [reservation], requested: { ...request, resources: { ...request.resources, cpuMilli: 1600 } }, budget, freeDiskBytes: 100 * 1024 ** 3 }).reasons).toContain('SANDBOX_PROJECT_RESERVATION_EXCEEDED: project cpuMilli usage would exceed its reserved budget');
    expect(evaluateResourceRequest({ records: existing, reservations: [], requested: request, budget, freeDiskBytes: 100 * 1024 ** 3 }).reasons).toContain('SANDBOX_PROJECT_RESERVATION_REQUIRED: reserve project capacity before creating project-service workloads');
    const replacement = evaluateResourceRequest({ records: [{ ...existing[0], status: 'stopped' }], reservations: [], requested: { repositoryId: 'repo', workloadType: 'project-reservation', resources: { cpuMilli: 2000, memoryMiB: 4096, pids: 256, diskMiB: 10240 } }, budget, freeDiskBytes: 100 * 1024 ** 3 });
    expect(replacement.allowed).toBe(true);
    expect(replacement.charged.diskMiB).toBe(8192);
    expect(replacement.charged.cpuMilli).toBe(1500);
  });

  it('accounts dependency workload vectors against the same project reservation', () => {
    const budget = resourceBudget({ VPS_SANDBOX_GLOBAL_CPU_MILLI: '8000', VPS_SANDBOX_GLOBAL_MEMORY_MIB: '16000', VPS_SANDBOX_GLOBAL_PIDS: '2048', VPS_SANDBOX_GLOBAL_DISK_MIB: '100000', VPS_SANDBOX_PER_REPOSITORY_CPU_MILLI: '4000', VPS_SANDBOX_PER_REPOSITORY_MEMORY_MIB: '8000', VPS_SANDBOX_PER_REPOSITORY_PIDS: '1024', VPS_SANDBOX_PER_REPOSITORY_DISK_MIB: '50000' });
    const reservation = { repositoryId: 'repo', status: 'reserved', resources: { cpuMilli: 1200, memoryMiB: 2048, pids: 320, diskMiB: 21504 } };
    const records = [
      { id: 'mysql', repositoryId: 'repo', workloadType: 'project-dependency', status: 'running', resources: { cpuMilli: 500, memoryMiB: 768, pids: 128, diskMiB: 10240 } },
      { id: 'redis', repositoryId: 'repo', workloadType: 'project-dependency', status: 'stopped', resources: { cpuMilli: 200, memoryMiB: 256, pids: 64, diskMiB: 1024 } },
      { id: 'php', repositoryId: 'repo', workloadType: 'project-service', status: 'running', resources: { cpuMilli: 500, memoryMiB: 1024, pids: 128, diskMiB: 10240 } },
    ];
    const usage = calculateResourceUsage(records, [reservation]);
    expect(usage.byRepository.repo).toMatchObject({ cpuMilli: 1200, memoryMiB: 2048, pids: 320, diskMiB: 21504 });
    expect(usage).toMatchObject({ cpuMilli: 1200, memoryMiB: 2048, pids: 320, diskMiB: 21504 });
    const over = evaluateResourceRequest({ records, reservations: [reservation], requested: { repositoryId: 'repo', workloadType: 'project-dependency', resources: { cpuMilli: 1, memoryMiB: 1, pids: 1, diskMiB: 1 } }, budget, freeDiskBytes: 100 * 1024 ** 3 });
    expect(over.allowed).toBe(false);
    expect(over.reasons).toContain('SANDBOX_PROJECT_RESERVATION_EXCEEDED: project cpuMilli usage would exceed its reserved budget');
  });

  it('only reaps terminal orphan task containers after retention', () => {
    const now = Date.now();
    const old = new Date(now - 8 * 86400_000).toISOString();
    expect(orphanContainerEligibility({ workloadType: 'project-service', state: 'exited', createdAt: old }, null, now).eligible).toBe(false);
    expect(orphanContainerEligibility({ workloadType: 'task', state: 'running', createdAt: old }, null, now).reason).toBe('orphan_container_not_terminal');
    expect(orphanContainerEligibility({ workloadType: 'task', state: 'exited', createdAt: old }, null, now).eligible).toBe(true);
    expect(orphanContainerEligibility({ workloadType: 'task', repositoryId: 'repo', worktreeId: 'worktree', state: 'running', createdAt: old }, { status: 'removed', workloadType: 'task', repositoryId: 'repo', worktreeId: 'worktree' }, now).eligible).toBe(true);
    expect(orphanContainerEligibility({ workloadType: 'task', repositoryId: 'repo', worktreeId: 'worktree', state: 'exited', createdAt: old }, { status: 'running', workloadType: 'task', repositoryId: 'repo', worktreeId: 'worktree' }, now).eligible).toBe(false);
    expect(orphanContainerEligibility({ workloadType: 'task', repositoryId: 'other', worktreeId: 'worktree', state: 'exited', createdAt: old }, { status: 'removed', workloadType: 'task', repositoryId: 'repo', worktreeId: 'worktree' }, now).reason).toBe('workload_identity_mismatch');
  });

  it('recognizes only old runtime temporary files and dead lock owners', () => {
    const now = Date.now();
    expect(staleTemporaryFile('.record-' + 'a'.repeat(36) + '.tmp', now - 900_000, now)).toBe(true);
    expect(staleTemporaryFile('record.json', now - 900_000, now)).toBe(false);
    expect(staleLockIsReapable(false, now, now)).toBe(true);
    expect(staleLockIsReapable(true, now - 900_000, now)).toBe(false);
    expect(staleLockIsReapable(null, now - 900_000, now)).toBe(true);
  });

  it('reconciles or safely retries interrupted workload creation', () => {
    expect(createWorkloadReplayDecision(null, 'missing').action).toBe('create');
    expect(createWorkloadReplayDecision({ status: 'removed' }, 'missing').action).toBe('replay_removed');
    expect(createWorkloadReplayDecision({ status: 'creating' }, 'created').action).toBe('reconcile');
    expect(createWorkloadReplayDecision({ status: 'creating' }, 'missing').action).toBe('retry_create');
    expect(createWorkloadReplayDecision({ status: 'running' }, 'missing').action).toBe('unknown');
  });

  it('replays completed idempotent operations and refuses ambiguous or conflicting retries', () => {
    expect(operationReplayDecision(null, 'fingerprint')).toEqual({ action: 'execute' });
    expect(operationReplayDecision({ status: 'completed', fingerprint: 'fingerprint', result: { exitCode: 0 } }, 'fingerprint')).toMatchObject({ action: 'replay', result: { exitCode: 0 } });
    expect(operationReplayDecision({ status: 'running', fingerprint: 'fingerprint' }, 'fingerprint').action).toBe('busy');
    expect(operationReplayDecision({ status: 'unknown', fingerprint: 'fingerprint' }, 'fingerprint').action).toBe('unknown');
    expect(operationReplayDecision({ status: 'completed', fingerprint: 'old' }, 'new').action).toBe('conflict');
  });

  it('redacts credentials and private-key blocks from audit values', () => {
    expect(auditSafeValue('Bearer super-secret-token')).toContain('Bearer [REDACTED]');
    expect(auditSafeValue('github_pat_123456789012345678901234567890')).toContain('[REDACTED_TOKEN]');
    expect(auditSafeValue('-----BEGIN PRIVATE KEY-----secret-----END PRIVATE KEY-----')).toContain('[REDACTED_PRIVATE_KEY]');
    const structured = auditSafeValue(JSON.stringify({ password: 'synthetic-password', 'x-api-key': 'synthetic-api-key' }));
    expect(structured).toContain('\"password\":\"[REDACTED]\"');
    expect(structured).toContain('\"x-api-key\":\"[REDACTED]\"');
    expect(structured).not.toContain('synthetic-');
  });

  it('reclaims locks whose owner process has exited', async () => {
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'vps-lock-crash-test-'));
    const { createHash } = await import('node:crypto');
    const lockPath = path.join(temporary, createHash('sha256').update('crashed-owner').digest('hex'));
    await fs.mkdir(lockPath);
    await fs.writeFile(path.join(lockPath, 'owner.json'), JSON.stringify({ pid: 99999999, startTime: '1', token: 'dead-owner' }));
    await expect(withDurableLocks(temporary, ['crashed-owner'], async () => 'recovered', { timeoutMs: 500, staleLockMs: 100 })).resolves.toBe('recovered');
  });

  it('reports bounded lock contention instead of waiting forever', async () => {
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'vps-lock-timeout-test-'));
    let release;
    const held = withDurableLocks(temporary, ['busy'], () => new Promise((resolve) => { release = resolve; }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(withDurableLocks(temporary, ['busy'], async () => 'unexpected', { timeoutMs: 10 })).rejects.toThrow('SANDBOX_BUSY');
    release('released');
    await held;
  });

  it('serializes same-key operations and permits independent keys', async () => {
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'vps-lock-test-'));
    let active = 0;
    let maximum = 0;
    const operation = () => withDurableLocks(temporary, ['repository:one'], async () => {
      active += 1; maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 30));
      active -= 1;
    }, { timeoutMs: 1000 });
    await Promise.all([operation(), operation(), operation()]);
    expect(maximum).toBe(1);
    const independent = await Promise.all([
      withDurableLocks(temporary, ['repo:a'], async () => 'a'),
      withDurableLocks(temporary, ['repo:b'], async () => 'b'),
    ]);
    expect(independent).toEqual(['a', 'b']);
    expect(await fs.readdir(temporary)).toEqual([]);
  });
});
