import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dashboardTestDataDir = mkdtempSync(path.join(tmpdir(), "vps-mcp-dashboard-test-"));
process.env.MCP_AUTH_MODE = "token";
process.env.MCP_AUTH_TOKEN = "dashboard-test-token-that-is-at-least-thirty-two-characters";
process.env.MCP_DATA_DIR = dashboardTestDataDir;

const mocks = vi.hoisted(() => ({
  getDashboardInventory: vi.fn(),
  listRepositoriesReadOnly: vi.fn(),
  listTaskWorkspaces: vi.fn(),
  runManagedGit: vi.fn(),
}));

vi.mock("./sandbox-runtime.js", () => ({
  createSandboxRuntimeAdapter: () => ({ getDashboardInventory: mocks.getDashboardInventory }),
}));
vi.mock("./repositories.js", () => ({
  listRepositoriesReadOnly: mocks.listRepositoriesReadOnly,
  runManagedGit: mocks.runManagedGit,
}));
vi.mock("./task-workspaces.js", () => ({
  listTaskWorkspaces: mocks.listTaskWorkspaces,
}));

const { clearDashboardCacheForTests, getDashboardHistory, getDashboardSnapshot } = await import("./dashboard.js");

afterAll(() => rmSync(dashboardTestDataDir, { recursive: true, force: true }));

const workload = {
  id: "5a1b9a61-6d3b-4f2e-8c7a-1a2b3c4d5e6f",
  repositoryId: "repo-123",
  worktreeId: null,
  imageDigest: "registry.example/test@sha256:" + "a".repeat(64),
  resources: { cpuMilli: 500, memoryMiB: 256, pids: 64, diskMiB: 2048 },
  networkPolicy: "task-no-egress",
  retained: false,
  lifecycleStatus: "running",
  runtimeState: "running",
  runtimeId: "0123456789abcdef",
  createdAt: "2026-11-25T20:00:00.000Z",
  updatedAt: "2026-11-25T20:00:00.000Z",
  runtimeCreatedAt: "2026-11-25T20:00:00.000Z",
  runtimeStartedAt: new Date(Date.now() - 60_000).toISOString(),
  networkRxBytes: 4096,
  networkTxBytes: 8192,
  networkStatus: "available" as const,
  cgroup: {
    "cpu.stat": "usage_usec 1000000\nuser_usec 700000\nsystem_usec 300000",
    "cpu.max": "50000 100000",
    "memory.current": String(128 * 1024 * 1024),
    "memory.max": String(256 * 1024 * 1024),
    "pids.current": "3",
    "pids.max": "64",
  },
  metricsStatus: "available",
};

function inventory(usageMicros = 1_000_000) {
  return {
    collectedAt: new Date().toISOString(),
    workloads: [{
      ...workload,
      cgroup: { ...workload.cgroup, "cpu.stat": "usage_usec " + usageMicros },
    }],
    unmatchedContainers: [],
    sources: { workloadRegistry: "available", podmanInventory: "available" },
  };
}

