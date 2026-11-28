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
  profileReady: false,
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
vi.mock("./service-profiles.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./service-profiles.js")>();
  return {
    ...actual,
    getServiceProfile: (profileId: string, version = 1) => {
      const profile = actual.getServiceProfile(profileId, version);
      return state.profileReady ? {
        ...profile,
        readiness: "deployable",
        runtime: { ...profile.runtime, imageDigest: "ghcr.io/deputy-proxy/vps-mcp-laravel-php@sha256:" + "a".repeat(64) },
        dependencies: profile.dependencies.map((dependency) => ({
          ...dependency,
          imageDigest: `docker.io/library/${dependency.name}@sha256:${dependency.name === "mysql" ? "b" : "c"}` + "0".repeat(63),
        })),
      } : profile;
    },
  };
});


function dependencyRuntimeMocks() {
  return {
    prepareProjectDependencySecrets: vi.fn().mockResolvedValue({ ok: true }),
    createProjectDependencyWorkload: vi.fn(async (input: { workloadId: string }) => ({ workload: { id: input.workloadId, status: "created" } })),
    startProjectDependencyWorkload: vi.fn(async (id: string) => ({ workloadId: id, status: "running", health: { status: "healthy" as const, checkedAt: new Date().toISOString(), checks: ["dependency"] } })),
    inspectProjectDependencyWorkload: vi.fn(async (id: string) => ({ workloadId: id, health: { status: "healthy" as const, checkedAt: new Date().toISOString(), checks: ["dependency"] } })),
    stopProjectDependencyWorkload: vi.fn(async (id: string) => ({ workloadId: id, status: "stopped" })),
    removeProjectDependencyWorkload: vi.fn(async (input: { workloadId: string }) => ({ workloadId: input.workloadId, status: "removed" })),
  };
}

const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "vps-mcp-project-environments-"));
state.dataDir = path.join(temporaryDirectory, "data");
const previousProjectEnvironmentRoot = process.env.VPS_SANDBOX_PROJECT_ENV_ROOT;
const previousProjectEnvironmentRootsJson = process.env.VPS_SANDBOX_PROJECT_ENV_ROOTS_JSON;
delete process.env.VPS_SANDBOX_PROJECT_ENV_ROOTS_JSON;
process.env.VPS_SANDBOX_PROJECT_ENV_ROOT = path.join(state.dataDir, "project-environments");
const { backupProjectEnvironment, restoreProjectEnvironmentBackup, deprovisionProjectEnvironment, inspectProjectEnvironment, inspectProjectEnvironmentRuntime, listProjectEnvironments, prepareProjectEnvironmentMountAccess, provisionProjectEnvironment, registerProjectEnvironment, setProjectEnvironmentRelease, startProjectEnvironment, stopProjectEnvironment, updateProjectEnvironment } = await import("./project-environments.js");

beforeAll(async () => { await fs.mkdir(state.dataDir, { recursive: true }); });
afterAll(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
  if (previousProjectEnvironmentRoot === undefined) delete process.env.VPS_SANDBOX_PROJECT_ENV_ROOT;
  else process.env.VPS_SANDBOX_PROJECT_ENV_ROOT = previousProjectEnvironmentRoot;
  if (previousProjectEnvironmentRootsJson === undefined) delete process.env.VPS_SANDBOX_PROJECT_ENV_ROOTS_JSON;
  else process.env.VPS_SANDBOX_PROJECT_ENV_ROOTS_JSON = previousProjectEnvironmentRootsJson;
});

it("registers a development-only environment with canonical isolated paths and durable permissions", async () => {
  const result = await registerProjectEnvironment({ repositoryId: state.repository.id, profileId: "laravel-php" });
  expect(result.created).toBe(true);
  expect(result.environment).toMatchObject({
    repositoryId: state.repository.id, repositoryFullName: "acme/demo", sourceBranch: "development",
    desiredState: "provisioned", observedState: "provisioned", activeReleaseId: null,
    resources: { cpuMilli: 1000, memoryMiB: 1792, pids: 256, diskMiB: 20480 },
  });
  expect(result.environment.databasePath).toBe(path.join(state.dataDir, "project-environments", state.repository.id, "database"));
  expect(state.repository.persistentEnvironmentPaths).toContain(result.environment.rootPath);
  const stat = await fs.stat(path.join(state.dataDir, "project-environments", "registry.json"));
  expect(stat.mode & 0o777).toBe(0o600);
  expect((await listProjectEnvironments()).count).toBe(1);
  expect((await inspectProjectEnvironment(state.repository.id)).environment.id).toBe(result.environment.id);
});

