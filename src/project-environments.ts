import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { config } from "./config.js";
import { getManagedRepository, updateRepository, withRepositoryLock } from "./repositories.js";
import { assertServiceProfileDeployable, assertServiceProfileRepositoryAllowed, getServiceProfile, serviceProfileReservationResources } from "./service-profiles.js";
import type { SandboxRuntimeAdapter } from "./sandbox-runtime.js";
import { formatSandboxRuntimeError } from "./sandbox-runtime.js";

const SCHEMA_VERSION = 2;
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
  enabledDependencies: Array<"mysql" | "redis">;
  /** Marks schema-v1 environments whose dependency selection predates managed dependency workloads. */
  legacyDependencySelection?: boolean;
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
function normalizeEnabledDependencies(profile: ReturnType<typeof getServiceProfile>, selected?: readonly string[], allowMissingRequired = false): Array<"mysql" | "redis"> {
  const declared = profile.dependencies.map((dependency) => dependency.name);
  const required = profile.dependencies.filter((dependency) => dependency.required).map((dependency) => dependency.name);
  const requested = selected === undefined ? required : [...selected];
  if (new Set(requested).size !== requested.length || requested.some((name) => !new Set<string>(declared).has(name))) {
    throw new Error("Enabled project dependencies must be unique members of the selected service profile");
  }
  if (!allowMissingRequired && required.some((name) => !requested.includes(name))) throw new Error("All required project dependencies must be enabled");
  return declared.filter((name) => requested.includes(name)) as Array<"mysql" | "redis">;
}

function inferLegacyEnabledDependencies(
  profile: ReturnType<typeof getServiceProfile>,
  resources: ProjectEnvironment["resources"],
): Array<"mysql" | "redis"> {
  const names = profile.dependencies.map((dependency) => dependency.name);
  const matches: Array<Array<"mysql" | "redis">> = [];
  for (let mask = 0; mask < 2 ** names.length; mask += 1) {
    const selected = names.filter((_, index) => (mask & (1 << index)) !== 0) as Array<"mysql" | "redis">;
    const required = serviceProfileReservationResources(profile, selected);
    if (["cpuMilli", "memoryMiB", "pids", "diskMiB"].every((key) => resources[key as keyof typeof resources] === required[key as keyof typeof required])) matches.push(selected);
  }
  return matches.length === 1 ? matches[0]! : [];
}

