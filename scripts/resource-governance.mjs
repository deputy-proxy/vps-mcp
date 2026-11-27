import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import { redactSensitiveText } from './secret-redaction.mjs';

const ACTIVE_RESOURCE_STATES = new Set(['creating', 'created', 'starting', 'running', 'stopping', 'removing', 'error', 'unknown']);
const PROJECT_WORKLOAD_TYPES = new Set(['project-service', 'project-dependency']);
const CLEANUP_ELIGIBLE_STATES = new Set(['created', 'stopped', 'error']);
const TERMINAL_EXECUTION_STATES = new Set(['completed', 'failed', 'cancelled', 'timed_out', 'interrupted']);

function positiveInteger(value, name, fallback) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive safe integer`);
  return parsed;
}

export function resourceBudget(env = process.env, host = { cpuCount: os.cpus().length, totalMemoryMiB: Math.floor(os.totalmem() / 1024 ** 2) }) {
  const cpuCount = Math.max(1, Math.floor(host.cpuCount || 1));
  const totalMemoryMiB = Math.max(256, Math.floor(host.totalMemoryMiB || 256));
  const globalCpuMilli = positiveInteger(env.VPS_SANDBOX_GLOBAL_CPU_MILLI, 'VPS_SANDBOX_GLOBAL_CPU_MILLI', Math.max(100, Math.floor(cpuCount * 700)));
  const globalMemoryMiB = positiveInteger(env.VPS_SANDBOX_GLOBAL_MEMORY_MIB, 'VPS_SANDBOX_GLOBAL_MEMORY_MIB', Math.max(128, Math.floor(totalMemoryMiB * 0.7)));
  const globalPids = positiveInteger(env.VPS_SANDBOX_GLOBAL_PIDS, 'VPS_SANDBOX_GLOBAL_PIDS', 2048);
  const maxActiveTasks = positiveInteger(env.VPS_SANDBOX_MAX_ACTIVE_TASKS, 'VPS_SANDBOX_MAX_ACTIVE_TASKS', 8);
  const perRepositoryCpuMilli = positiveInteger(env.VPS_SANDBOX_REPOSITORY_CPU_MILLI, 'VPS_SANDBOX_REPOSITORY_CPU_MILLI', globalCpuMilli);
  const perRepositoryMemoryMiB = positiveInteger(env.VPS_SANDBOX_REPOSITORY_MEMORY_MIB, 'VPS_SANDBOX_REPOSITORY_MEMORY_MIB', globalMemoryMiB);
  const perRepositoryPids = positiveInteger(env.VPS_SANDBOX_REPOSITORY_PIDS, 'VPS_SANDBOX_REPOSITORY_PIDS', globalPids);
  const perRepositoryDiskMiB = positiveInteger(env.VPS_SANDBOX_REPOSITORY_DISK_MIB, 'VPS_SANDBOX_REPOSITORY_DISK_MIB', 102400);
  const globalDiskMiB = positiveInteger(env.VPS_SANDBOX_GLOBAL_DISK_MIB, 'VPS_SANDBOX_GLOBAL_DISK_MIB', 153600);
  const diskReserveBytes = positiveInteger(env.VPS_SANDBOX_DISK_RESERVE_BYTES, 'VPS_SANDBOX_DISK_RESERVE_BYTES', 5 * 1024 ** 3);
  const diskWarningBytes = positiveInteger(env.VPS_SANDBOX_DISK_WARNING_BYTES, 'VPS_SANDBOX_DISK_WARNING_BYTES', 15 * 1024 ** 3);
  if (diskWarningBytes <= diskReserveBytes) throw new Error('VPS_SANDBOX_DISK_WARNING_BYTES must be greater than VPS_SANDBOX_DISK_RESERVE_BYTES');
  const taskRetentionMs = positiveInteger(env.VPS_SANDBOX_TASK_RETENTION_MS, 'VPS_SANDBOX_TASK_RETENTION_MS', 7 * 24 * 60 * 60 * 1000);
  const lockTimeoutMs = positiveInteger(env.VPS_SANDBOX_LOCK_TIMEOUT_MS, 'VPS_SANDBOX_LOCK_TIMEOUT_MS', 180_000);
  const staleLockMs = positiveInteger(env.VPS_SANDBOX_STALE_LOCK_MS, 'VPS_SANDBOX_STALE_LOCK_MS', 60_000);
  const temporaryFileRetentionMs = positiveInteger(env.VPS_SANDBOX_TEMP_FILE_RETENTION_MS, 'VPS_SANDBOX_TEMP_FILE_RETENTION_MS', 10 * 60 * 1000);
  return Object.freeze({ globalCpuMilli, globalMemoryMiB, globalPids, maxActiveTasks, perRepositoryCpuMilli, perRepositoryMemoryMiB, perRepositoryPids, perRepositoryDiskMiB, globalDiskMiB, diskReserveBytes, diskWarningBytes, taskRetentionMs, lockTimeoutMs, staleLockMs, temporaryFileRetentionMs });
}

export function diskPressureLevel(freeDiskBytes, budget) {
  if (!Number.isFinite(freeDiskBytes) || freeDiskBytes < 0) throw new Error('freeDiskBytes must be a non-negative finite number');
  if (!Number.isSafeInteger(budget?.diskReserveBytes) || !Number.isSafeInteger(budget?.diskWarningBytes) || budget.diskWarningBytes <= budget.diskReserveBytes) {
    throw new Error('Disk warning threshold must be greater than the disk reserve threshold');
  }
  return freeDiskBytes < budget.diskReserveBytes ? 'critical' : freeDiskBytes < budget.diskWarningBytes ? 'warning' : 'normal';
}

function resourceVector(record) {
  const resources = record.resources ?? {};
  return { cpuMilli: resources.cpuMilli ?? 0, memoryMiB: resources.memoryMiB ?? 0, pids: resources.pids ?? 0, diskMiB: resources.diskMiB ?? 0 };
}

export function resourceReservationMatches(reservation, resources) {
  return reservation?.status === 'reserved'
    && ['cpuMilli', 'memoryMiB', 'pids', 'diskMiB'].every((key) => reservation.resources?.[key] === resources[key]);
}
export function calculateResourceUsage(records = [], reservations = []) {
  const usage = { cpuMilli: 0, memoryMiB: 0, pids: 0, diskMiB: 0, activeTasks: 0, byRepository: {} };
  const projectUsage = {};
  for (const record of records) {
    if (record.status === 'removed') continue;
    const vector = resourceVector(record);
    usage.diskMiB += vector.diskMiB;
    const repo = usage.byRepository[record.repositoryId] ??= { cpuMilli: 0, memoryMiB: 0, pids: 0, diskMiB: 0, activeTasks: 0 };
    repo.diskMiB += vector.diskMiB;
    if (PROJECT_WORKLOAD_TYPES.has(record.workloadType)) {
      const project = projectUsage[record.repositoryId] ??= { cpuMilli: 0, memoryMiB: 0, pids: 0, diskMiB: 0 };
      project.diskMiB += vector.diskMiB;
      project.cpuMilli += vector.cpuMilli;
      project.memoryMiB += vector.memoryMiB;
      project.pids += vector.pids;
      // Project-service limits remain reserved while stopped, until the
      // workload is removed and the project reservation is explicitly released.
      usage.cpuMilli += vector.cpuMilli;
      usage.memoryMiB += vector.memoryMiB;
      usage.pids += vector.pids;
      repo.cpuMilli += vector.cpuMilli;
      repo.memoryMiB += vector.memoryMiB;
      repo.pids += vector.pids;
      continue;
    }
    if (!ACTIVE_RESOURCE_STATES.has(record.status)) continue;
    usage.cpuMilli += vector.cpuMilli;
    usage.memoryMiB += vector.memoryMiB;
    usage.pids += vector.pids;
    repo.cpuMilli += vector.cpuMilli;
    repo.memoryMiB += vector.memoryMiB;
    repo.pids += vector.pids;
    if (record.workloadType === 'task') usage.activeTasks += 1;
    if (record.workloadType === 'task') repo.activeTasks += 1;
  }
  for (const reservation of reservations) {
    if (reservation.status === 'released') continue;
    const vector = resourceVector(reservation);
    const consumed = projectUsage[reservation.repositoryId] ?? { cpuMilli: 0, memoryMiB: 0, pids: 0, diskMiB: 0 };
    const delta = {
      cpuMilli: Math.max(0, vector.cpuMilli - consumed.cpuMilli),
      memoryMiB: Math.max(0, vector.memoryMiB - consumed.memoryMiB),
      pids: Math.max(0, vector.pids - consumed.pids),
      diskMiB: Math.max(0, vector.diskMiB - consumed.diskMiB),
    };
    usage.cpuMilli += delta.cpuMilli;
    usage.memoryMiB += delta.memoryMiB;
    usage.pids += delta.pids;
    usage.diskMiB += delta.diskMiB;
    const repo = usage.byRepository[reservation.repositoryId] ??= { cpuMilli: 0, memoryMiB: 0, pids: 0, diskMiB: 0, activeTasks: 0 };
    repo.cpuMilli += delta.cpuMilli;
    repo.memoryMiB += delta.memoryMiB;
    repo.pids += delta.pids;
    repo.diskMiB += delta.diskMiB;
  }
  return usage;
}

export function evaluateResourceRequest({ records = [], reservations = [], requested, budget, freeDiskBytes, diskReserveBytes = budget.diskReserveBytes }) {
  const usage = calculateResourceUsage(records, reservations);
  const vector = resourceVector(requested);
  const repository = usage.byRepository[requested.repositoryId] ?? { cpuMilli: 0, memoryMiB: 0, pids: 0, diskMiB: 0, activeTasks: 0 };
  const reasons = [];
  let charged = vector;
  let diskToReserveMiB = vector.diskMiB;
  const projectActual = { cpuMilli: 0, memoryMiB: 0, pids: 0, diskMiB: 0 };
  if (PROJECT_WORKLOAD_TYPES.has(requested.workloadType) || requested.workloadType === 'project-reservation') {
    for (const record of records) {
      if (!PROJECT_WORKLOAD_TYPES.has(record.workloadType) || record.repositoryId !== requested.repositoryId || record.status === 'removed') continue;
      const existing = resourceVector(record);
      projectActual.diskMiB += existing.diskMiB;
      projectActual.cpuMilli += existing.cpuMilli;
      projectActual.memoryMiB += existing.memoryMiB;
      projectActual.pids += existing.pids;
    }
    if (PROJECT_WORKLOAD_TYPES.has(requested.workloadType)) {
      const reservation = reservations.find((item) => item.repositoryId === requested.repositoryId && item.status !== 'released');
      if (!reservation) reasons.push('SANDBOX_PROJECT_RESERVATION_REQUIRED: reserve project capacity before creating project-service workloads');
      else {
        const reserved = resourceVector(reservation);
        for (const key of ['cpuMilli', 'memoryMiB', 'pids', 'diskMiB']) {
          if (projectActual[key] + vector[key] > reserved[key]) reasons.push(`SANDBOX_PROJECT_RESERVATION_EXCEEDED: project ${key} usage would exceed its reserved budget`);
        }
        // The reservation already consumes global/repository capacity. Creating a
        // service consumes part of it rather than reserving the same capacity twice.
        charged = { cpuMilli: 0, memoryMiB: 0, pids: 0, diskMiB: 0 };
        diskToReserveMiB = 0;
      }
    } else {
      // When replacing a reservation, count the greater of existing project use
      // and the new reservation rather than charging the same storage twice.
      charged = { cpuMilli: Math.max(0, vector.cpuMilli - projectActual.cpuMilli), memoryMiB: Math.max(0, vector.memoryMiB - projectActual.memoryMiB),
        pids: Math.max(0, vector.pids - projectActual.pids), diskMiB: Math.max(0, vector.diskMiB - projectActual.diskMiB) };
      diskToReserveMiB = charged.diskMiB;
      for (const key of ['cpuMilli', 'memoryMiB', 'pids', 'diskMiB']) {
        if (projectActual[key] > vector[key]) reasons.push(`SANDBOX_PROJECT_RESERVATION_EXCEEDED: existing project ${key} usage exceeds the requested reservation`);
      }
    }
  }
  if (usage.cpuMilli + charged.cpuMilli > budget.globalCpuMilli) reasons.push('SANDBOX_CAPACITY_EXCEEDED: global CPU reservation budget would be exceeded');
  if (usage.memoryMiB + charged.memoryMiB > budget.globalMemoryMiB) reasons.push('SANDBOX_CAPACITY_EXCEEDED: global memory reservation budget would be exceeded');
  if (usage.pids + charged.pids > budget.globalPids) reasons.push('SANDBOX_CAPACITY_EXCEEDED: global PID reservation budget would be exceeded');
  if (usage.diskMiB + charged.diskMiB > budget.globalDiskMiB) reasons.push('SANDBOX_CAPACITY_EXCEEDED: global disk reservation budget would be exceeded');
  if (requested.workloadType === 'task' && usage.activeTasks >= budget.maxActiveTasks) reasons.push('SANDBOX_CAPACITY_EXCEEDED: maximum active task sandbox count reached');
  if (repository.cpuMilli + charged.cpuMilli > budget.perRepositoryCpuMilli) reasons.push('SANDBOX_CAPACITY_EXCEEDED: repository CPU reservation budget would be exceeded');
  if (repository.memoryMiB + charged.memoryMiB > budget.perRepositoryMemoryMiB) reasons.push('SANDBOX_CAPACITY_EXCEEDED: repository memory reservation budget would be exceeded');
  if (repository.pids + charged.pids > budget.perRepositoryPids) reasons.push('SANDBOX_CAPACITY_EXCEEDED: repository PID reservation budget would be exceeded');
  if (repository.diskMiB + charged.diskMiB > (budget.perRepositoryDiskMiB ?? Number.MAX_SAFE_INTEGER)) reasons.push('SANDBOX_CAPACITY_EXCEEDED: repository disk reservation budget would be exceeded');
  if (requested.workloadType === 'task' && requested.worktreeId && records.some((record) => record.workloadType === 'task' && record.worktreeId === requested.worktreeId && record.status !== 'removed')) {
    reasons.push('SANDBOX_BUSY: a task sandbox is already registered for this worktree');
  }
  if (Number.isFinite(freeDiskBytes) && freeDiskBytes - diskToReserveMiB * 1024 ** 2 < diskReserveBytes) reasons.push('SANDBOX_DISK_PRESSURE: available disk would fall below the reserved safety margin');
  return { allowed: reasons.length === 0, reasons, usage, requested: vector, charged, budget: { ...budget }, freeDiskBytes: Number.isFinite(freeDiskBytes) ? freeDiskBytes : null };
}

export function cleanupEligibility(record, now = Date.now(), retentionMs = 7 * 24 * 60 * 60 * 1000, executions = []) {
  if (record.workloadType !== 'task') return { eligible: false, reason: 'persistent_or_non_task_workload' };
  if (!CLEANUP_ELIGIBLE_STATES.has(record.status)) return { eligible: false, reason: 'workload_not_stopped' };
  if (record.retained === true || record.protected === true) return { eligible: false, reason: 'retained_or_protected' };
  if (executions.some((item) => !TERMINAL_EXECUTION_STATES.has(item.status))) return { eligible: false, reason: 'active_or_unknown_execution' };
  const eligibleSince = Date.parse(record.stoppedAt ?? (record.status === 'created' ? record.createdAt : record.updatedAt));
  if (!Number.isFinite(eligibleSince) || now - eligibleSince < retentionMs) return { eligible: false, reason: 'retention_period_not_elapsed' };
  return { eligible: true, reason: 'expired_stopped_task_sandbox' };
}

function processStartTime(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    const fields = stat.slice(close + 2).trim().split(/\s+/);
    return fields[19] ?? null;
  } catch { return null; }
}

function ownerIsAlive(owner) {
  if (!Number.isInteger(owner?.pid) || owner.pid < 1 || typeof owner.startTime !== 'string') return null;
  try { process.kill(owner.pid, 0); } catch (error) { if (error.code === 'ESRCH') return false; if (error.code === 'EPERM') return true; return null; }
  const currentStart = processStartTime(owner.pid);
  return currentStart === null ? null : currentStart === owner.startTime;
}

export async function withDurableLocks(root, keys, operation, options = {}) {
  const budget = options.budget ?? resourceBudget();
  const timeoutMs = options.timeoutMs ?? budget.lockTimeoutMs;
  const staleLockMs = options.staleLockMs ?? budget.staleLockMs;
  const ordered = [...new Set(keys)].sort();
  const acquired = [];
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  try {
    for (const key of ordered) {
      const digest = createHash('sha256').update(String(key)).digest('hex');
      const lockPath = path.join(root, digest);
      const deadline = Date.now() + timeoutMs;
      while (true) {
        try {
          await fs.mkdir(lockPath, { mode: 0o700 });
          const owner = { pid: process.pid, startTime: processStartTime(process.pid), token: randomUUID(), acquiredAt: new Date().toISOString() };
          try { await fs.writeFile(path.join(lockPath, 'owner.json'), JSON.stringify(owner), { mode: 0o600, flag: 'wx' }); }
          catch (error) { await fs.rm(lockPath, { recursive: true, force: true }); throw error; }
          acquired.push({ lockPath, token: owner.token });
          break;
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
          let owner;
          let stat;
          try {
            stat = await fs.stat(lockPath);
            owner = JSON.parse(await fs.readFile(path.join(lockPath, 'owner.json'), 'utf8'));
          } catch { /* a lock may be between mkdir and owner write */ }
          const alive = owner ? ownerIsAlive(owner) : null;
          if ((alive === false || (alive === null && stat && Date.now() - stat.mtimeMs > staleLockMs))) {
            try {
              await withDurableLocks(root, [`reaper:${digest}`], async () => {
                let latest;
                try { latest = JSON.parse(await fs.readFile(path.join(lockPath, 'owner.json'), 'utf8')); } catch { latest = null; }
                const latestAlive = latest ? ownerIsAlive(latest) : null;
                const latestStat = await fs.stat(lockPath).catch(() => null);
                if (latestAlive === false || (latestAlive === null && latestStat && Date.now() - latestStat.mtimeMs > staleLockMs)) {
                  await fs.rm(lockPath, { recursive: true, force: true });
                }
              }, { timeoutMs: Math.min(timeoutMs, 1000), staleLockMs });
            } catch (reapError) {
              if (!String(reapError?.message ?? '').startsWith('SANDBOX_BUSY')) throw reapError;
            }
            continue;
          }
          if (Date.now() >= deadline) throw new Error('SANDBOX_BUSY: resource lock wait timed out');
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
    }
    return await operation();
  } finally {
    for (const item of acquired.reverse()) {
      try {
        const owner = JSON.parse(await fs.readFile(path.join(item.lockPath, 'owner.json'), 'utf8'));
        if (owner.token === item.token) await fs.rm(item.lockPath, { recursive: true, force: true });
      } catch { /* preserve a lock whose ownership cannot be verified */ }
    }
  }
}



const TERMINAL_CONTAINER_STATES = new Set(['created', 'configured', 'exited', 'stopped', 'missing']);
export function orphanContainerEligibility(container, record, now = Date.now(), retentionMs = 7 * 24 * 60 * 60 * 1000) {
  if (container.workloadType !== 'task') return { eligible: false, reason: 'persistent_project_service_protected' };
  if (record && (record.workloadType !== container.workloadType || record.repositoryId !== container.repositoryId || record.worktreeId !== container.worktreeId)) return { eligible: false, reason: 'workload_identity_mismatch' };
  if (record && record.status !== 'removed') return { eligible: false, reason: 'workload_record_still_owns_container' };
  if (record?.status === 'removed') return { eligible: true, reason: 'container_remains_after_record_removal' };
  if (!TERMINAL_CONTAINER_STATES.has(container.state)) return { eligible: false, reason: 'orphan_container_not_terminal' };
  const createdAt = Date.parse(container.createdAt);
  if (!Number.isFinite(createdAt) || now - createdAt < retentionMs) return { eligible: false, reason: 'orphan_container_retention_not_elapsed' };
  return { eligible: true, reason: 'expired_orphan_task_container' };
}

export function staleTemporaryFile(name, mtimeMs, now = Date.now(), staleMs = 10 * 60 * 1000) {
  const recognized = /^\.tmp-[0-9a-f-]{36}$/.test(name) || /^\.(?:record|operation)-[0-9a-f-]{36}\.tmp$/.test(name);
  return recognized && Number.isFinite(mtimeMs) && now - mtimeMs >= staleMs;
}

export function staleLockIsReapable(ownerAlive, mtimeMs, now = Date.now(), staleMs = 60_000) {
  return ownerAlive === false || (ownerAlive === null && Number.isFinite(mtimeMs) && now - mtimeMs >= staleMs);
}


export function createWorkloadReplayDecision(record, runtimeState) {
  if (!record) return { action: 'create' };
  if (record.status === 'removed') return { action: 'replay_removed' };
  if (runtimeState && runtimeState !== 'missing') return { action: 'reconcile', runtimeState };
  if (['creating', 'error'].includes(record.status)) return { action: 'retry_create' };
  return { action: 'unknown' };
}

export function operationReplayDecision(existing, fingerprint) {
  if (!existing) return { action: 'execute' };
  if (existing.fingerprint !== fingerprint) return { action: 'conflict' };
  if (existing.status === 'completed' || existing.status === 'failed') return { action: 'replay', result: existing.result };
  if (existing.status === 'running') return { action: 'busy' };
  if (existing.status === 'unknown') return { action: 'unknown' };
  return { action: 'conflict' };
}

export function auditSafeValue(value) {
  return redactSensitiveText(value).slice(0, 500);
}