it("restricts the PHP-FPM acceptance profile to the dedicated disposable repository", async () => {
  const previousRepository = state.repository;
  state.repository = {
    id: "acme-unapproved-acceptance-1234567890", fullName: "acme/unapproved-acceptance", status: "cloned",
    persistentEnvironmentPaths: [],
  };
  try {
    await expect(registerProjectEnvironment({
      repositoryId: state.repository.id,
      profileId: "project-service-acceptance",
      profileVersion: 1,
    })).rejects.toThrow("restricted to its disposable acceptance repository");

    state.repository = {
      id: "deputy-proxy-toti-invatam-org-44fadec4d6",
      fullName: "deputy-proxy/toti-invatam-org",
      status: "cloned",
      persistentEnvironmentPaths: [],
    };
    const result = await registerProjectEnvironment({
      repositoryId: state.repository.id,
      profileId: "project-service-acceptance",
      profileVersion: 1,
    });
    expect(result.created).toBe(true);
    expect(result.environment).toMatchObject({
      repositoryId: "deputy-proxy-toti-invatam-org-44fadec4d6",
      profileId: "project-service-acceptance",
      profileVersion: 1,
      resources: { cpuMilli: 500, memoryMiB: 1024, pids: 128, diskMiB: 10240 },
    });
  } finally {
    state.repository = previousRepository;
  }
});

it("is idempotent for an identical environment and rejects conflicting profile or resources", async () => {
  const first = await registerProjectEnvironment({ repositoryId: state.repository.id, profileId: "laravel-php" });
  const second = await registerProjectEnvironment({ repositoryId: state.repository.id, profileId: "laravel-php" });
  expect(second.created).toBe(false);
  expect(second.environment.id).toBe(first.environment.id);
  await expect(registerProjectEnvironment({ repositoryId: state.repository.id, profileId: "laravel-php", resources: { cpuMilli: 1500 } })).rejects.toThrow("different profile or resource reservation");
});

it("allows an explicit versioned profile upgrade only while the environment is idle", async () => {
  const previousRepository = state.repository;
  state.repository = {
    id: "acme-profile-upgrade-d4e5f6a7b8", fullName: "acme/profile-upgrade", status: "cloned",
    persistentEnvironmentPaths: [],
  };
  try {
    const first = await registerProjectEnvironment({ repositoryId: state.repository.id, profileId: "laravel-php", profileVersion: 1 });
    const upgraded = await registerProjectEnvironment({
      repositoryId: state.repository.id, profileId: "laravel-php", profileVersion: 3,
      resources: { cpuMilli: 1200, memoryMiB: 2048, pids: 320, diskMiB: 21504 },
    });
    expect(upgraded.created).toBe(false);
    expect(upgraded.profileUpdated).toBe(true);
    expect(upgraded.resourcesUpdated).toBe(true);
    expect(upgraded.environment.id).toBe(first.environment.id);
    expect(upgraded.environment.profileVersion).toBe(3);
    expect(upgraded.environment.resources).toEqual({ cpuMilli: 1200, memoryMiB: 2048, pids: 320, diskMiB: 21504 });
  } finally {
    state.repository = previousRepository;
  }
});

it("rejects a profile upgrade while any project workload is registered", async () => {
  const previousRepository = state.repository;
  state.repository = {
    id: "acme-active-profile-upgrade-e5f6a7b8c9", fullName: "acme/active-profile-upgrade", status: "cloned",
    persistentEnvironmentPaths: [],
  };
  try {
    await registerProjectEnvironment({ repositoryId: state.repository.id, profileId: "laravel-php", profileVersion: 1 });
    await updateProjectEnvironment({ repositoryId: state.repository.id, workloadIds: ["234e5321-b4d7-4d4f-be92-ce56a984adaa"], workloadReleaseId: "234e5321-b4d7-4d4f-be92-ce56a984adaa" });
    await expect(registerProjectEnvironment({
      repositoryId: state.repository.id, profileId: "laravel-php", profileVersion: 3,
      resources: { cpuMilli: 1200, memoryMiB: 2048, pids: 320, diskMiB: 21504 },
    })).rejects.toThrow("different profile or resource reservation");
  } finally {
    state.repository = previousRepository;
  }
});

it("allows an explicit full-vector resize only while the environment is idle", async () => {
  const previousRepository = state.repository;
  state.repository = {
    id: "acme-resource-resize-c3d4e5f6a7", fullName: "acme/resource-resize", status: "cloned",
    persistentEnvironmentPaths: [],
  };
  try {
    const first = await registerProjectEnvironment({ repositoryId: state.repository.id, profileId: "laravel-php" });
    const resizedResources = { cpuMilli: 1400, memoryMiB: 3072, pids: 384, diskMiB: 24576 };
    const resized = await registerProjectEnvironment({ repositoryId: state.repository.id, profileId: "laravel-php", resources: resizedResources });
    expect(resized.created).toBe(false);
    expect(resized.resourcesUpdated).toBe(true);
    expect(resized.environment.id).toBe(first.environment.id);
    expect(resized.environment.resources).toEqual(resizedResources);
  } finally {
    state.repository = previousRepository;
  }
});