function validateEnvironment(item: ProjectEnvironment): void {
  assertRepositoryId(item.repositoryId);
  assertProfile(item.profileId, item.profileVersion);
  assertResources(item.resources);
  const profile = getServiceProfile(item.profileId, item.profileVersion);
  if (!Array.isArray(item.enabledDependencies) || JSON.stringify(item.enabledDependencies) !== JSON.stringify(normalizeEnabledDependencies(profile, item.enabledDependencies, item.legacyDependencySelection === true))) {
    throw new Error("Invalid enabled project dependency selection");
  }
  if (item.legacyDependencySelection !== true) {
    const minimumResources = serviceProfileReservationResources(profile, item.enabledDependencies);
    for (const key of ["cpuMilli", "memoryMiB", "pids", "diskMiB"] as const) {
      if (item.resources[key] < minimumResources[key]) throw new Error(`Project environment ${key} reservation is below its enabled dependency requirements`);
    }
  }
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
    if (parsed.schemaVersion !== 1 && parsed.schemaVersion !== SCHEMA_VERSION) throw new Error("Unsupported project environment registry schema");
    const legacySchema = parsed.schemaVersion === 1;
    const ids = new Set<string>();
    const repositoryIds = new Set<string>();
    for (const item of parsed.environments) {
      if (item.workloadReleaseId === undefined && Array.isArray(item.workloadIds) && item.workloadIds.length === 0) item.workloadReleaseId = null;
      if (!Array.isArray(item.enabledDependencies)) {
        if (!legacySchema) throw new Error("Invalid enabled project dependency selection");
        const profile = getServiceProfile(item.profileId, item.profileVersion);
        // Before managed dependency workloads existed, schema-v1 reservations
        // covered only the application. Infer a dependency selection only when
        // the persisted resource vector is an exact match; never silently grow
        // a legacy reservation or assume that a dependency was enabled.
        item.enabledDependencies = inferLegacyEnabledDependencies(profile, item.resources);
        item.legacyDependencySelection = true;
      }
      item.schemaVersion = SCHEMA_VERSION;
      validateEnvironment(item);
      if (ids.has(item.id) || repositoryIds.has(item.repositoryId)) throw new Error("Corrupt project environment registry: duplicate environment identity");
      ids.add(item.id);
      repositoryIds.add(item.repositoryId);
    }
    parsed.schemaVersion = SCHEMA_VERSION;
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
  enabledDependencies?: Array<"mysql" | "redis">;
  resources?: Partial<ProjectEnvironment["resources"]>;
}) {
  assertRepositoryId(input.repositoryId);
  const profileVersion = input.profileVersion ?? 1;
  assertProfile(input.profileId, profileVersion);
  const profile = getServiceProfile(input.profileId, profileVersion);
  const repository = await getManagedRepository(input.repositoryId);
  if (!repository.id || repository.status === "invalid") throw new Error("Repository must be registered and valid before creating a project environment");
  assertServiceProfileRepositoryAllowed(profile, repository.id);
  const canonicalPath = environmentPath(repository.id);
  if (!repository.persistentEnvironmentPaths.includes(canonicalPath)) {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    await updateRepository({ id: repository.id, persistentEnvironmentPaths: [...repository.persistentEnvironmentPaths, canonicalPath] });
  }
  const enabledDependencies = normalizeEnabledDependencies(profile, input.enabledDependencies);
  const profileReservation = serviceProfileReservationResources(profile, enabledDependencies);
  const resources = {
    cpuMilli: input.resources?.cpuMilli ?? profileReservation.cpuMilli,
    memoryMiB: input.resources?.memoryMiB ?? profileReservation.memoryMiB,
    pids: input.resources?.pids ?? profileReservation.pids,
    diskMiB: input.resources?.diskMiB ?? profileReservation.diskMiB,
  };
  assertResources(resources);
  for (const key of ["cpuMilli", "memoryMiB", "pids", "diskMiB"] as const) {
    if (resources[key] < profileReservation[key]) throw new Error(`Project environment ${key} reservation cannot be lower than the aggregate profile requirement`);
  }
  return withRepositoryLock(repository.id, async () => withLock("registry", async () => {
    const registry = await readRegistry();
    const existing = registry.environments.find((item) => item.repositoryId === repository.id);
    if (existing) {
      if (existing.desiredState === "deprovisioned") throw new Error("Deprovisioned environment records cannot be silently reused; explicitly retire the record first");
      const profileChanged = existing.profileId !== input.profileId || existing.profileVersion !== profileVersion;
      const selectedForExisting = input.enabledDependencies === undefined
        ? normalizeEnabledDependencies(profile, existing.enabledDependencies.filter((name) => profile.dependencies.some((dependency) => dependency.name === name)), existing.legacyDependencySelection === true)
        : enabledDependencies;
      if (!profileChanged && JSON.stringify(selectedForExisting) !== JSON.stringify(existing.enabledDependencies)) {
        throw new Error("Enabled project dependencies are immutable after environment registration; deprovision and register a new environment to change them");
      }
      const existingProfileReservation = serviceProfileReservationResources(profile, selectedForExisting);
      const retryableAdmissionFailure = /^Resource reservation failed: SANDBOX_(CAPACITY_EXCEEDED|DISK_PRESSURE)/.test(existing.lastError ?? "");
      const existingResources = input.resources === undefined
        ? retryableAdmissionFailure ? existingProfileReservation : existing.resources
        : {
        cpuMilli: input.resources.cpuMilli ?? existing.resources.cpuMilli,
        memoryMiB: input.resources.memoryMiB ?? existing.resources.memoryMiB,
        pids: input.resources.pids ?? existing.resources.pids,
        diskMiB: input.resources.diskMiB ?? existing.resources.diskMiB,
      };
      assertResources(existingResources);
      for (const key of ["cpuMilli", "memoryMiB", "pids", "diskMiB"] as const) {
        if (existingResources[key] < existingProfileReservation[key]) throw new Error(`Project environment ${key} reservation cannot be lower than the aggregate enabled dependency requirement`);
      }
      if (profileChanged) {
        const completeExplicitResources = input.resources !== undefined
          && ["cpuMilli", "memoryMiB", "pids", "diskMiB"].every((key) => Number.isInteger(input.resources?.[key as keyof typeof input.resources]));
        const explicitIdleProfileUpgrade = existing.profileId === input.profileId && input.profileVersion !== undefined
          && completeExplicitResources && existing.workloadIds.length === 0
          && ["provisioned", "stopped"].includes(existing.desiredState)
          && existing.observedState !== "deprovisioning" && existing.observedState !== "deprovisioned";
        if (!explicitIdleProfileUpgrade) throw new Error("Project environment already exists with a different profile or resource reservation");
        existing.profileVersion = profileVersion;
        existing.enabledDependencies = selectedForExisting;
        existing.resources = existingResources;
        existing.lastError = null;
        existing.updatedAt = new Date().toISOString();
        validateEnvironment(existing);
        await writeRegistry(registry);
        return { created: false, environment: existing, profileUpdated: true, resourcesUpdated: true };
      }
      if (JSON.stringify(existing.resources) !== JSON.stringify(existingResources)) {
        const explicitIdleResize = input.resources !== undefined
          && ["cpuMilli", "memoryMiB", "pids", "diskMiB"].every((key) => Number.isInteger(input.resources?.[key as keyof typeof input.resources]))
          && existing.workloadIds.length === 0 && ["provisioned", "stopped"].includes(existing.desiredState)
          && existing.observedState !== "deprovisioning" && existing.observedState !== "deprovisioned";
        if (!retryableAdmissionFailure && !explicitIdleResize) throw new Error("Project environment already exists with a different profile or resource reservation");
        // A resize is accepted only for an idle environment and only when the
        // operator explicitly supplies the new aggregate vector.
        existing.resources = existingResources;
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
      sourceBranch: "development", profileId: input.profileId, profileVersion, enabledDependencies, rootPath: base,
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
  let approvedRoots: string[];
  if (process.env.VPS_SANDBOX_PROJECT_ENV_ROOTS_JSON) {
    let configured: unknown;
    try { configured = JSON.parse(process.env.VPS_SANDBOX_PROJECT_ENV_ROOTS_JSON); }
    catch { throw new Error("Project environment roots configuration must be valid JSON"); }
    if (!Array.isArray(configured) || configured.length < 1 || configured.length > 8 || configured.some((entry) =>
      !entry || typeof entry !== "object" || Array.isArray(entry) || typeof entry.root !== "string" ||
      !path.isAbsolute(entry.root) || typeof entry.owner !== "string" || !/^[a-z_][a-z0-9_-]{0,31}$/.test(entry.owner)
    )) throw new Error("Project environment roots configuration is invalid");
    approvedRoots = configured.map((entry: { root: string }) => path.resolve(entry.root));
    if (new Set(approvedRoots).size !== approvedRoots.length) throw new Error("Project environment roots must be unique");
  } else {
    approvedRoots = [path.resolve(process.env.VPS_SANDBOX_PROJECT_ENV_ROOT ?? "/var/lib/vps-mcp/project-environments")];
  }
  if (!approvedRoots.includes(path.resolve(root))) {
    throw new Error("MCP project environment root must be listed in VPS_SANDBOX_PROJECT_ENV_ROOTS_JSON shared with the restricted quota broker");
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

function dependencyWorkloadId(environmentId: string, dependency: "mysql" | "redis"): string {
  const hash = createHash("sha256").update(`${environmentId}:${dependency}`).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export async function provisionProjectEnvironment(repositoryId: string, runtime: SandboxRuntimeAdapter) {
  assertRepositoryId(repositoryId);
  return withRepositoryLock(repositoryId, async () => {
    const { environment } = await inspectProjectEnvironment(repositoryId);
    if (environment.desiredState === "deprovisioned") throw new Error("Deprovisioned project environments cannot be provisioned again");
    const profile = getServiceProfile(environment.profileId, environment.profileVersion);
    assertServiceProfileRepositoryAllowed(profile, repositoryId);
    assertServiceProfileDeployable(profile);
    // Legacy records remain inspectable, but cannot bypass required dependencies
    // if a formerly definition-only profile later becomes deployable.
    normalizeEnabledDependencies(profile, environment.enabledDependencies);
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
      const enabledDependencies = profile.dependencies.filter((dependency) => environment.enabledDependencies.includes(dependency.name) && Boolean(dependency.imageDigest));
      await runtime.prepareProjectDependencySecrets({
        repositoryId, environmentId: environment.id,
        mysqlEnabled: enabledDependencies.some((dependency) => dependency.name === "mysql"),
        redisEnabled: enabledDependencies.some((dependency) => dependency.name === "redis"),
      });
      await updateEnvironmentRecord({ repositoryId, observedState: "provisioning", workloadReleaseId: releaseId, workloadIds: [workloadId], lastError: null });
      const result = await runtime.createProjectServiceWorkload({
        workloadId, environmentId: environment.id, profileId: environment.profileId, profileVersion: environment.profileVersion,
        dependencies: enabledDependencies.map((dependency) => ({ name: dependency.name, workloadId: dependencyWorkloadId(environment.id, dependency.name) })),
        repositoryId, releaseId, image: profile.runtime.imageDigest,
        resources: profile.resources,
        reservationResources: environment.resources,
        restartPolicy: profile.restartPolicy,
        command: profile.processes.web.command[0] === "php-fpm" ? profile.processes.web.command.slice(1) : profile.processes.web.command,
      });
      const dependencyWorkloads = [] as Array<{ dependency: "mysql" | "redis"; workload: unknown }>;
      for (const dependency of enabledDependencies) {
        if (!dependency.imageDigest) throw new Error(`Project dependency '${dependency.name}' has no approved immutable image digest`);
        await runtime.pullImage(dependency.imageDigest);
        const dependencyResult = await runtime.createProjectDependencyWorkload({
          workloadId: dependencyWorkloadId(environment.id, dependency.name), environmentId: environment.id,
          repositoryId, dependency: dependency.name, image: dependency.imageDigest,
          resources: dependency.resources, reservationResources: environment.resources,
          restartPolicy: dependency.restartPolicy ?? "no",
          podName: `vps-project-${createHash("sha256").update(repositoryId).digest("hex").slice(0, 20)}`,
        });
        dependencyWorkloads.push({ dependency: dependency.name, workload: dependencyResult.workload });
      }
      if (result.workload.status === "removed") throw new Error("The persistent project-service workload was already removed; deprovision and register a new environment before recreating it");
      const observedState: ProjectEnvironmentObservedState = result.workload.status === "running" ? "running" : result.workload.status === "stopped" ? "stopped" : "provisioned";
      await updateEnvironmentRecord({ repositoryId, observedState, workloadIds: [workloadId], lastError: null, reconciled: true });
      return { environment: (await inspectProjectEnvironment(repositoryId)).environment, workload: result.workload, dependencies: dependencyWorkloads };
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
      const health = typeof result === "object" && result !== null && "health" in result
        ? (result as { health?: ProjectEnvironment["health"] }).health
        : undefined;
      await updateEnvironmentRecord({ repositoryId, observedState: "running", ...(health ? { health } : {}), reconciled: true });
      return { environment: (await inspectProjectEnvironment(repositoryId)).environment, result, dependencies: (result as { dependencies?: unknown[] }).dependencies ?? [] };
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
      const profile = getServiceProfile(environment.profileId, environment.profileVersion);
      const dependencies = [] as Array<{ dependency: "mysql" | "redis"; result: unknown }>;
      for (const dependency of ["redis", "mysql"] as const) {
        if (!environment.enabledDependencies.includes(dependency) || !profile.dependencies.some((item) => item.name === dependency && item.imageDigest)) continue;
        dependencies.push({ dependency, result: await runtime.stopProjectDependencyWorkload(dependencyWorkloadId(environment.id, dependency)) });
      }
      await updateEnvironmentRecord({ repositoryId, observedState: "stopped", reconciled: true });
      return { environment: (await inspectProjectEnvironment(repositoryId)).environment, result, dependencies };
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
      const profile = getServiceProfile(environment.profileId, environment.profileVersion);
      const removedDependencies = [] as Array<{ dependency: "mysql" | "redis"; result: unknown }>;
      for (const dependency of ["redis", "mysql"] as const) {
        if (!environment.enabledDependencies.includes(dependency) || !profile.dependencies.some((item) => item.name === dependency && item.imageDigest)) continue;
        removedDependencies.push({ dependency, result: await runtime.removeProjectDependencyWorkload({
          workloadId: dependencyWorkloadId(environment.id, dependency), repositoryId, dependency,
        }) });
      }
      await runtime.releaseProjectResources(repositoryId);
      await updateEnvironmentRecord({ repositoryId, observedState: "deprovisioned", workloadIds: [], workloadReleaseId: null, reconciled: true, lastError: null });
      return { environment: (await inspectProjectEnvironment(repositoryId)).environment, removedWorkloadId: environment.workloadIds[0] ?? null, removedDependencies };
    } catch (error) {
      await updateEnvironmentRecord({ repositoryId, observedState: "error", lastError: formatSandboxRuntimeError(error).error.message.slice(0, 500) });
      throw error;
    }
  });
}

export async function retireProjectEnvironment(repositoryId: string, runtime: SandboxRuntimeAdapter, confirm: boolean) {
  if (!confirm) throw new Error("Retiring a project environment requires confirm=true because it permanently deletes releases, database, storage, backups and generated credentials");
  assertRepositoryId(repositoryId);
  return withRepositoryLock(repositoryId, async () => {
    const { environment } = await inspectProjectEnvironment(repositoryId);
    if (environment.desiredState !== "deprovisioned" || environment.observedState !== "deprovisioned"
      || environment.workloadIds.length > 0 || environment.workloadReleaseId !== null || environment.lastError !== null) {
      throw new Error("Project environment must be successfully deprovisioned before it can be retired");
    }
    await runtime.releaseProjectResources(repositoryId);
    const expectedRoot = environmentPath(repositoryId);
    const rootStat = await fs.lstat(expectedRoot).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (rootStat?.isSymbolicLink() || (rootStat && !(await fs.realpath(expectedRoot) === expectedRoot))) {
      throw new Error("Project environment root is not a canonical directory; refusing retirement");
    }
    if (rootStat) await fs.rm(expectedRoot, { recursive: true, force: true });

    const repository = await getManagedRepository(repositoryId);
    const persistentEnvironmentPaths = repository.persistentEnvironmentPaths.filter((item) => path.resolve(item) !== expectedRoot);
    await updateRepository({ id: repository.id, persistentEnvironmentPaths });
    await withLock("registry", async () => {
      const registry = await readRegistry();
      const current = registry.environments.find((item) => item.repositoryId === repositoryId);
      if (!current || current.id !== environment.id || current.desiredState !== "deprovisioned" || current.workloadIds.length > 0) {
        throw new Error("Project environment changed during retirement; operator review required");
      }
      registry.environments = registry.environments.filter((item) => item.repositoryId !== repositoryId);
      await writeRegistry(registry);
    });
    return { retired: true, repositoryId, environmentId: environment.id, deletedPath: expectedRoot };
  });
}

export async function inspectProjectEnvironmentRuntime(repositoryId: string, runtime: SandboxRuntimeAdapter) {
  assertRepositoryId(repositoryId);
  const { environment } = await inspectProjectEnvironment(repositoryId);
  const profile = getServiceProfile(environment.profileId, environment.profileVersion);
  const dependencies = [] as Array<{ dependency: "mysql" | "redis"; result: unknown }>;
  for (const dependency of profile.dependencies.filter((item) => environment.enabledDependencies.includes(item.name) && Boolean(item.imageDigest))) {
    try {
      dependencies.push({ dependency: dependency.name, result: await runtime.inspectProjectDependencyWorkload(dependencyWorkloadId(environment.id, dependency.name)) });
    } catch (error) {
      dependencies.push({ dependency: dependency.name, result: { error: formatSandboxRuntimeError(error).error.message } });
    }
  }
  const workloadId = environment.workloadIds[0];
  if (!workloadId) return { environment, workload: null, runtime: null, dependencies };
  try {
    const result = await runtime.inspectProjectServiceWorkload(workloadId);
    if (result.health) {
      const updated = await updateEnvironmentRecord({ repositoryId, health: result.health });
      return { environment: updated.environment, ...result, dependencies };
    }
    return { environment, ...result, dependencies };
  } catch (error) {
    return { environment, workload: null, runtime: null, workloadError: formatSandboxRuntimeError(error).error.message, dependencies };
  }
}


export async function backupProjectEnvironment(repositoryId: string, runtime: SandboxRuntimeAdapter, confirm: boolean) {
  if (!confirm) throw new Error("Project backup requires confirm=true because the application is briefly stopped for a consistent storage snapshot");
  const { environment } = await inspectProjectEnvironment(repositoryId);
  if (environment.desiredState === "deprovisioned" || environment.workloadIds.length === 0) throw new Error("Cannot back up a deprovisioned project environment");
  if (!environment.enabledDependencies.includes("mysql")) throw new Error("Encrypted database backups require the MySQL dependency to be enabled");
  const applicationWorkloadId = environment.workloadIds[0];
  if (!applicationWorkloadId) throw new Error("Project environment has no registered application workload");
  return runtime.createProjectEnvironmentBackup({
    repositoryId, environmentId: environment.id, profileId: environment.profileId,
    profileVersion: environment.profileVersion, applicationWorkloadId,
    enabledDependencies: environment.enabledDependencies, backupId: randomUUID(),
  });
}

export async function restoreProjectEnvironmentBackup(repositoryId: string, backupId: string, runtime: SandboxRuntimeAdapter, confirm: boolean) {
  if (!confirm) throw new Error("Project backup restore requires confirm=true because it replaces database and storage contents");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(backupId)) throw new Error("Invalid project backup ID");
  const { environment } = await inspectProjectEnvironment(repositoryId);
  if (environment.desiredState === "deprovisioned" || environment.workloadIds.length === 0) throw new Error("Cannot restore a deprovisioned project environment");
  if (!environment.enabledDependencies.includes("mysql")) throw new Error("Project restore requires the MySQL dependency to be enabled");
  const applicationWorkloadId = environment.workloadIds[0];
  if (!applicationWorkloadId) throw new Error("Project environment has no registered application workload");
  return runtime.restoreProjectEnvironmentBackup({
    repositoryId, environmentId: environment.id, profileId: environment.profileId,
    profileVersion: environment.profileVersion, applicationWorkloadId,
    enabledDependencies: environment.enabledDependencies, backupId, confirm: true,
  });
}
