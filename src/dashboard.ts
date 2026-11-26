import fs from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "./config.js";
import { listRepositoriesReadOnly, runManagedGit } from "./repositories.js";
import { listTaskWorkspaces } from "./task-workspaces.js";
import { createSandboxRuntimeAdapter, type DashboardRuntimeInventory } from "./sandbox-runtime.js";
import { WorkspaceDiskScanner } from "./workspace-disk.js";
import {
  calculateCpuUtilization,
  parseCgroupV2Snapshot,
  percentageOfLimit,
  RollingMetricHistory,
  type CgroupV2Snapshot,
} from "./dashboard-metrics.js";

const SNAPSHOT_CACHE_MS = 15_000;
const HISTORY_RETENTION_MS = 30 * 60 * 1000;
const HISTORY_MAX_SAMPLES = 121;
const MAX_SANDBOX_HISTORY = 32;
const MAX_WORKSPACE_GIT_INSPECTIONS = 32;
const runtime = createSandboxRuntimeAdapter();
const workspaceDiskScanner = new WorkspaceDiskScanner();

type CpuTimes = { idle: number; total: number };
type PreviousCpuSample = { at: number; times: CpuTimes };
type PreviousCgroupSample = { at: number; usageMicros: number };

type SandboxDashboardRow = {
  id: string;
  repository: { id: string; fullName: string } | null;
  workspace: {
    id: string;
    branch: string | null;
    commit: string | null;
    dirty: boolean | null;
    stagedChanges: number | null;
    untrackedFiles: number | null;
    status: string;
  } | null;
  lifecycleStatus: string;
  runtimeState: string;
  retained: boolean;
  createdAt: string;
  updatedAt: string;
  runtimeCreatedAt: string | null;
  runtimeStartedAt: string | null;
  uptimeSeconds: number | null;
  resources: {
    cpuHostPercent: number | null;
    cpuQuotaPercent: number | null;
    cpuQuotaCores: number | null;
    configuredCpuMilli: number | null;
    memoryCurrentBytes: number | null;
    configuredMemoryBytes: number | null;
    configuredPids: number | null;
    memoryLimitBytes: number | null;
    memoryPercent: number | null;
    pidsCurrent: number | null;
    pidsLimit: number | null;
    workspaceDiskBytes: number | null;
    workspaceDiskStatus: 'available' | 'partial' | 'unavailable';
    networkRxBytes: number | null;
    networkTxBytes: number | null;
    networkStatus: 'available' | 'unavailable';
    metricStatus: string;
  };
};

export type DashboardSnapshot = {
  generatedAt: string;
  host: {
    hostname: string;
    platform: string;
    release: string;
    architecture: string;
    cpuCount: number;
    cpuModel: string;
    cpuPercent: number | null;
    totalMemoryBytes: number;
    usedMemoryBytes: number;
    availableMemoryBytes: number;
    memoryPercent: number;
    dataFilesystem: {
      totalBytes: number;
      usedBytes: number;
      freeBytes: number;
      percent: number;
    } | null;
    loadAverage: number[];
    uptimeSeconds: number;
  };
  summary: {
    managedSandboxCount: number;
    runningSandboxCount: number;
    stoppedSandboxCount: number;
    unknownSandboxCount: number;
    unmatchedContainerCount: number;
  };
  sandboxes: SandboxDashboardRow[];
  sources: {
    runtime: { status: "available" | "unavailable"; sampledAt: string | null };
    repositories: { status: "available" | "unavailable"; sampledAt: string | null };
    workspaces: { status: "available" | "unavailable"; sampledAt: string | null };
    host: { status: "available" | "unavailable"; sampledAt: string };
  };
  warnings: string[];
};

let cachedSnapshot: DashboardSnapshot | null = null;
let cachedAt = 0;
let inFlightSnapshot: Promise<DashboardSnapshot> | null = null;
let previousCpuSample: PreviousCpuSample | null = null;
const previousCgroupSamples = new Map<string, PreviousCgroupSample>();
const hostHistory = new RollingMetricHistory({ retentionMs: HISTORY_RETENTION_MS, maxSamples: HISTORY_MAX_SAMPLES });
const sandboxHistory = new Map<string, RollingMetricHistory>();
const HISTORY_FILE = path.join(config.dataDir, "dashboard-history.json");