it("reserves optional Redis only when explicitly enabled", async () => {
  const previousRepository = state.repository;
  state.repository = { id: "acme-redis-optional-1234567890", fullName: "acme/redis-optional", status: "cloned", persistentEnvironmentPaths: [] };
  try {
    const mysqlOnly = await registerProjectEnvironment({ repositoryId: state.repository.id, profileId: "laravel-php", profileVersion: 4 });
    expect(mysqlOnly.environment.enabledDependencies).toEqual(["mysql"]);
    expect(mysqlOnly.environment.resources).toEqual({ cpuMilli: 1000, memoryMiB: 1792, pids: 256, diskMiB: 20480 });
  } finally { state.repository = previousRepository; }
  state.repository = { id: "acme-redis-enabled-1234567890", fullName: "acme/redis-enabled", status: "cloned", persistentEnvironmentPaths: [] };
  try {
    const withRedis = await registerProjectEnvironment({ repositoryId: state.repository.id, profileId: "laravel-php", profileVersion: 4, enabledDependencies: ["mysql", "redis"] });
    expect(withRedis.environment.enabledDependencies).toEqual(["mysql", "redis"]);
    expect(withRedis.environment.resources).toEqual({ cpuMilli: 1200, memoryMiB: 2048, pids: 320, diskMiB: 21504 });
    await expect(registerProjectEnvironment({ repositoryId: state.repository.id, profileId: "laravel-php", profileVersion: 4, enabledDependencies: ["redis"] })).rejects.toThrow("All required project dependencies must be enabled");
  } finally { state.repository = previousRepository; }
});

it("migrates schema-v1 environments without changing identity, resource reservations or selected dependencies", async () => {
  const previousRepository = state.repository;
  state.repository = { id: "acme-registry-migration-123456789", fullName: "acme/registry-migration", status: "cloned", persistentEnvironmentPaths: [] };
  try {
    const registered = await registerProjectEnvironment({ repositoryId: state.repository.id, profileId: "laravel-php", enabledDependencies: ["mysql", "redis"] });
    const registryPath = path.join(state.dataDir, "project-environments", "registry.json");
    const registry = JSON.parse(await fs.readFile(registryPath, "utf8"));
    const item = registry.environments.find((environment: { repositoryId: string }) => environment.repositoryId === state.repository.id);
    item.schemaVersion = 1;
    delete item.enabledDependencies;
    registry.schemaVersion = 1;
    await fs.writeFile(registryPath, JSON.stringify(registry), { mode: 0o600 });
    const migrated = await inspectProjectEnvironment(state.repository.id);
    expect(migrated.environment).toMatchObject({
      schemaVersion: 2, id: registered.environment.id, enabledDependencies: ["mysql", "redis"],
      resources: registered.environment.resources,
    });
    expect((await listProjectEnvironments()).schemaVersion).toBe(2);
  } finally { state.repository = previousRepository; }
});

it("migrates pre-dependency schema-v1 environments without inventing dependency workloads or increasing reservations", async () => {
  const previousRepository = state.repository;
  state.repository = { id: "acme-legacy-app-only-123456789", fullName: "acme/legacy-app-only", status: "cloned", persistentEnvironmentPaths: [] };
  try {
    const registered = await registerProjectEnvironment({ repositoryId: state.repository.id, profileId: "laravel-php" });
    const registryPath = path.join(state.dataDir, "project-environments", "registry.json");
    const registry = JSON.parse(await fs.readFile(registryPath, "utf8"));
    const item = registry.environments.find((environment: { repositoryId: string }) => environment.repositoryId === state.repository.id);
    item.schemaVersion = 1;
    item.resources = { cpuMilli: 500, memoryMiB: 1024, pids: 128, diskMiB: 10240 };
    delete item.enabledDependencies;
    registry.schemaVersion = 1;
    await fs.writeFile(registryPath, JSON.stringify(registry), { mode: 0o600 });

    const migrated = await inspectProjectEnvironment(state.repository.id);
    expect(migrated.environment).toMatchObject({
      schemaVersion: 2,
      id: registered.environment.id,
      enabledDependencies: [],
      legacyDependencySelection: true,
      resources: { cpuMilli: 500, memoryMiB: 1024, pids: 128, diskMiB: 10240 },
    });
    expect((await listProjectEnvironments()).count).toBeGreaterThan(0);
  } finally { state.repository = previousRepository; }
});

