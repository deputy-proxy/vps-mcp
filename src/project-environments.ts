import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { getManagedRepository, updateRepository, withRepositoryLock } from "./repositories.js";
import { getServiceProfile } from "./service-profiles.js";

const SCHEMA_VERSION = 1;
const REPOSITORY_ID = /^[a-z0-9][a-z0-9._-]{1,199}$/i;
const PROFILE_ID = /^[a-z][a-z0-9-]{1,63}$/;
const STATES = ["provisioned", "running", "stopped", "deprovisioned"] as const;
const OBSERVED_STATES = ["provisioned", "starting", "running", "stopping", "stopped", "degraded", "unknown", "error", "deprovisioned"] as const;
const DESIRED_TRANSITIONS: Record<ProjectEnvironmentDesiredState, ProjectEnvironmentDesiredState[]> = {
  provisioned: ["provisioned", "running", "stopped", "deprovisioned"],
  running: ["running", "stopped", "deprovisioned"],
  stopped: ["stopped", "running", "deprovisioned"],
  deprovisioned: ["deprovisioned"],
};
export type ProjectEnvironmentDesiredState = typeof STATES[number];
export type ProjectEnvironmentObservedState = "provisioned" | "starting" | "running" | "stopping" | "stopped" | "degraded" | "unknown" | "error" | "deprovisioned";

export type ProjectEnvironment = {
  schemaVersion: number;
  id: string;
  repositoryId: string;
  repositoryFullName: string;
  sourceBranch: "development";
  profileId: string;
  profileVersion: number;
  rootPath: string;
  releasesPath: string;
  dataPath: string;
  databasePath: string;
  storagePath: string;
  cachePath: string;
  logsPath: string;
  backupsPath: string;
  desiredState: ProjectEnvironmentDesiredState;
  observedState: ProjectEnvironmentObservedState;
  activeReleaseId: string | null;
  candidateReleaseId: string | null;
  workloadIds: string[];
  resources: { cpuMilli: number; memoryMiB: number; pids: number; diskMiB: number };
  health: { status: "unknown" | "healthy" | "unhealthy"; checkedAt: string | null; checks: string[] };
  createdAt: string;
  updatedAt: string;
  lastReconciledAt: string | null;
  lastError: string | null;
};

type Registry = { schemaVersion: number; environments: ProjectEnvironment[] };

const root = path.join(config.dataDir, "project-environments");
const registryFile = path.join(root, "registry.json");
const lockRoot = path.join(root, ".locks");
const LOCK_TIMEOUT_MS = 10_000;
const STALE_LOCK_MS = 5 * 60_000;