function restoreHostHistory(): void {
  try {
    if (!existsSync(HISTORY_FILE)) return;
    const contents = readFileSync(HISTORY_FILE);
    if (contents.byteLength > 64 * 1024) return;
    const parsed = JSON.parse(contents.toString("utf8")) as unknown;
    if (!Array.isArray(parsed)) return;
    const now = Date.now();
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const sample = item as { sampledAt?: unknown; cpuPercent?: unknown; memoryBytes?: unknown };
      if (!Number.isSafeInteger(sample.sampledAt) || Number(sample.sampledAt) > now || Number(sample.sampledAt) < now - HISTORY_RETENTION_MS) continue;
      const cpuPercent = sample.cpuPercent === null || (typeof sample.cpuPercent === "number" && Number.isFinite(sample.cpuPercent) && sample.cpuPercent >= 0 && sample.cpuPercent <= 100) ? sample.cpuPercent as number | null : null;
      const memoryBytes = typeof sample.memoryBytes === "number" && Number.isSafeInteger(sample.memoryBytes) && sample.memoryBytes >= 0 ? sample.memoryBytes : null;
      hostHistory.add({ sampledAt: Number(sample.sampledAt), cpuPercent, memoryBytes });
    }
  } catch { /* Invalid history starts a fresh bounded window. */ }
}

function persistHostHistory(): void {
  try {
    mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    const temporary = HISTORY_FILE + ".tmp";
    writeFileSync(temporary, JSON.stringify(hostHistory.list()), { mode: 0o600 });
    renameSync(temporary, HISTORY_FILE);
  } catch { /* Persistence is best-effort; current metrics remain available. */ }
}

restoreHostHistory();

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index]!, index);
    }
  }));
  return results;
}

function cpuTimes(): CpuTimes {
  const values = os.cpus();
  return values.reduce((total, cpu) => {
    const times = cpu.times;
    const sum = times.user + times.nice + times.sys + times.irq + times.idle;
    return { idle: total.idle + times.idle, total: total.total + sum };
  }, { idle: 0, total: 0 });
}

function hostCpuPercent(now: number): number | null {
  const current = { at: now, times: cpuTimes() };
  const previous = previousCpuSample;
  previousCpuSample = current;
  if (!previous) return null;
  const elapsed = current.times.total - previous.times.total;
  const idle = current.times.idle - previous.times.idle;
  if (elapsed <= 0 || idle < 0 || idle > elapsed) return null;
  return Math.min(100, Math.max(0, ((elapsed - idle) / elapsed) * 100));
}

function parseCgroup(raw: Record<string, string | null> | null): CgroupV2Snapshot | null {
  if (!raw) return null;
  return parseCgroupV2Snapshot({
    cpuStat: raw["cpu.stat"] ?? "",
    cpuMax: raw["cpu.max"] ?? "",
    memoryCurrent: raw["memory.current"] ?? "",
    memoryMax: raw["memory.max"] ?? "",
    pidsCurrent: raw["pids.current"] ?? "",
    pidsMax: raw["pids.max"] ?? "",
  });
}

async function hostFilesystem() {
  try {
    const stats = await fs.statfs(config.dataDir);
    const totalBytes = Number(stats.blocks) * Number(stats.bsize);
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    if (!Number.isFinite(totalBytes) || !Number.isFinite(freeBytes) || totalBytes <= 0 || freeBytes < 0) return null;
    const usedBytes = Math.max(0, totalBytes - freeBytes);
    return { totalBytes, usedBytes, freeBytes, percent: Math.min(100, (usedBytes / totalBytes) * 100) };
  } catch {
    return null;
  }
}

async function inspectWorkspace(workspace: Awaited<ReturnType<typeof listTaskWorkspaces>>[number]) {
  const expectedRoot = path.resolve(config.dataDir, "task-workspaces", "worktrees", workspace.repositoryId);
  const target = path.resolve(workspace.worktreePath);
  const relative = path.relative(expectedRoot, target);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null;

  try {
    const stat = await fs.lstat(target);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(target) !== target) return null;
    const [branch, commit, porcelain, disk] = await Promise.all([
      runManagedGit(["-C", target, "branch", "--show-current"], { timeoutMs: 5_000 }),
      runManagedGit(["-C", target, "rev-parse", "--verify", "HEAD"], { timeoutMs: 5_000 }),
      runManagedGit(["-C", target, "status", "--porcelain=v1", "--untracked-files=normal"], { timeoutMs: 5_000 }),
      workspaceDiskScanner.measure(target),
    ]);
    const lines = porcelain.split(/\r?\n/).filter(Boolean);
    return {
      id: workspace.id,
      branch: branch.trim() || null,
      commit: /^[a-f0-9]{40,64}$/i.test(commit.trim()) ? commit.trim() : null,
      dirty: lines.length > 0,
      stagedChanges: lines.filter((line) => line.length >= 2 && line[0] !== " " && line[0] !== "?").length,
      untrackedFiles: lines.filter((line) => line.startsWith("?? ")).length,
      diskBytes: disk.bytes,
      diskStatus: disk.status,
      status: workspace.status,
    };
  } catch {
    return {
      id: workspace.id, branch: null, commit: null, dirty: null,
      stagedChanges: null, untrackedFiles: null, diskBytes: null, diskStatus: "unavailable", status: "unavailable",
    };
  }
}

