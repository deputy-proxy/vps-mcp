export type MetricStatus = "available" | "unavailable" | "stale";

export type DashboardMetric = {
  value: number | null;
  unit: string;
  status: MetricStatus;
  sampledAt: string | null;
  reason?: string;
};

export type CgroupV2Snapshot = {
  cpuUsageMicros: number | null;
  cpuQuotaCores: number | null;
  memoryCurrentBytes: number | null;
  memoryLimitBytes: number | null;
  pidsCurrent: number | null;
  pidsLimit: number | null;
};

export type CpuUtilization = {
  hostPercent: number | null;
  quotaPercent: number | null;
};

export type MetricHistorySample = {
  sampledAt: number;
  cpuPercent: number | null;
  memoryBytes: number | null;
};

const MAX_SAFE_COUNTER = Number.MAX_SAFE_INTEGER;

function parseCounter(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parseLimit(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "max") return null;
  return parseCounter(value);
}

function parseKeyValueFile(contents: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of contents.split(/\r?\n/)) {
    const match = /^([a-z_]+)\s+(\S+)$/.exec(line.trim());
    if (match) values.set(match[1]!, match[2]!);
  }
  return values;
}

export function parseCpuMax(contents: string): number | null {
  const parts = contents.trim().split(/\s+/);
  if (parts.length !== 2 || parts[0] === "max") return null;
  const quota = parseCounter(parts[0]);
  const period = parseCounter(parts[1]);
  if (quota === null || period === null || quota === 0 || period === 0) return null;
  return quota / period;
}

export function parseCgroupV2Snapshot(input: {
  cpuStat: string;
  cpuMax: string;
  memoryCurrent: string;
  memoryMax: string;
  pidsCurrent: string;
  pidsMax: string;
}): CgroupV2Snapshot {
  const cpu = parseKeyValueFile(input.cpuStat);
  return {
    cpuUsageMicros: parseCounter(cpu.get("usage_usec")),
    cpuQuotaCores: parseCpuMax(input.cpuMax),
    memoryCurrentBytes: parseCounter(input.memoryCurrent),
    memoryLimitBytes: parseLimit(input.memoryMax),
    pidsCurrent: parseCounter(input.pidsCurrent),
    pidsLimit: parseLimit(input.pidsMax),
  };
}

export function calculateCpuUtilization(
  previousUsageMicros: number | null,
  currentUsageMicros: number | null,
  elapsedMs: number,
  hostCpuCount: number,
  quotaCores: number | null,
): CpuUtilization {
  if (
    previousUsageMicros === null
    || currentUsageMicros === null
    || !Number.isFinite(elapsedMs)
    || elapsedMs <= 0
    || !Number.isInteger(hostCpuCount)
    || hostCpuCount < 1
    || currentUsageMicros < previousUsageMicros
  ) {
    return { hostPercent: null, quotaPercent: null };
  }

  const elapsedMicros = elapsedMs * 1000;
  const consumedMicros = currentUsageMicros - previousUsageMicros;
  const hostPercent = Math.min(100, (consumedMicros / elapsedMicros / hostCpuCount) * 100);
  const quotaPercent = quotaCores !== null && Number.isFinite(quotaCores) && quotaCores > 0
    ? Math.min(100, (consumedMicros / elapsedMicros / quotaCores) * 100)
    : null;

  return {
    hostPercent: Number.isFinite(hostPercent) ? hostPercent : null,
    quotaPercent: quotaPercent !== null && Number.isFinite(quotaPercent) ? quotaPercent : null,
  };
}

export function percentageOfLimit(current: number | null, limit: number | null): number | null {
  if (current === null || limit === null || limit <= 0 || current < 0) return null;
  const value = (current / limit) * 100;
  return Number.isFinite(value) ? Math.min(100, value) : null;
}

export class RollingMetricHistory {
  readonly retentionMs: number;
  readonly maxSamples: number;
  private samples: MetricHistorySample[] = [];

  constructor(options: { retentionMs?: number; maxSamples?: number } = {}) {
    this.retentionMs = options.retentionMs ?? 30 * 60 * 1000;
    this.maxSamples = options.maxSamples ?? 121;
    if (!Number.isSafeInteger(this.retentionMs) || this.retentionMs < 1) {
      throw new Error("retentionMs must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.maxSamples) || this.maxSamples < 1) {
      throw new Error("maxSamples must be a positive safe integer");
    }
  }

  add(sample: MetricHistorySample): void {
    if (!Number.isSafeInteger(sample.sampledAt) || sample.sampledAt < 0) {
      throw new Error("sampledAt must be a non-negative safe integer");
    }
    for (const value of [sample.cpuPercent, sample.memoryBytes]) {
      if (value !== null && (!Number.isFinite(value) || value < 0 || value > MAX_SAFE_COUNTER)) {
        throw new Error("Metric history values must be finite, non-negative safe numbers or null");
      }
    }

    const last = this.samples.at(-1);
    if (last && sample.sampledAt < last.sampledAt) {
      throw new Error("Metric history samples must be chronological");
    }

    this.samples.push({ ...sample });
    const cutoff = sample.sampledAt - this.retentionMs;
    this.samples = this.samples.filter((entry) => entry.sampledAt >= cutoff).slice(-this.maxSamples);
  }

  list(): MetricHistorySample[] {
    return this.samples.map((sample) => ({ ...sample }));
  }

  clear(): void {
    this.samples = [];
  }
}