function assertRepositoryId(value: string): void {
  if (!REPOSITORY_ID.test(value)) throw new Error("Invalid repository ID");
}
function assertProfile(profileId: string, profileVersion: number): void {
  if (!PROFILE_ID.test(profileId)) throw new Error("Invalid project environment profile ID");
  if (!Number.isSafeInteger(profileVersion) || profileVersion < 1) throw new Error("Profile version must be a positive integer");
}
function assertResources(resources: ProjectEnvironment["resources"]): void {
  if (!Number.isInteger(resources.cpuMilli) || resources.cpuMilli < 100 || resources.cpuMilli > 2000) throw new Error("cpuMilli must be between 100 and 2000");
  if (!Number.isInteger(resources.memoryMiB) || resources.memoryMiB < 128 || resources.memoryMiB > 4096) throw new Error("memoryMiB must be between 128 and 4096");
  if (!Number.isInteger(resources.pids) || resources.pids < 32 || resources.pids > 512) throw new Error("pids must be between 32 and 512");
  if (!Number.isInteger(resources.diskMiB) || resources.diskMiB < 128 || resources.diskMiB > 102400) throw new Error("diskMiB must be between 128 and 102400");
}
function environmentPath(repositoryId: string): string {
  assertRepositoryId(repositoryId);
  return path.join(root, repositoryId);
}
function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
function validateEnvironment(item: ProjectEnvironment): void {
  assertRepositoryId(item.repositoryId);
  assertProfile(item.profileId, item.profileVersion);
  assertResources(item.resources);
  if (item.sourceBranch !== "development") throw new Error("Project environments may only track the development branch");
  if (!STATES.includes(item.desiredState)) throw new Error("Invalid desired project environment state");
  if (!OBSERVED_STATES.includes(item.observedState)) throw new Error("Invalid observed project environment state");
  if (typeof item.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(item.id)) throw new Error("Invalid project environment ID");
  if (!item.health || !["unknown", "healthy", "unhealthy"].includes(item.health.status) || !Array.isArray(item.health.checks)) throw new Error("Invalid project environment health record");
  const expectedRoot = environmentPath(item.repositoryId);
  if (path.resolve(item.rootPath) !== expectedRoot) throw new Error("Project environment root does not match its repository identity");
  for (const [key, directory] of Object.entries({
    releasesPath: item.releasesPath, dataPath: item.dataPath, databasePath: item.databasePath,
    storagePath: item.storagePath, cachePath: item.cachePath, logsPath: item.logsPath, backupsPath: item.backupsPath,
  })) {
    if (path.resolve(directory) !== path.join(expectedRoot, key === "releasesPath" ? "releases" : key === "dataPath" ? "data" : key === "databasePath" ? "database" : key === "storagePath" ? "storage" : key === "cachePath" ? "cache" : key === "logsPath" ? "logs" : "backups")) {
      throw new Error(`Project environment ${key} is not canonical`);
    }
  }
  if (!Array.isArray(item.workloadIds) || item.workloadIds.some((id) => typeof id !== "string" || id.length > 128)) throw new Error("Invalid project environment workload IDs");
}
async function withLock<T>(repositoryId: string, operation: () => Promise<T>): Promise<T> {
  await fs.mkdir(lockRoot, { recursive: true, mode: 0o700 });
  const lock = path.join(lockRoot, `${repositoryId}.lock`);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    try {
      await fs.mkdir(lock, { mode: 0o700 });
      await fs.writeFile(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid, createdAt: Date.now() }), { mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const stat = await fs.stat(lock);
        if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) { await fs.rm(lock, { recursive: true, force: true }); continue; }
      } catch { continue; }
      if (Date.now() >= deadline) throw new Error("Project environment is busy; retry the operation");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  try { return await operation(); } finally { await fs.rm(lock, { recursive: true, force: true }); }
}
async function readRegistry(): Promise<Registry> {
  try {
    const parsed = JSON.parse(await fs.readFile(registryFile, "utf8")) as Partial<Registry>;
    if (!Array.isArray(parsed.environments)) throw new Error("Corrupt project environment registry");
    if (parsed.schemaVersion !== SCHEMA_VERSION) throw new Error("Unsupported project environment registry schema");
    const ids = new Set<string>();
    const repositoryIds = new Set<string>();
    for (const item of parsed.environments) {
      validateEnvironment(item);
      if (ids.has(item.id) || repositoryIds.has(item.repositoryId)) throw new Error("Corrupt project environment registry: duplicate environment identity");
      ids.add(item.id);
      repositoryIds.add(item.repositoryId);
    }
    return parsed as Registry;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: SCHEMA_VERSION, environments: [] };
    throw error;
  }
}
async function writeRegistry(registry: Registry): Promise<void> {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const temporary = `${registryFile}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(registry, null, 2) + "\n", "utf8");
    await handle.sync();
  } finally { await handle.close(); }
  await fs.rename(temporary, registryFile);
  await fs.chmod(registryFile, 0o600);
}

export async function listProjectEnvironments(input: { repositoryId?: string } = {}) {
  const registry = await readRegistry();
  const environments = input.repositoryId
    ? registry.environments.filter((item) => item.repositoryId === input.repositoryId)
    : registry.environments;
  return { schemaVersion: registry.schemaVersion, count: environments.length, environments };
}

export async function inspectProjectEnvironment(repositoryId: string) {
  assertRepositoryId(repositoryId);
  const environment = (await readRegistry()).environments.find((item) => item.repositoryId === repositoryId);
  if (!environment) throw new Error(`Project environment for repository '${repositoryId}' is not registered`);
  return { environment };
}

export async function registerProjectEnvironment(input: {
  repositoryId: string;
  profileId: string;
  profileVersion?: number;
  resources?: Partial<ProjectEnvironment["resources"]>;
}) {
  assertRepositoryId(input.repositoryId);
  const profileVersion = input.profileVersion ?? 1;
  assertProfile(input.profileId, profileVersion);
  const profile = getServiceProfile(input.profileId, profileVersion);
  const repository = await getManagedRepository(input.repositoryId);
  if (!repository.id || repository.status === "invalid") throw new Error("Repository must be registered and valid before creating a project environment");
  const canonicalPath = environmentPath(repository.id);
  if (!repository.persistentEnvironmentPaths.includes(canonicalPath)) {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    await updateRepository({ id: repository.id, persistentEnvironmentPaths: [...repository.persistentEnvironmentPaths, canonicalPath] });
  }
  const resources = {
    cpuMilli: input.resources?.cpuMilli ?? profile.resources.cpuMilli,
    memoryMiB: input.resources?.memoryMiB ?? profile.resources.memoryMiB,
    pids: input.resources?.pids ?? profile.resources.pids,
    diskMiB: input.resources?.diskMiB ?? profile.resources.diskMiB,
  };
  assertResources(resources);
  return withRepositoryLock(repository.id, async () => withLock("registry", async () => {
    const registry = await readRegistry();
    const existing = registry.environments.find((item) => item.repositoryId === repository.id);
    if (existing) {
      if (existing.desiredState === "deprovisioned") throw new Error("Deprovisioned environment records cannot be silently reused; explicitly retire the record first");
      if (existing.profileId !== input.profileId || existing.profileVersion !== profileVersion) {
        throw new Error("Project environment already exists with a different profile or resource reservation");
      }
      if (JSON.stringify(existing.resources) !== JSON.stringify(resources)) {
        const retryableAdmissionFailure = /^Resource reservation failed: SANDBOX_(CAPACITY_EXCEEDED|DISK_PRESSURE)/.test(existing.lastError ?? "");
        if (!retryableAdmissionFailure) throw new Error("Project environment already exists with a different profile or resource reservation");
        // A failed capacity admission has no matching reservation. Permit the
        // operator to adjust the plan and retry; runtime admission remains the
        // authority and will reject unsafe changes if a project workload exists.
        existing.resources = resources;
        existing.lastError = null;
        existing.updatedAt = new Date().toISOString();
        validateEnvironment(existing);
        await writeRegistry(registry);
        return { created: false, environment: existing, resourcesUpdated: true };
      }
      return { created: false, environment: existing };
    }
    const base = environmentPath(repository.id);
    const now = new Date().toISOString();
    const environment: ProjectEnvironment = {
      schemaVersion: SCHEMA_VERSION, id: randomUUID(), repositoryId: repository.id, repositoryFullName: repository.fullName,
      sourceBranch: "development", profileId: input.profileId, profileVersion, rootPath: base,
      releasesPath: path.join(base, "releases"), dataPath: path.join(base, "data"),
      databasePath: path.join(base, "database"), storagePath: path.join(base, "storage"),
      cachePath: path.join(base, "cache"), logsPath: path.join(base, "logs"), backupsPath: path.join(base, "backups"),
      desiredState: "provisioned", observedState: "provisioned", activeReleaseId: null, candidateReleaseId: null,
      workloadIds: [], resources, health: { status: "unknown", checkedAt: null, checks: [] },
      createdAt: now, updatedAt: now, lastReconciledAt: null, lastError: null,
    };
    validateEnvironment(environment);
    registry.environments.push(environment);
    await writeRegistry(registry);
    return { created: true, environment };
  }));
}

export async function updateProjectEnvironment(input: {
  repositoryId: string;
  desiredState?: ProjectEnvironmentDesiredState;
  observedState?: ProjectEnvironmentObservedState;
  activeReleaseId?: string | null;
  candidateReleaseId?: string | null;
  workloadIds?: string[];
  health?: ProjectEnvironment["health"];
  lastError?: string | null;
  reconciled?: boolean;
}) {
  assertRepositoryId(input.repositoryId);
  return withRepositoryLock(input.repositoryId, async () => withLock("registry", async () => {
    const registry = await readRegistry();
    const environment = registry.environments.find((item) => item.repositoryId === input.repositoryId);
    if (!environment) throw new Error(`Project environment for repository '${input.repositoryId}' is not registered`);
    if (input.desiredState !== undefined) {
      if (!STATES.includes(input.desiredState)) throw new Error("Invalid desired project environment state");
      if (!DESIRED_TRANSITIONS[environment.desiredState].includes(input.desiredState)) {
        throw new Error(`Invalid project environment state transition: ${environment.desiredState} -> ${input.desiredState}`);
      }
      environment.desiredState = input.desiredState;
    }
    if (input.observedState !== undefined) {
      if (!OBSERVED_STATES.includes(input.observedState)) throw new Error("Invalid observed project environment state");
      environment.observedState = input.observedState;
    }
    if (input.activeReleaseId !== undefined) environment.activeReleaseId = input.activeReleaseId;
    if (input.candidateReleaseId !== undefined) environment.candidateReleaseId = input.candidateReleaseId;
    if (input.workloadIds !== undefined) environment.workloadIds = [...new Set(input.workloadIds)];
    if (input.health !== undefined) environment.health = input.health;
    if (input.lastError !== undefined) environment.lastError = input.lastError;
    if (input.reconciled) environment.lastReconciledAt = new Date().toISOString();
    environment.updatedAt = new Date().toISOString();
    validateEnvironment(environment);
    await writeRegistry(registry);
    return { environment };
  }));
}
