import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { getManagedRepository, updateRepository, withRepositoryLock } from "./repositories.js";
import { assertServiceProfileDeployable, getServiceProfile } from "./service-profiles.js";
import type { SandboxRuntimeAdapter } from "./sandbox-runtime.js";
import { formatSandboxRuntimeError } from "./sandbox-runtime.js";

const SCHEMA_VERSION = 1;
const REPOSITORY_ID = /^[a-z0-9][a-z0-9._-]{1,199}$/i;
const PROFILE_ID = /^[a-z][a-z0-9-]{1,63}$/;
const STATES = ["provisioned", "running", "stopped", "deprovisioned"] as const;
const OBSERVED_STATES = ["provisioned", "provisioning", "starting", "running", "stopping", "stopped", "deprovisioning", "degraded", "unknown", "error", "deprovisioned"] as const;
const DESIRED_TRANSITIONS: Record<ProjectEnvironmentDesiredState, ProjectEnvironmentDesiredState[]> = {
  provisioned: ["provisioned", "running", "stopped", "deprovisioned"],
  running: ["running", "stopped", "deprovisioned"],
  stopped: ["stopped", "running", "deprovisioned"],
  deprovisioned: ["deprovisioned"],
};
export type ProjectEnvironmentDesiredState = typeof STATES[number];
export type ProjectEnvironmentObservedState = "provisioned" | "provisioning" | "starting" | "running" | "stopping" | "stopped" | "deprovisioning" | "degraded" | "unknown" | "error" | "deprovisioned";

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
  workloadReleaseId: string | null;
  workloadIds: string[];
  resources: { cpuMilli: number; memoryMiB: number; pids: number; diskMiB: number };
  health: { status: "unknown" | "healthy" | "unhealthy"; checkedAt: string | null; checks: string[] };
  createdAt: string;
  updatedAt: string;
  lastReconciledAt: string | null;
  lastError: string | null;
};

type Registry = { schemaVersion: number; environments: ProjectEnvironment[] };

const root = path.resolve(process.env.VPS_SANDBOX_PROJECT_ENV_ROOT ?? path.join(config.dataDir, "project-environments"));
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
  const releaseIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (item.activeReleaseId !== null && !releaseIdPattern.test(item.activeReleaseId)) throw new Error("Invalid active project release ID");
  if (item.candidateReleaseId !== null && !releaseIdPattern.test(item.candidateReleaseId)) throw new Error("Invalid candidate project release ID");
  if (!Array.isArray(item.workloadIds) || item.workloadIds.some((id) => typeof id !== "string" || !releaseIdPattern.test(id))) throw new Error("Invalid project environment workload IDs");
  if (item.workloadReleaseId !== null && !releaseIdPattern.test(item.workloadReleaseId)) throw new Error("Invalid project workload release ID");
  if (item.workloadIds.length > 0 && item.workloadReleaseId === null) throw new Error("Project workload release identity is required when a workload is registered");
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
      if (item.workloadReleaseId === undefined && Array.isArray(item.workloadIds) && item.workloadIds.length === 0) {
        item.workloadReleaseId = null;
      }
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
      workloadReleaseId: null, workloadIds: [], resources, health: { status: "unknown", checkedAt: null, checks: [] },
      createdAt: now, updatedAt: now, lastReconciledAt: null, lastError: null,
    };
    validateEnvironment(environment);
    registry.environments.push(environment);
    await writeRegistry(registry);
    return { created: true, environment };
  }));
}