function cgroupMetrics(workloadId: string, cgroup: CgroupV2Snapshot | null, sampledAt: number, cpuCount: number) {
  if (!cgroup) {
    previousCgroupSamples.delete(workloadId);
    return {
      cpuHostPercent: null, cpuQuotaPercent: null, cpuQuotaCores: null,
      memoryCurrentBytes: null, memoryLimitBytes: null, memoryPercent: null,
      pidsCurrent: null, pidsLimit: null, metricStatus: "unavailable",
    };
  }

  const previous = previousCgroupSamples.get(workloadId);
  const cpu = calculateCpuUtilization(
    previous?.usageMicros ?? null,
    cgroup.cpuUsageMicros,
    previous ? sampledAt - previous.at : 0,
    cpuCount,
    cgroup.cpuQuotaCores,
  );
  if (cgroup.cpuUsageMicros !== null) {
    previousCgroupSamples.set(workloadId, { at: sampledAt, usageMicros: cgroup.cpuUsageMicros });
  }
  const hasAnyMetric = [
    cgroup.cpuUsageMicros, cgroup.memoryCurrentBytes, cgroup.memoryLimitBytes,
    cgroup.pidsCurrent, cgroup.pidsLimit,
  ].some((value) => value !== null);
  return {
    cpuHostPercent: cpu.hostPercent,
    cpuQuotaPercent: cpu.quotaPercent,
    cpuQuotaCores: cgroup.cpuQuotaCores,
    memoryCurrentBytes: cgroup.memoryCurrentBytes,
    memoryLimitBytes: cgroup.memoryLimitBytes,
    memoryPercent: percentageOfLimit(cgroup.memoryCurrentBytes, cgroup.memoryLimitBytes),
    pidsCurrent: cgroup.pidsCurrent,
    pidsLimit: cgroup.pidsLimit,
    metricStatus: hasAnyMetric ? "available" : "unavailable",
  };
}