it("validates repository identity, profile and bounded resource requests", async () => {
  await expect(registerProjectEnvironment({ repositoryId: "../escape", profileId: "laravel-php" })).rejects.toThrow("Invalid repository ID");
  await expect(registerProjectEnvironment({ repositoryId: state.repository.id, profileId: "../unsafe" })).rejects.toThrow("Invalid project environment profile ID");
  await expect(registerProjectEnvironment({ repositoryId: state.repository.id, profileId: "unknown-profile" })).rejects.toThrow("Unknown project environment profile");
  await expect(registerProjectEnvironment({ repositoryId: state.repository.id, profileId: "laravel-php", resources: { cpuMilli: 5000 } })).rejects.toThrow("cpuMilli must be between");
  await expect(registerProjectEnvironment({ repositoryId: state.repository.id, profileId: "laravel-php", resources: { cpuMilli: 900, memoryMiB: 2048, pids: 320, diskMiB: 21504 } })).rejects.toThrow("cannot be lower than the aggregate profile requirement");
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


it("allows a bounded resource-plan retry after capacity admission fails", async () => {
  const previousRepository = state.repository;
  state.repository = {
    id: "acme-capacity-retry-b2c3d4e5f6", fullName: "acme/capacity-retry", status: "cloned",
    persistentEnvironmentPaths: [],
  };
  try {
    const first = await registerProjectEnvironment({ repositoryId: state.repository.id, profileId: "laravel-php", resources: { cpuMilli: 1500, memoryMiB: 3072, pids: 384, diskMiB: 24576 } });
    await updateProjectEnvironment({
      repositoryId: state.repository.id,
      lastError: "Resource reservation failed: SANDBOX_CAPACITY_EXCEEDED: global memory reservation budget would be exceeded",
    });
    const retried = await registerProjectEnvironment({ repositoryId: state.repository.id, profileId: "laravel-php" });
    expect(retried.created).toBe(false);
    expect(retried.resourcesUpdated).toBe(true);
    expect(retried.environment.id).toBe(first.environment.id);
    expect(retried.environment.resources).toEqual({ cpuMilli: 1000, memoryMiB: 1792, pids: 256, diskMiB: 20480 });
    expect(retried.environment.lastError).toBeNull();
  } finally {
    state.repository = previousRepository;
  }
});

it("enforces terminal deprovisioning and rejects invalid lifecycle transitions", async () => {
  await registerProjectEnvironment({ repositoryId: state.repository.id, profileId: "laravel-php" });
  await updateProjectEnvironment({ repositoryId: state.repository.id, desiredState: "deprovisioned", observedState: "deprovisioned" });
  await expect(updateProjectEnvironment({ repositoryId: state.repository.id, desiredState: "running" })).rejects.toThrow("Invalid project environment state transition");
});

it("prepares only the canonical project release and declared writable mount directories", async () => {
  const previousRepository = state.repository;
  const previousProjectRoot = process.env.VPS_SANDBOX_PROJECT_ENV_ROOT;
  const previousRootsJson = process.env.VPS_SANDBOX_PROJECT_ENV_ROOTS_JSON;
  process.env.VPS_SANDBOX_PROJECT_ENV_ROOT = path.join(state.dataDir, "project-environments");
  process.env.VPS_SANDBOX_PROJECT_ENV_ROOTS_JSON = JSON.stringify([
    { root: "/var/lib/vps-mcp/project-environments", owner: "vps-mcp" },
    { root: process.env.VPS_SANDBOX_PROJECT_ENV_ROOT, owner: "vps-mcp-development" },
  ]);
  state.repository = {
    id: "acme-project-mounts-aabbccddeeff", fullName: "acme/project-mounts", status: "cloned",
    persistentEnvironmentPaths: [],
  };
  try {
    const { environment } = await registerProjectEnvironment({ repositoryId: state.repository.id, profileId: "laravel-php" });
    const releaseId = "134e5321-b4d7-4d4f-be92-ce56a984adaa";
    await updateProjectEnvironment({ repositoryId: state.repository.id, candidateReleaseId: releaseId });
    await fs.mkdir(path.join(environment.releasesPath, releaseId), { recursive: true });
    await prepareProjectEnvironmentMountAccess(state.repository.id, releaseId);
    for (const directory of [
      path.join(environment.storagePath, "app"),
      path.join(environment.storagePath, "framework", "cache"),
      path.join(environment.storagePath, "framework", "sessions"),
      path.join(environment.storagePath, "framework", "views"),
      environment.cachePath,
      environment.logsPath,
    ]) expect((await fs.stat(directory)).isDirectory()).toBe(true);
    await expect(fs.stat(environment.databasePath)).rejects.toThrow();
    await expect(fs.stat(environment.backupsPath)).rejects.toThrow();
  } finally {
    state.repository = previousRepository;
    if (previousProjectRoot === undefined) delete process.env.VPS_SANDBOX_PROJECT_ENV_ROOT;
    else process.env.VPS_SANDBOX_PROJECT_ENV_ROOT = previousProjectRoot;
    if (previousRootsJson === undefined) delete process.env.VPS_SANDBOX_PROJECT_ENV_ROOTS_JSON;
    else process.env.VPS_SANDBOX_PROJECT_ENV_ROOTS_JSON = previousRootsJson;
  }
});

it("provisions from an explicitly deployable digest and retries an interrupted create without changing workload identity", async () => {
  const previousRepository = state.repository;
  const previousProjectRoot = process.env.VPS_SANDBOX_PROJECT_ENV_ROOT;
  state.repository = {
    id: "acme-provision-retry-1234567890", fullName: "acme/provision-retry", status: "cloned",
    persistentEnvironmentPaths: [],
  };
  process.env.VPS_SANDBOX_PROJECT_ENV_ROOT = path.join(state.dataDir, "project-environments");
  state.profileReady = true;
  const runtime = {
    ...dependencyRuntimeMocks(),
    pullImage: vi.fn().mockResolvedValue({ pulled: true }),
    createProjectServiceWorkload: vi.fn()
      .mockRejectedValueOnce(new Error("temporary runtime interruption"))
      .mockResolvedValue({ workload: { id: "", status: "created" } }),
  };
  try {
    const { environment } = await registerProjectEnvironment({ repositoryId: state.repository.id, profileId: "laravel-php" });
    const releaseId = "134e5321-b4d7-4d4f-be92-ce56a984adaa";
    await fs.mkdir(path.join(environment.releasesPath, releaseId), { recursive: true });
    await setProjectEnvironmentRelease({ repositoryId: state.repository.id, releaseId, channel: "candidate" });
    runtime.createProjectServiceWorkload.mockResolvedValue({ workload: { id: environment.id, status: "created" } });
    await expect(provisionProjectEnvironment(state.repository.id, runtime as never)).rejects.toThrow("temporary runtime interruption");
    const interrupted = (await inspectProjectEnvironment(state.repository.id)).environment;
    expect(interrupted).toMatchObject({ observedState: "error", workloadIds: [environment.id], workloadReleaseId: releaseId });
    const retried = await provisionProjectEnvironment(state.repository.id, runtime as never);
    expect(retried.environment).toMatchObject({ observedState: "provisioned", workloadIds: [environment.id], workloadReleaseId: releaseId });
    expect(runtime.pullImage).toHaveBeenCalledTimes(3);
    expect(runtime.pullImage).toHaveBeenCalledWith("ghcr.io/deputy-proxy/vps-mcp-laravel-php@sha256:" + "a".repeat(64));
    expect(runtime.createProjectServiceWorkload).toHaveBeenCalledTimes(2);
    expect(runtime.createProjectServiceWorkload).toHaveBeenLastCalledWith(expect.objectContaining({
      workloadId: environment.id,
      environmentId: environment.id,
      profileId: environment.profileId,
      profileVersion: environment.profileVersion,
      dependencies: [{ name: "mysql", workloadId: expect.any(String) }],
      repositoryId: state.repository.id,
      releaseId,
      image: "ghcr.io/deputy-proxy/vps-mcp-laravel-php@sha256:" + "a".repeat(64),
      resources: { cpuMilli: 500, memoryMiB: 1024, pids: 128, diskMiB: 10240 },
      reservationResources: environment.resources,
      restartPolicy: "unless-stopped",
      command: ["--nodaemonize"],
    }));
  } finally {
    state.profileReady = false;
    state.repository = previousRepository;
    if (previousProjectRoot === undefined) delete process.env.VPS_SANDBOX_PROJECT_ENV_ROOT;
    else process.env.VPS_SANDBOX_PROJECT_ENV_ROOT = previousProjectRoot;
  }
});

it("provisions the repository-restricted PHP-FPM acceptance profile with only the approved image", async () => {
  const previousRepository = state.repository;
  const previousProjectRoot = process.env.VPS_SANDBOX_PROJECT_ENV_ROOT;
  const previousRootsJson = process.env.VPS_SANDBOX_PROJECT_ENV_ROOTS_JSON;
  state.repository = {
    id: "deputy-proxy-toti-invatam-org-44fadec4d6",
    fullName: "deputy-proxy/toti-invatam-org",
    status: "cloned",
    persistentEnvironmentPaths: [],
  };
  process.env.VPS_SANDBOX_PROJECT_ENV_ROOT = path.join(state.dataDir, "project-environments");
  process.env.VPS_SANDBOX_PROJECT_ENV_ROOTS_JSON = JSON.stringify([
    { root: "/var/lib/vps-mcp/project-environments", owner: "vps-mcp" },
    { root: process.env.VPS_SANDBOX_PROJECT_ENV_ROOT, owner: "vps-mcp-development" },
  ]);
  const runtime = {
    ...dependencyRuntimeMocks(),
    pullImage: vi.fn().mockResolvedValue({ pulled: true }),
    createProjectServiceWorkload: vi.fn().mockResolvedValue({ workload: { id: "", status: "created" } }),
  };
  try {
    const { environment } = await registerProjectEnvironment({
      repositoryId: state.repository.id,
      profileId: "project-service-acceptance",
      profileVersion: 1,
    });
    const releaseId = "234e5321-b4d7-4d4f-be92-ce56a984adaa";
    await fs.mkdir(path.join(environment.releasesPath, releaseId), { recursive: true });
    await setProjectEnvironmentRelease({ repositoryId: state.repository.id, releaseId, channel: "candidate" });

    const provisioned = await provisionProjectEnvironment(state.repository.id, runtime as never);
    expect(provisioned.environment).toMatchObject({
      profileId: "project-service-acceptance",
      profileVersion: 1,
      observedState: "provisioned",
      workloadIds: [environment.id],
      workloadReleaseId: releaseId,
    });
    expect(runtime.pullImage).toHaveBeenCalledExactlyOnceWith(
      "ghcr.io/deputy-proxy/vps-mcp-laravel-php@sha256:10a7f5152d0bea6be3bde3ea3c6697154f20245128372833629a6d547e298b72",
    );
    expect(runtime.createProjectServiceWorkload).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      workloadId: environment.id,
      environmentId: environment.id,
      profileId: environment.profileId,
      profileVersion: environment.profileVersion,
      dependencies: [],
      repositoryId: state.repository.id,
      releaseId,
      image: "ghcr.io/deputy-proxy/vps-mcp-laravel-php@sha256:10a7f5152d0bea6be3bde3ea3c6697154f20245128372833629a6d547e298b72",
      resources: { cpuMilli: 500, memoryMiB: 1024, pids: 128, diskMiB: 10240 },
      reservationResources: environment.resources,
      restartPolicy: "unless-stopped",
      command: ["--nodaemonize"],
    }));
  } finally {
    state.repository = previousRepository;
    if (previousProjectRoot === undefined) delete process.env.VPS_SANDBOX_PROJECT_ENV_ROOT;
    else process.env.VPS_SANDBOX_PROJECT_ENV_ROOT = previousProjectRoot;
    if (previousRootsJson === undefined) delete process.env.VPS_SANDBOX_PROJECT_ENV_ROOTS_JSON;
    else process.env.VPS_SANDBOX_PROJECT_ENV_ROOTS_JSON = previousRootsJson;
  }
});