async function updateEnvironmentRecord(input: {
  repositoryId: string;
  desiredState?: ProjectEnvironmentDesiredState;
  observedState?: ProjectEnvironmentObservedState;
  activeReleaseId?: string | null;
  candidateReleaseId?: string | null;
  workloadReleaseId?: string | null;
  workloadIds?: string[];
  health?: ProjectEnvironment["health"];
  lastError?: string | null;
  reconciled?: boolean;
}) {
  return withLock("registry", async () => {
    const registry = await readRegistry();
    const environment = registry.environments.find((item) => item.repositoryId === input.repositoryId);
    if (!environment) throw new Error("Project environment for repository '" + input.repositoryId + "' is not registered");
    if (input.desiredState !== undefined) {
      if (!STATES.includes(input.desiredState)) throw new Error("Invalid desired project environment state");
      if (!DESIRED_TRANSITIONS[environment.desiredState].includes(input.desiredState)) {
        throw new Error("Invalid project environment state transition: " + environment.desiredState + " -> " + input.desiredState);
      }
      environment.desiredState = input.desiredState;
    }
    if (input.observedState !== undefined) {
      if (!OBSERVED_STATES.includes(input.observedState)) throw new Error("Invalid observed project environment state");
      environment.observedState = input.observedState;
    }
    if (input.activeReleaseId !== undefined) environment.activeReleaseId = input.activeReleaseId;
    if (input.candidateReleaseId !== undefined) environment.candidateReleaseId = input.candidateReleaseId;
    if (input.workloadReleaseId !== undefined) environment.workloadReleaseId = input.workloadReleaseId;
    if (input.workloadIds !== undefined) environment.workloadIds = [...new Set(input.workloadIds)];
    if (input.health !== undefined) environment.health = input.health;
    if (input.lastError !== undefined) environment.lastError = input.lastError;
    if (input.reconciled) environment.lastReconciledAt = new Date().toISOString();
    environment.updatedAt = new Date().toISOString();
    validateEnvironment(environment);
    await writeRegistry(registry);
    return { environment };
  });
}
async function canonicalDirectory(directory: string, label: string): Promise<void> {
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try { stat = await fs.lstat(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(label + " must exist as a canonical real directory");
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(directory) !== path.resolve(directory)) {
    throw new Error(label + " must be a canonical real directory");
  }
}
export async function prepareProjectEnvironmentMountAccess(repositoryId: string, releaseId: string): Promise<void> {
  assertRepositoryId(repositoryId);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(releaseId)) {
    throw new Error("Invalid project release ID");
  }
  const { environment } = await inspectProjectEnvironment(repositoryId);
  if (environment.activeReleaseId !== releaseId && environment.candidateReleaseId !== releaseId) {
    throw new Error("Project release is neither the active nor the approved candidate release");
  }
  const runtimeProjectRoot = path.resolve(process.env.VPS_SANDBOX_PROJECT_ENV_ROOT ?? "/var/lib/vps-mcp/project-environments");
  if (path.resolve(root) !== runtimeProjectRoot) {
    throw new Error("MCP project environment root must match VPS_SANDBOX_PROJECT_ENV_ROOT in the restricted quota broker configuration");
  }
  await canonicalDirectory(config.dataDir, "MCP data directory");
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await canonicalDirectory(root, "Project environment registry root");
  await fs.mkdir(environment.rootPath, { recursive: true, mode: 0o700 });
  await canonicalDirectory(environment.rootPath, "Project environment root");
  for (const directory of [environment.releasesPath, environment.storagePath, environment.cachePath, environment.logsPath]) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await canonicalDirectory(directory, "Project environment mount source");
  }
  for (const directory of [
    path.join(environment.storagePath, "app"),
    path.join(environment.storagePath, "framework", "cache"),
    path.join(environment.storagePath, "framework", "sessions"),
    path.join(environment.storagePath, "framework", "views"),
  ]) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const releasePath = path.join(environment.releasesPath, releaseId);
  await canonicalDirectory(releasePath, "Project release");
}