async function collectSnapshot(): Promise<DashboardSnapshot> {
  const generatedAt = new Date().toISOString();
  const sampledAt = Date.now();
  const warnings: string[] = [];
  const cpuCount = os.cpus().length || 1;

  const [filesystem, runtimeResult, repositoryResult, workspaceResult] = await Promise.all([
    hostFilesystem(),
    runtime.getDashboardInventory().then((value) => ({ value, ok: true as const })).catch(() => ({ value: null, ok: false as const })),
    listRepositoriesReadOnly().then((value) => ({ value, ok: true as const })).catch(() => ({ value: null, ok: false as const })),
    listTaskWorkspaces({ includeRemoved: true }).then((value) => ({ value, ok: true as const })).catch(() => ({ value: null, ok: false as const })),
  ]);

  if (!runtimeResult.ok) warnings.push("Runtime inventory is unavailable.");
  if (!repositoryResult.ok) warnings.push("Repository metadata is unavailable.");
  if (!workspaceResult.ok) warnings.push("Task workspace metadata is unavailable.");
  if (!filesystem) warnings.push("Host data-filesystem metrics are unavailable.");

  const repositories = new Map((repositoryResult.value?.repositories ?? []).map((item) => [item.id, item]));
  const workspaces = new Map((workspaceResult.value ?? []).map((item) => [item.id, item]));
  const workspaceMetadata = new Map<string, Awaited<ReturnType<typeof inspectWorkspace>>>();
  const inventory: DashboardRuntimeInventory | null = runtimeResult.value;
  const prioritizedWorkloads = [...(inventory?.workloads ?? [])].sort((left, right) => {
    const runningDelta = Number(right.runtimeState === "running") - Number(left.runtimeState === "running");
    return runningDelta || Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  });
  const inspectedWorkspaceIds = new Set(prioritizedWorkloads
    .map((workload) => workload.worktreeId)
    .filter((id): id is string => Boolean(id))
    .slice(0, MAX_WORKSPACE_GIT_INSPECTIONS));
  const workspaceRecordsToInspect = [...inspectedWorkspaceIds]
    .map((id) => workspaces.get(id))
    .filter((workspace): workspace is NonNullable<typeof workspace> => Boolean(workspace));
  if (new Set((inventory?.workloads ?? []).map((workload) => workload.worktreeId).filter(Boolean)).size > MAX_WORKSPACE_GIT_INSPECTIONS) {
    warnings.push("Git metadata inspection is capped at 32 worktrees per snapshot.");
  }
  if ((inventory?.unmatchedContainers.length ?? 0) > 0) {
    warnings.push("One or more managed containers have no matching workload record.");
  }
  workspaceDiskScanner.retainOnly(workspaceRecordsToInspect.map((workspace) => workspace.worktreePath));
  await mapWithConcurrency(workspaceRecordsToInspect, 4, async (workspace) => {
    workspaceMetadata.set(workspace.id, await inspectWorkspace(workspace));
    return undefined;
  });

  const sandboxes = await Promise.all((inventory?.workloads ?? []).map(async (workload): Promise<SandboxDashboardRow> => {
    const repository = repositories.get(workload.repositoryId);
    const workspaceRecord = workload.worktreeId ? workspaces.get(workload.worktreeId) : undefined;
    const workspace = workspaceRecord && inspectedWorkspaceIds.has(workspaceRecord.id)
      ? workspaceMetadata.get(workspaceRecord.id) ?? null
      : null;
    const cgroup = parseCgroup(workload.cgroup);
    const metrics = cgroupMetrics(workload.id, cgroup, sampledAt, cpuCount);
    const startedTime = workload.runtimeStartedAt ? Date.parse(workload.runtimeStartedAt) : Number.NaN;
    const workspaceDiskBytes = workspace?.diskBytes ?? null;
    const workspaceDiskStatus = (workspace?.diskStatus ?? 'unavailable') as 'available' | 'partial' | 'unavailable';
    return {
      id: workload.id,
      repository: repository ? { id: repository.id, fullName: repository.fullName } : null,
      workspace: workspace ?? (workspaceRecord ? {
        id: workspaceRecord.id, branch: null, commit: null, dirty: null,
        stagedChanges: null, untrackedFiles: null,
        status: inspectedWorkspaceIds.has(workspaceRecord.id) ? "unavailable" : "not_inspected",
      } : null),
      lifecycleStatus: workload.lifecycleStatus,
      runtimeState: workload.runtimeState,
      retained: workload.retained,
      createdAt: workload.createdAt,
      updatedAt: workload.updatedAt,
      runtimeCreatedAt: workload.runtimeCreatedAt,
      runtimeStartedAt: workload.runtimeStartedAt,
      uptimeSeconds: workload.runtimeState === "running" && Number.isFinite(startedTime) && startedTime <= sampledAt
        ? Math.floor((sampledAt - startedTime) / 1000)
        : null,
      resources: {
        ...metrics,
        configuredCpuMilli: workload.resources.cpuMilli ?? null,
        configuredMemoryBytes: workload.resources.memoryMiB == null ? null : workload.resources.memoryMiB * 1024 * 1024,
        configuredPids: workload.resources.pids ?? null,
        workspaceDiskBytes,
        workspaceDiskStatus,
        networkRxBytes: workload.networkRxBytes,
        networkTxBytes: workload.networkTxBytes,
        networkStatus: workload.networkStatus,
      },
    };
  }));

  for (const sandbox of sandboxes) {
    if (sandbox.runtimeState === "running" && sandbox.resources.networkStatus === "unavailable") {
      warnings.push("Network counters are unavailable for sandbox " + sandbox.id.slice(0, 8) + ".");
    }
    if (sandbox.runtimeState === "running" && sandbox.resources.workspaceDiskStatus !== "available") {
      warnings.push("Workspace disk usage is " + sandbox.resources.workspaceDiskStatus + " for sandbox " + sandbox.id.slice(0, 8) + ".");
    }
  }

  const cpuPercent = hostCpuPercent(sampledAt);
  const totalMemoryBytes = os.totalmem();
  const availableMemoryBytes = os.freemem();
  const usedMemoryBytes = Math.max(0, totalMemoryBytes - availableMemoryBytes);
  hostHistory.add({ sampledAt, cpuPercent, memoryBytes: usedMemoryBytes });
  persistHostHistory();

  for (const sandbox of sandboxes) {
    let history = sandboxHistory.get(sandbox.id);
    if (!history) {
      history = new RollingMetricHistory({ retentionMs: HISTORY_RETENTION_MS, maxSamples: HISTORY_MAX_SAMPLES });
      sandboxHistory.set(sandbox.id, history);
    }
    history.add({
      sampledAt,
      cpuPercent: sandbox.resources.cpuQuotaPercent,
      memoryBytes: sandbox.resources.memoryCurrentBytes,
    });
  }
  for (const id of sandboxHistory.keys()) {
    if (!sandboxes.some((sandbox) => sandbox.id === id)) sandboxHistory.delete(id);
  }
  while (sandboxHistory.size > MAX_SANDBOX_HISTORY) {
    const oldest = sandboxHistory.keys().next().value;
    if (oldest === undefined) break;
    sandboxHistory.delete(oldest);
  }

  const runningSandboxCount = sandboxes.filter((item) => item.runtimeState === "running").length;
  const stoppedSandboxCount = sandboxes.filter((item) => ["stopped", "exited", "created", "removed"].includes(item.runtimeState)).length;
  const unknownSandboxCount = sandboxes.length - runningSandboxCount - stoppedSandboxCount;

  return {
    generatedAt,
    host: {
      hostname: os.hostname(),
      platform: os.platform(),
      release: os.release(),
      architecture: os.arch(),
      cpuCount,
      cpuModel: os.cpus()[0]?.model ?? "unknown",
      cpuPercent,
      totalMemoryBytes,
      usedMemoryBytes,
      availableMemoryBytes,
      memoryPercent: totalMemoryBytes > 0 ? Math.min(100, (usedMemoryBytes / totalMemoryBytes) * 100) : 0,
      dataFilesystem: filesystem,
      loadAverage: os.loadavg(),
      uptimeSeconds: os.uptime(),
    },
    summary: {
      managedSandboxCount: sandboxes.length,
      runningSandboxCount,
      stoppedSandboxCount,
      unknownSandboxCount,
      unmatchedContainerCount: inventory?.unmatchedContainers.length ?? 0,
    },
    sandboxes,
    sources: {
      runtime: { status: runtimeResult.ok ? "available" : "unavailable", sampledAt: inventory?.collectedAt ?? null },
      repositories: { status: repositoryResult.ok ? "available" : "unavailable", sampledAt: repositoryResult.ok ? generatedAt : null },
      workspaces: { status: workspaceResult.ok ? "available" : "unavailable", sampledAt: workspaceResult.ok ? generatedAt : null },
      host: { status: "available", sampledAt: generatedAt },
    },
    warnings,
  };
}

