import { describe, expect, it } from "vitest";
import {
  calculateCpuUtilization,
  parseCgroupV2Snapshot,
  parseCpuMax,
  percentageOfLimit,
  RollingMetricHistory,
} from "./dashboard-metrics.js";

describe("dashboard cgroup metrics", () => {
  it("parses cgroup v2 CPU, memory and PID counters", () => {
    expect(parseCgroupV2Snapshot({
      cpuStat: "usage_usec 125000\nuser_usec 80000\nsystem_usec 45000\n",
      cpuMax: "50000 100000",
      memoryCurrent: "268435456",
      memoryMax: "536870912",
      pidsCurrent: "17",
      pidsMax: "64",
    })).toEqual({
      cpuUsageMicros: 125000,
      cpuQuotaCores: 0.5,
      memoryCurrentBytes: 268435456,
      memoryLimitBytes: 536870912,
      pidsCurrent: 17,
      pidsLimit: 64,
    });
  });

  it("represents unlimited and malformed limits as unavailable rather than zero", () => {
    expect(parseCpuMax("max 100000")).toBeNull();
    expect(parseCpuMax("50000 0")).toBeNull();
    expect(parseCgroupV2Snapshot({
      cpuStat: "user_usec 10",
      cpuMax: "max 100000",
      memoryCurrent: "not-a-number",
      memoryMax: "max",
      pidsCurrent: "3",
      pidsMax: "max",
    })).toEqual({
      cpuUsageMicros: null,
      cpuQuotaCores: null,
      memoryCurrentBytes: null,
      memoryLimitBytes: null,
      pidsCurrent: 3,
      pidsLimit: null,
    });
  });

  it("calculates host-wide and quota-normalized CPU percentages", () => {
    expect(calculateCpuUtilization(1_000_000, 1_500_000, 1000, 4, 0.5)).toEqual({
      hostPercent: 12.5,
      quotaPercent: 100,
    });
  });

  it("does not invent utilization when counters reset or inputs are invalid", () => {
    expect(calculateCpuUtilization(200, 100, 1000, 4, 1)).toEqual({
      hostPercent: null,
      quotaPercent: null,
    });
    expect(calculateCpuUtilization(null, 100, 1000, 4, 1)).toEqual({
      hostPercent: null,
      quotaPercent: null,
    });
  });

  it("returns null percentages when the effective limit is unknown", () => {
    expect(percentageOfLimit(20, null)).toBeNull();
    expect(percentageOfLimit(20, 0)).toBeNull();
    expect(percentageOfLimit(20, 100)).toBe(20);
  });
});

describe("rolling dashboard metric history", () => {
  it("retains only the configured time window and sample bound", () => {
    const history = new RollingMetricHistory({ retentionMs: 30_000, maxSamples: 3 });
    history.add({ sampledAt: 0, cpuPercent: 1, memoryBytes: 100 });
    history.add({ sampledAt: 15_000, cpuPercent: 2, memoryBytes: 200 });
    history.add({ sampledAt: 30_000, cpuPercent: 3, memoryBytes: 300 });
    history.add({ sampledAt: 45_000, cpuPercent: 4, memoryBytes: 400 });

    expect(history.list()).toEqual([
      { sampledAt: 15_000, cpuPercent: 2, memoryBytes: 200 },
      { sampledAt: 30_000, cpuPercent: 3, memoryBytes: 300 },
      { sampledAt: 45_000, cpuPercent: 4, memoryBytes: 400 },
    ]);
  });

  it("keeps unavailable metric values as null and returns defensive copies", () => {
    const history = new RollingMetricHistory();
    history.add({ sampledAt: 100, cpuPercent: null, memoryBytes: 0 });
    const returned = history.list();
    returned[0]!.sampledAt = 999;
    expect(history.list()).toEqual([{ sampledAt: 100, cpuPercent: null, memoryBytes: 0 }]);
  });

  it("rejects out-of-order and invalid samples", () => {
    const history = new RollingMetricHistory();
    history.add({ sampledAt: 100, cpuPercent: 1, memoryBytes: 2 });
    expect(() => history.add({ sampledAt: 99, cpuPercent: 1, memoryBytes: 2 })).toThrow(/chronological/);
    expect(() => history.add({ sampledAt: 101, cpuPercent: -1, memoryBytes: 2 })).toThrow(/finite/);
  });
});