it("does not persist a workload identity when the approved image pull fails", async () => {
  const previousRepository = state.repository;
  const previousProjectRoot = process.env.VPS_SANDBOX_PROJECT_ENV_ROOT;
  state.repository = {
    id: "acme-image-pull-retry-1234567890", fullName: "acme/image-pull-retry", status: "cloned",
    persistentEnvironmentPaths: [],
  };
  process.env.VPS_SANDBOX_PROJECT_ENV_ROOT = path.join(state.dataDir, "project-environments");
  state.profileReady = true;
  const runtime = {
    ...dependencyRuntimeMocks(),
    pullImage: vi.fn().mockRejectedValueOnce(new Error("registry unavailable")).mockResolvedValue({ pulled: true }),
    createProjectServiceWorkload: vi.fn().mockResolvedValue({ workload: { id: "", status: "created" } }),
  };
  try {
    const { environment } = await registerProjectEnvironment({ repositoryId: state.repository.id, profileId: "laravel-php" });
    const releaseId = "134e5321-b4d7-4d4f-be92-ce56a984adaa";
    await fs.mkdir(path.join(environment.releasesPath, releaseId), { recursive: true });
    await setProjectEnvironmentRelease({ repositoryId: state.repository.id, releaseId, channel: "candidate" });
    await expect(provisionProjectEnvironment(state.repository.id, runtime as never)).rejects.toThrow("registry unavailable");
    expect((await inspectProjectEnvironment(state.repository.id)).environment).toMatchObject({ observedState: "error", workloadIds: [], workloadReleaseId: null });
    runtime.createProjectServiceWorkload.mockResolvedValue({ workload: { id: environment.id, status: "created" } });
    const retried = await provisionProjectEnvironment(state.repository.id, runtime as never);
    expect(retried.environment).toMatchObject({ observedState: "provisioned", workloadIds: [environment.id], workloadReleaseId: releaseId });
    expect(runtime.createProjectServiceWorkload).toHaveBeenCalledTimes(1);
  } finally {
    state.profileReady = false;
    state.repository = previousRepository;
    if (previousProjectRoot === undefined) delete process.env.VPS_SANDBOX_PROJECT_ENV_ROOT;
    else process.env.VPS_SANDBOX_PROJECT_ENV_ROOT = previousProjectRoot;
  }
});