export async function setProjectEnvironmentRelease(input: {
  repositoryId: string;
  releaseId: string;
  channel: "active" | "candidate";
}) {
  assertRepositoryId(input.repositoryId);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.releaseId)) {
    throw new Error("Invalid project release ID");
  }
  const releaseId = input.releaseId.toLowerCase();
  if (input.channel !== "active" && input.channel !== "candidate") throw new Error("Invalid project release channel");
  return withRepositoryLock(input.repositoryId, async () => {
    const { environment } = await inspectProjectEnvironment(input.repositoryId);
    if (environment.desiredState === "deprovisioned") throw new Error("Deprovisioned project environments cannot accept releases");
    await canonicalDirectory(environment.releasesPath, "Project releases directory");
    await canonicalDirectory(path.join(environment.releasesPath, releaseId), "Project release");
    if (input.channel === "active" && environment.workloadIds.length > 0 && environment.workloadReleaseId !== releaseId) {
      throw new Error("Cannot replace the active release while a project-service workload is registered");
    }
    const updated = input.channel === "active"
      ? await updateEnvironmentRecord({ repositoryId: input.repositoryId, activeReleaseId: releaseId, candidateReleaseId: null })
      : await updateEnvironmentRecord({ repositoryId: input.repositoryId, candidateReleaseId: releaseId });
    return { environment: updated.environment, channel: input.channel };
  });
}

export async function updateProjectEnvironment(input: {
  repositoryId: string;
  desiredState?: ProjectEnvironmentDesiredState;
  observedState?: ProjectEnvironmentObservedState;
  activeReleaseId?: string | null;
  candidateReleaseId?: string | null;
  workloadReleaseId?: string | null;
  workloadIds?: string[];
  health?: ProjectEnvironment["health"];
  lastError?: string | null;
  reconciled?: boolean;
}) {
  assertRepositoryId(input.repositoryId);
  return withRepositoryLock(input.repositoryId, async () => updateEnvironmentRecord(input));
}

export async function provisionProjectEnvironment(repositoryId: string, runtime: SandboxRuntimeAdapter) {
  assertRepositoryId(repositoryId);
  return withRepositoryLock(repositoryId, async () => {
    const { environment } = await inspectProjectEnvironment(repositoryId);
    if (environment.desiredState === "deprovisioned") throw new Error("Deprovisioned project environments cannot be provisioned again");
    const profile = getServiceProfile(environment.profileId, environment.profileVersion);
    assertServiceProfileDeployable(profile);
    if (!profile.runtime.imageDigest) throw new Error("Project service profile has no approved immutable image reference");
    const releaseId = environment.candidateReleaseId ?? environment.activeReleaseId;
    if (!releaseId) throw new Error("Project environment has no active or candidate release to mount");
    if (environment.workloadIds.length > 0 && environment.workloadReleaseId !== releaseId) {
      throw new Error("A project-service workload is already bound to a different release; deprovision it before provisioning another release");
    }
    const workloadId = environment.id;
    if (environment.desiredState === "running" && environment.workloadIds.length === 0) {
      throw new Error("Provision the project service before requesting its running state");
    }
    try {
      await prepareProjectEnvironmentMountAccess(repositoryId, releaseId);
    } catch (error) {
      await updateEnvironmentRecord({ repositoryId, observedState: "error", lastError: formatSandboxRuntimeError(error).error.message.slice(0, 500) });
      throw error;
    }
    await updateEnvironmentRecord({ repositoryId, observedState: "provisioning", lastError: null });
    try {
      await runtime.pullImage(profile.runtime.imageDigest);
      await updateEnvironmentRecord({ repositoryId, observedState: "provisioning", workloadReleaseId: releaseId, workloadIds: [workloadId], lastError: null });
      const result = await runtime.createProjectServiceWorkload({
        workloadId, repositoryId, releaseId, image: profile.runtime.imageDigest,
        resources: environment.resources,
        restartPolicy: profile.restartPolicy,
        command: profile.processes.web.command[0] === "php-fpm" ? profile.processes.web.command.slice(1) : profile.processes.web.command,
      });
      if (result.workload.status === "removed") throw new Error("The persistent project-service workload was already removed; deprovision and register a new environment before recreating it");
      const observedState: ProjectEnvironmentObservedState = result.workload.status === "running" ? "running" : result.workload.status === "stopped" ? "stopped" : "provisioned";
      await updateEnvironmentRecord({ repositoryId, observedState, workloadIds: [workloadId], lastError: null, reconciled: true });
      return { environment: (await inspectProjectEnvironment(repositoryId)).environment, workload: result.workload };
    } catch (error) {
      const message = formatSandboxRuntimeError(error).error.message.slice(0, 500);
      await updateEnvironmentRecord({ repositoryId, observedState: "error", lastError: message });
      throw error;
    }
  });
}

