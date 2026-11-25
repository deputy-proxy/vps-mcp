import { afterAll, beforeAll, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const state = vi.hoisted(() => ({
  dataDir: "",
  repository: {
    id: "acme-demo-a1b2c3d4e5", fullName: "acme/demo", status: "cloned",
    persistentEnvironmentPaths: [] as string[],
  },
}));
vi.mock("./config.js", () => ({ config: { get dataDir() { return state.dataDir; } } }));
vi.mock("./repositories.js", () => ({
  getManagedRepository: async () => ({ ...state.repository, persistentEnvironmentPaths: [...state.repository.persistentEnvironmentPaths] }),
  updateRepository: async (input: { persistentEnvironmentPaths: string[] }) => {
    state.repository.persistentEnvironmentPaths = [...input.persistentEnvironmentPaths];
    return state.repository;
  },
  withRepositoryLock: async (_id: string, operation: (repository: typeof state.repository) => Promise<unknown>) => operation(state.repository),
}));

const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "vps-mcp-project-environments-"));
state.dataDir = path.join(temporaryDirectory, "data");
const { inspectProjectEnvironment, listProjectEnvironments, registerProjectEnvironment, updateProjectEnvironment } = await import("./project-environments.js");

beforeAll(async () => { await fs.mkdir(state.dataDir, { recursive: true }); });
afterAll(async () => { await fs.rm(temporaryDirectory, { recursive: true, force: true }); });

it("registers a development-only environment with canonical isolated paths and durable permissions", async () => {
  const result = await registerProjectEnvironment({ repositoryId: state.repository.id, profileId: "laravel-php" });
  expect(result.created).toBe(true);
  expect(result.environment).toMatchObject({
    repositoryId: state.repository.id, repositoryFullName: "acme/demo", sourceBranch: "development",
    desiredState: "provisioned", observedState: "provisioned", activeReleaseId: null,
    resources: { cpuMilli: 500, memoryMiB: 1024, pids: 128, diskMiB: 10240 },
  });
  expect(result.environment.databasePath).toBe(path.join(state.dataDir, "project-environments", state.repository.id, "database"));
  expect(state.repository.persistentEnvironmentPaths).toContain(result.environment.rootPath);
  const stat = await fs.stat(path.join(state.dataDir, "project-environments", "registry.json"));
  expect(stat.mode & 0o777).toBe(0o600);
  expect((await listProjectEnvironments()).count).toBe(1);
  expect((await inspectProjectEnvironment(state.repository.id)).environment.id).toBe(result.environment.id);
});

it("is idempotent for an identical environment and rejects conflicting profile or resources", async () => {
  const first = await registerProjectEnvironment({ repositoryId: state.repository.id, profileId: "laravel-php" });
  const second = await registerProjectEnvironment({ repositoryId: state.repository.id, profileId: "laravel-php" });
  expect(second.created).toBe(false);
  expect(second.environment.id).toBe(first.environment.id);
  await expect(registerProjectEnvironment({ repositoryId: state.repository.id, profileId: "node" })).rejects.toThrow("different profile or resource reservation");
});

it("validates repository identity, profile and bounded resource requests", async () => {
  await expect(registerProjectEnvironment({ repositoryId: "../escape", profileId: "laravel-php" })).rejects.toThrow("Invalid repository ID");
  await expect(registerProjectEnvironment({ repositoryId: state.repository.id, profileId: "../unsafe" })).rejects.toThrow("Invalid project environment profile ID");
  await expect(registerProjectEnvironment({ repositoryId: state.repository.id, profileId: "laravel-php", resources: { cpuMilli: 5000 } })).rejects.toThrow("cpuMilli must be between");
});

it("persists lifecycle observations and health without changing the source branch", async () => {
  await registerProjectEnvironment({ repositoryId: state.repository.id, profileId: "laravel-php" });
  const updated = await updateProjectEnvironment({
    repositoryId: state.repository.id, desiredState: "running", observedState: "running",
    health: { status: "healthy", checkedAt: new Date().toISOString(), checks: ["http"] }, reconciled: true,
  });
  expect(updated.environment).toMatchObject({ sourceBranch: "development", desiredState: "running", observedState: "running", health: { status: "healthy", checks: ["http"] } });
  expect((await inspectProjectEnvironment(state.repository.id)).environment.lastReconciledAt).not.toBeNull();
});


it("enforces terminal deprovisioning and rejects invalid lifecycle transitions", async () => {
  await registerProjectEnvironment({ repositoryId: state.repository.id, profileId: "laravel-php" });
  await updateProjectEnvironment({ repositoryId: state.repository.id, desiredState: "deprovisioned", observedState: "deprovisioned" });
  await expect(updateProjectEnvironment({ repositoryId: state.repository.id, desiredState: "running" })).rejects.toThrow("Invalid project environment state transition");
});