it("retains workload identity and reservation until interrupted start, stop and remove operations reconcile", async () => {
  const previousRepository = state.repository;
  state.repository = {
    id: "acme-lifecycle-retry-1234567890", fullName: "acme/lifecycle-retry", status: "cloned",
    persistentEnvironmentPaths: [],
  };
  const runtime = {
    ...dependencyRuntimeMocks(),
    startProjectServiceWorkload: vi.fn().mockRejectedValueOnce(new Error("start interrupted")).mockResolvedValue({ status: "running" }),
    stopProjectServiceWorkload: vi.fn().mockRejectedValueOnce(new Error("stop interrupted")).mockResolvedValue({ status: "stopped" }),
    removeProjectServiceWorkload: vi.fn().mockRejectedValueOnce(new Error("remove interrupted")).mockResolvedValue({ status: "removed" }),
    releaseProjectResources: vi.fn().mockResolvedValue({ released: true }),
  };
  try {
    const { environment } = await registerProjectEnvironment({ repositoryId: state.repository.id, profileId: "laravel-php" });
    await updateProjectEnvironment({ repositoryId: state.repository.id, workloadReleaseId: "134e5321-b4d7-4d4f-be92-ce56a984adaa", workloadIds: [environment.id] });
    await expect(startProjectEnvironment(state.repository.id, runtime as never)).rejects.toThrow("start interrupted");
    expect((await inspectProjectEnvironment(state.repository.id)).environment).toMatchObject({ desiredState: "running", observedState: "error", workloadIds: [environment.id] });
    await startProjectEnvironment(state.repository.id, runtime as never);
    await expect(stopProjectEnvironment(state.repository.id, runtime as never)).rejects.toThrow("stop interrupted");
    expect((await inspectProjectEnvironment(state.repository.id)).environment).toMatchObject({ desiredState: "stopped", observedState: "error", workloadIds: [environment.id] });
    await stopProjectEnvironment(state.repository.id, runtime as never);
    await expect(deprovisionProjectEnvironment(state.repository.id, runtime as never)).rejects.toThrow("remove interrupted");
    expect(runtime.releaseProjectResources).not.toHaveBeenCalled();
    expect((await inspectProjectEnvironment(state.repository.id)).environment).toMatchObject({ desiredState: "deprovisioned", observedState: "error", workloadIds: [environment.id], workloadReleaseId: "134e5321-b4d7-4d4f-be92-ce56a984adaa" });
    const removed = await deprovisionProjectEnvironment(state.repository.id, runtime as never);
    expect(removed.environment).toMatchObject({ desiredState: "deprovisioned", observedState: "deprovisioned", workloadIds: [], workloadReleaseId: null });
    expect(runtime.removeProjectServiceWorkload).toHaveBeenCalledTimes(2);
    expect(runtime.releaseProjectResources).toHaveBeenCalledTimes(1);
  } finally {
    state.repository = previousRepository;
  }
});