export async function startProjectEnvironment(repositoryId: string, runtime: SandboxRuntimeAdapter) {
  assertRepositoryId(repositoryId);
  return withRepositoryLock(repositoryId, async () => {
    const { environment } = await inspectProjectEnvironment(repositoryId);
    const workloadId = environment.workloadIds[0];
    if (!workloadId) throw new Error("Project environment has not been provisioned");
    if (environment.desiredState === "deprovisioned") throw new Error("Deprovisioned project environments cannot be started");
    await updateEnvironmentRecord({ repositoryId, desiredState: "running", observedState: "starting", lastError: null });
    try {
      const result = await runtime.startProjectServiceWorkload(workloadId);
      await updateEnvironmentRecord({ repositoryId, observedState: "running", reconciled: true });
      return { environment: (await inspectProjectEnvironment(repositoryId)).environment, result };
    } catch (error) {
      await updateEnvironmentRecord({ repositoryId, observedState: "error", lastError: formatSandboxRuntimeError(error).error.message.slice(0, 500) });
      throw error;
    }
  });
}

export async function stopProjectEnvironment(repositoryId: string, runtime: SandboxRuntimeAdapter) {
  assertRepositoryId(repositoryId);
  return withRepositoryLock(repositoryId, async () => {
    const { environment } = await inspectProjectEnvironment(repositoryId);
    if (environment.desiredState === "deprovisioned") throw new Error("Deprovisioned project environments cannot be stopped");
    const workloadId = environment.workloadIds[0];
    if (!workloadId) throw new Error("Project environment has not been provisioned");
    await updateEnvironmentRecord({ repositoryId, desiredState: "stopped", observedState: "stopping", lastError: null });
    try {
      const result = await runtime.stopProjectServiceWorkload(workloadId);
      await updateEnvironmentRecord({ repositoryId, observedState: "stopped", reconciled: true });
      return { environment: (await inspectProjectEnvironment(repositoryId)).environment, result };
    } catch (error) {
      await updateEnvironmentRecord({ repositoryId, observedState: "error", lastError: formatSandboxRuntimeError(error).error.message.slice(0, 500) });
      throw error;
    }
  });
}

export async function deprovisionProjectEnvironment(repositoryId: string, runtime: SandboxRuntimeAdapter) {
  assertRepositoryId(repositoryId);
  return withRepositoryLock(repositoryId, async () => {
    const { environment } = await inspectProjectEnvironment(repositoryId);
    const workloadId = environment.workloadIds[0] ?? environment.id;
    await updateEnvironmentRecord({ repositoryId, desiredState: "deprovisioned", observedState: "deprovisioning", lastError: null });
    try {
      if (environment.workloadIds.length > 0) {
        if (!environment.workloadReleaseId) throw new Error("Cannot deprovision a workload without its persisted release identity");
        await runtime.removeProjectServiceWorkload({ workloadId, repositoryId, releaseId: environment.workloadReleaseId });
      }
      await runtime.releaseProjectResources(repositoryId);
      await updateEnvironmentRecord({ repositoryId, observedState: "deprovisioned", workloadIds: [], workloadReleaseId: null, reconciled: true, lastError: null });
      return { environment: (await inspectProjectEnvironment(repositoryId)).environment, removedWorkloadId: environment.workloadIds[0] ?? null };
    } catch (error) {
      await updateEnvironmentRecord({ repositoryId, observedState: "error", lastError: formatSandboxRuntimeError(error).error.message.slice(0, 500) });
      throw error;
    }
  });
}

export async function inspectProjectEnvironmentRuntime(repositoryId: string, runtime: SandboxRuntimeAdapter) {
  assertRepositoryId(repositoryId);
  const { environment } = await inspectProjectEnvironment(repositoryId);
  const workloadId = environment.workloadIds[0];
  if (!workloadId) return { environment, workload: null, runtime: null };
  const result = await runtime.inspectProjectServiceWorkload(workloadId);
  return { environment, ...result };
}