describe("dashboard snapshot aggregation", () => {
  beforeEach(() => {
    clearDashboardCacheForTests();
    vi.clearAllMocks();
    mocks.getDashboardInventory.mockResolvedValue(inventory());
    mocks.listRepositoriesReadOnly.mockResolvedValue({
      schemaVersion: 1, count: 1,
      repositories: [{ id: "repo-123", fullName: "deputy-proxy/example" }],
    });
    mocks.listTaskWorkspaces.mockResolvedValue([]);
  });

  it("aggregates host, runtime, repository and cgroup metrics without mutating source records", async () => {
    const snapshot = await getDashboardSnapshot({ forceRefresh: true });
    expect(snapshot.host.cpuCount).toBeGreaterThan(0);
    expect(snapshot.host.totalMemoryBytes).toBeGreaterThan(0);
    expect(snapshot.host.dataFilesystem?.totalBytes).toBeGreaterThan(0);
    expect(snapshot.summary).toMatchObject({
      managedSandboxCount: 1, runningSandboxCount: 1, stoppedSandboxCount: 0, unknownSandboxCount: 0,
    });
    expect(snapshot.sandboxes[0]).toMatchObject({
      id: workload.id,
      repository: { id: "repo-123", fullName: "deputy-proxy/example" },
      runtimeState: "running",
      resources: {
        cpuQuotaCores: 0.5,
        memoryCurrentBytes: 128 * 1024 * 1024,
        memoryLimitBytes: 256 * 1024 * 1024,
        memoryPercent: 50,
        pidsCurrent: 3,
        pidsLimit: 64,
        configuredCpuMilli: 500,
        configuredMemoryBytes: 256 * 1024 * 1024,
        configuredPids: 64,
      },
    });
    expect(snapshot.sandboxes[0]?.resources.cpuQuotaPercent).toBeNull();
    expect(snapshot.sandboxes[0]?.resources.workspaceDiskBytes).toBeNull();
    expect(snapshot.sandboxes[0]?.resources.networkRxBytes).toBe(4096);
    expect(snapshot.sandboxes[0]?.resources.networkTxBytes).toBe(8192);
    expect(snapshot.sandboxes[0]?.runtimeStartedAt).toBe(workload.runtimeStartedAt);
    expect(snapshot.sandboxes[0]?.uptimeSeconds).toBeGreaterThan(0);
    expect(snapshot.sandboxes[0]?.uptimeSeconds).toBeLessThan(5 * 60 * 60);
    expect(getDashboardHistory().host).toHaveLength(1);
  });

  it("reads actual branch, commit and dirty state from a bounded managed worktree", async () => {
    const workspaceId = "71b4a12c-7a43-4b70-9a5d-9e6e8a3c5a11";
    const worktreePath = path.join(dashboardTestDataDir, "task-workspaces", "worktrees", "repo-123", workspaceId);
    mkdirSync(worktreePath, { recursive: true });
    writeFileSync(path.join(worktreePath, "disk-probe.bin"), Buffer.alloc(1234));
    mocks.listTaskWorkspaces.mockResolvedValue([{
      id: workspaceId,
      repositoryId: "repo-123",
      repositoryFullName: "deputy-proxy/example",
      taskId: "task-156",
      worktreePath,
      branchName: "task/issue-156-dashboard",
      baseRef: "development",
      baseSha: "b".repeat(40),
      targetPullRequestBranch: "development",
      status: "active",
      retentionPolicy: { mode: "manual" },
      createdAt: "2026-11-25T20:00:00.000Z",
      updatedAt: "2026-11-25T20:00:00.000Z",
    }]);
    mocks.getDashboardInventory.mockResolvedValue({
      ...inventory(),
      workloads: [{ ...inventory().workloads[0], worktreeId: workspaceId }],
    });
    mocks.runManagedGit.mockImplementation(async (args: string[]) => {
      if (args[2] === "branch") return "task/issue-156-dashboard";
      if (args[2] === "rev-parse") return "c".repeat(40);
      if (args[2] === "status") return "M  staged.txt\n M modified.txt\n?? notes.md";
      throw new Error("Unexpected Git command");
    });

    const snapshot = await getDashboardSnapshot({ forceRefresh: true });
    expect(snapshot.sandboxes[0]?.workspace).toMatchObject({
      id: workspaceId,
      branch: "task/issue-156-dashboard",
      commit: "c".repeat(40),
      dirty: true,
      stagedChanges: 1,
      untrackedFiles: 1,
      diskBytes: 1234,
      diskStatus: "available",
      status: "active",
    });
    expect(mocks.runManagedGit).toHaveBeenCalledTimes(3);
    const gitArguments = mocks.runManagedGit.mock.calls.map(([args]) => args as string[]);
    expect(gitArguments.every((args) => args[0] === "-C" && args[1] === worktreePath)).toBe(true);
    expect(gitArguments.map((args) => args[2]).sort()).toEqual(["branch", "rev-parse", "status"]);
  });

  it("shares an in-flight refresh and caches the resulting snapshot", async () => {
    let resolveInventory!: (value: ReturnType<typeof inventory>) => void;
    mocks.getDashboardInventory.mockImplementation(() => new Promise((resolve) => { resolveInventory = resolve; }));
    const first = getDashboardSnapshot({ forceRefresh: true });
    const second = getDashboardSnapshot({ forceRefresh: true });
    await Promise.resolve();
    resolveInventory(inventory());
    const [one, two] = await Promise.all([first, second]);
    expect(one.generatedAt).toBe(two.generatedAt);
    expect(mocks.getDashboardInventory).toHaveBeenCalledOnce();

    await getDashboardSnapshot();
    expect(mocks.getDashboardInventory).toHaveBeenCalledOnce();
  });

  it("returns useful host data and explicit warnings when runtime inventory fails", async () => {
    mocks.getDashboardInventory.mockRejectedValue(new Error("runtime unavailable"));
    mocks.listRepositoriesReadOnly.mockRejectedValue(new Error("repository registry unavailable"));
    mocks.listTaskWorkspaces.mockRejectedValue(new Error("workspace registry unavailable"));
    const snapshot = await getDashboardSnapshot({ forceRefresh: true });
    expect(snapshot.host.totalMemoryBytes).toBeGreaterThan(0);
    expect(snapshot.sandboxes).toEqual([]);
    expect(snapshot.sources.runtime.status).toBe("unavailable");
    expect(snapshot.sources.repositories.status).toBe("unavailable");
    expect(snapshot.sources.workspaces.status).toBe("unavailable");
    expect(snapshot.warnings).toHaveLength(3);
  });
});