it("keeps provisioning blocked while the Laravel profile remains definition-only", async () => {
  const previousRepository = state.repository;
  state.repository = {
    id: "acme-profile-gate-112233445566", fullName: "acme/profile-gate", status: "cloned",
    persistentEnvironmentPaths: [],
  };
  const runtime = { createProjectServiceWorkload: vi.fn() };
  try {
    await registerProjectEnvironment({ repositoryId: state.repository.id, profileId: "laravel-php" });
    await expect(provisionProjectEnvironment(state.repository.id, runtime as never)).rejects.toThrow("definition-only");
    expect(runtime.createProjectServiceWorkload).not.toHaveBeenCalled();
  } finally {
    state.repository = previousRepository;
  }
});

it("persists project-service start, stop and deprovision transitions around runtime actions", async () => {
  const previousRepository = state.repository;
  state.repository = {
    id: "acme-lifecycle-778899aabbcc", fullName: "acme/lifecycle", status: "cloned",
    persistentEnvironmentPaths: [],
  };
  const runtime = {
    ...dependencyRuntimeMocks(),
    startProjectServiceWorkload: vi.fn(async (id: string) => ({ workloadId: id, status: "running", health: { status: "healthy" as const, checkedAt: new Date().toISOString(), checks: ["php-fpm"] } })),
    stopProjectServiceWorkload: vi.fn(async (id: string) => ({ workloadId: id, status: "stopped" })),
    removeProjectServiceWorkload: vi.fn(async (input: { workloadId: string; repositoryId: string; releaseId: string }) => ({ workloadId: input.workloadId, status: "removed" })),
    releaseProjectResources: vi.fn(async (id: string) => ({ repositoryId: id, released: true })),
  };
  try {
    const { environment } = await registerProjectEnvironment({ repositoryId: state.repository.id, profileId: "laravel-php" });
    await updateProjectEnvironment({ repositoryId: state.repository.id, workloadReleaseId: "134e5321-b4d7-4d4f-be92-ce56a984adaa", workloadIds: [environment.id] });
    const started = await startProjectEnvironment(state.repository.id, runtime as never);
    expect(started.environment).toMatchObject({ desiredState: "running", observedState: "running", health: { status: "healthy", checks: ["php-fpm"] } });
    expect(runtime.startProjectServiceWorkload).toHaveBeenCalledWith(environment.id);
    const stopped = await stopProjectEnvironment(state.repository.id, runtime as never);
    expect(stopped.environment).toMatchObject({ desiredState: "stopped", observedState: "stopped" });
    expect(runtime.stopProjectServiceWorkload).toHaveBeenCalledWith(environment.id);
    const removed = await deprovisionProjectEnvironment(state.repository.id, runtime as never);
    expect(removed.environment).toMatchObject({ desiredState: "deprovisioned", observedState: "deprovisioned", workloadIds: [], workloadReleaseId: null });
    expect(runtime.removeProjectServiceWorkload).toHaveBeenCalledWith({ workloadId: environment.id, repositoryId: state.repository.id, releaseId: "134e5321-b4d7-4d4f-be92-ce56a984adaa" });
    expect(runtime.releaseProjectResources).toHaveBeenCalledWith(state.repository.id);
  } finally {
    state.repository = previousRepository;
  }
});