export async function getDashboardSnapshot(options: { forceRefresh?: boolean } = {}): Promise<DashboardSnapshot> {
  if (!options.forceRefresh && cachedSnapshot && Date.now() - cachedAt < SNAPSHOT_CACHE_MS) {
    return structuredClone(cachedSnapshot);
  }
  if (inFlightSnapshot) return structuredClone(await inFlightSnapshot);
  inFlightSnapshot = collectSnapshot();
  try {
    const snapshot = await inFlightSnapshot;
    cachedSnapshot = snapshot;
    cachedAt = Date.now();
    return structuredClone(snapshot);
  } finally {
    inFlightSnapshot = null;
  }
}

export function getDashboardHistory() {
  return {
    host: hostHistory.list(),
    sandboxes: Object.fromEntries([...sandboxHistory.entries()].map(([id, history]) => [id, history.list()])),
  };
}

export function clearDashboardCacheForTests(): void {
  cachedSnapshot = null;
  cachedAt = 0;
  inFlightSnapshot = null;
  previousCpuSample = null;
  previousCgroupSamples.clear();
  hostHistory.clear();
  try { if (existsSync(HISTORY_FILE)) writeFileSync(HISTORY_FILE, "[]", { mode: 0o600 }); } catch { /* test cleanup is best-effort */ }
  sandboxHistory.clear();
  workspaceDiskScanner.clear();
}