it("selects only existing canonical releases and prevents changing the active release under a workload", async () => {
  const previousRepository = state.repository;
  state.repository = {
    id: "acme-release-select-1234567890", fullName: "acme/release-select", status: "cloned",
    persistentEnvironmentPaths: [],
  };
  try {
    const { environment } = await registerProjectEnvironment({ repositoryId: state.repository.id, profileId: "laravel-php" });
    const releaseId = "134e5321-b4d7-4d4f-be92-ce56a984adaa";
    const nextReleaseId = "234e5321-b4d7-4d4f-be92-ce56a984adaa";
    await expect(setProjectEnvironmentRelease({ repositoryId: state.repository.id, releaseId, channel: "candidate" })).rejects.toThrow("canonical real directory");
    await fs.mkdir(path.join(environment.releasesPath, releaseId), { recursive: true });
    await fs.mkdir(path.join(environment.releasesPath, nextReleaseId), { recursive: true });
    const candidate = await setProjectEnvironmentRelease({ repositoryId: state.repository.id, releaseId, channel: "candidate" });
    expect(candidate.environment.candidateReleaseId).toBe(releaseId);
    const active = await setProjectEnvironmentRelease({ repositoryId: state.repository.id, releaseId, channel: "active" });
    expect(active.environment).toMatchObject({ activeReleaseId: releaseId, candidateReleaseId: null });
    await updateProjectEnvironment({ repositoryId: state.repository.id, workloadReleaseId: releaseId, workloadIds: [environment.id] });
    await expect(setProjectEnvironmentRelease({ repositoryId: state.repository.id, releaseId: nextReleaseId, channel: "active" }))
      .rejects.toThrow("Cannot replace the active release while a project-service workload is registered");
    const staged = await setProjectEnvironmentRelease({ repositoryId: state.repository.id, releaseId: nextReleaseId, channel: "candidate" });
    expect(staged.environment.candidateReleaseId).toBe(nextReleaseId);
  } finally {
    state.repository = previousRepository;
  }
});


it("inspects selected dependencies even when application provisioning has not completed", async () => {
  const previousRepository = state.repository;
  state.repository = { id: "acme-dependency-inspect-1234567890", fullName: "acme/dependency-inspect", status: "cloned", persistentEnvironmentPaths: [] };
  try {
    const result = await registerProjectEnvironment({
      repositoryId: state.repository.id,
      profileId: "laravel-php",
      profileVersion: 4,
      enabledDependencies: ["mysql", "redis"],
    });
    const inspected = await inspectProjectEnvironmentRuntime(state.repository.id, {
      inspectProjectDependencyWorkload: async (workloadId: string) => ({ workloadId, status: "stopped" }),
    } as unknown as Parameters<typeof inspectProjectEnvironmentRuntime>[1]);
    expect(inspected.workload).toBeNull();
    expect(inspected.dependencies).toHaveLength(2);
    expect(inspected.dependencies.map((item) => item.dependency)).toEqual(["mysql", "redis"]);
    expect(inspected.dependencies[0]?.result).toMatchObject({ status: "stopped" });
    expect(result.environment.workloadIds).toEqual([]);
  } finally {
    state.repository = previousRepository;
  }
});

it("creates and restores encrypted backups only for the registered project identity with explicit confirmation", async () => {
  const previousRepository = state.repository;
  state.repository = { id: "acme-backup-lifecycle-123456789", fullName: "acme/backup-lifecycle", status: "cloned", persistentEnvironmentPaths: [] };
  const runtime = {
    ...dependencyRuntimeMocks(),
    createProjectEnvironmentBackup: vi.fn(async (input: { backupId: string }) => ({ backupId: input.backupId, encrypted: true })),
    restoreProjectEnvironmentBackup: vi.fn(async (input: { backupId: string }) => ({ backupId: input.backupId, restored: true, safetyBackupId: "334e5321-b4d7-4d4f-be92-ce56a984adaa" })),
  };
  try {
    const { environment } = await registerProjectEnvironment({ repositoryId: state.repository.id, profileId: "laravel-php", enabledDependencies: ["mysql", "redis"] });
    await updateProjectEnvironment({ repositoryId: state.repository.id, workloadReleaseId: "134e5321-b4d7-4d4f-be92-ce56a984adaa", workloadIds: [environment.id] });
    await expect(backupProjectEnvironment(state.repository.id, runtime as never, false)).rejects.toThrow("confirm=true");
    const backup = await backupProjectEnvironment(state.repository.id, runtime as never, true);
    expect(backup).toMatchObject({ encrypted: true });
    expect(runtime.createProjectEnvironmentBackup).toHaveBeenCalledWith(expect.objectContaining({
      repositoryId: state.repository.id, environmentId: environment.id, applicationWorkloadId: environment.id,
      enabledDependencies: ["mysql", "redis"], backupId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    }));
    await expect(restoreProjectEnvironmentBackup(state.repository.id, "234e5321-b4d7-4d4f-be92-ce56a984adaa", runtime as never, false)).rejects.toThrow("confirm=true");
    const restored = await restoreProjectEnvironmentBackup(state.repository.id, "234e5321-b4d7-4d4f-be92-ce56a984adaa", runtime as never, true);
    expect(restored).toMatchObject({ restored: true });
    expect(runtime.restoreProjectEnvironmentBackup).toHaveBeenCalledWith(expect.objectContaining({
      repositoryId: state.repository.id, environmentId: environment.id, applicationWorkloadId: environment.id,
      backupId: "234e5321-b4d7-4d4f-be92-ce56a984adaa", confirm: true,
    }));
  } finally { state.repository = previousRepository; }
});
