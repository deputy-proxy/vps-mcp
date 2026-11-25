import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { lstatSync } from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { config } from "./config.js";
import { resolveAllowedPath } from "./paths.js";
import { applyBranchPolicy, inspectBranchPolicy, REQUIRED_BRANCHES } from "./branch-policy.js";

const SCHEMA_VERSION = 2;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const LOCK_TIMEOUT_MS = 10_000;
const STALE_LOCK_MS = 5 * 60_000;

type RepositoryStatus = "registered" | "cloned" | "unreachable" | "invalid";
export type ManagedRepository = {
  id: string;
  fullName: string;
  remoteUrl: string;
  name: string;
  developmentHostname: string;
  cachePath: string;
  defaultBranch: string;
  requiredBranches: ["main", "development"];
  requiredStatusChecks: string[];
  languageProfile: string;
  createdAt: string;
  updatedAt: string;
  lastFetchAt?: string;
  status: RepositoryStatus;
  policyReferences: string[];
  persistentEnvironmentPaths: string[];
  requiredBackupPaths: string[];
};
type Registry = { schemaVersion: number; repositories: ManagedRepository[] };

const root = path.join(config.dataDir, "repositories");
const registryFile = path.join(root, "registry.json");
const cacheRoot = path.join(root, "cache");
const lockDirectory = path.join(root, ".registry-lock");
const HOSTNAME_SUFFIX = process.env.REPOSITORY_DEV_HOST_SUFFIX ?? ".dev.cr8or.be";
const MAX_REPOSITORIES = Number(process.env.REPOSITORY_MAX_COUNT ?? 250);
const MAX_CACHE_BYTES = Number(process.env.REPOSITORY_MAX_CACHE_BYTES ?? 20 * 1024 ** 3);
const CACHE_STALE_AFTER_MS = Number(process.env.REPOSITORY_CACHE_STALE_AFTER_MS ?? 7 * 24 * 60 * 60 * 1000);

function assertSafeConfig(): void {
  if (!Number.isSafeInteger(MAX_REPOSITORIES) || MAX_REPOSITORIES < 1) throw new Error("REPOSITORY_MAX_COUNT must be a positive integer");
  if (!Number.isSafeInteger(MAX_CACHE_BYTES) || MAX_CACHE_BYTES < 1) throw new Error("REPOSITORY_MAX_CACHE_BYTES must be a positive integer");
  if (!Number.isSafeInteger(CACHE_STALE_AFTER_MS) || CACHE_STALE_AFTER_MS < 1) throw new Error("REPOSITORY_CACHE_STALE_AFTER_MS must be a positive integer");
  if (!/^\.[a-z0-9.-]+$/.test(HOSTNAME_SUFFIX) || HOSTNAME_SUFFIX.includes("..")) throw new Error("REPOSITORY_DEV_HOST_SUFFIX is invalid");
}

function slug(fullName: string): string {
  const readable = fullName.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "");
  const identityHash = createHash("sha256").update(fullName.toLowerCase()).digest("hex").slice(0, 10);
  return `${readable}-${identityHash}`;
}

export function parseGitHubRemote(input: string): { fullName: string; remoteUrl: string; name: string } {
  let url: URL;
  try { url = new URL(input); } catch { throw new Error("Repository remote must be an absolute HTTPS GitHub URL"); }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" || url.port || url.username || url.password) {
    throw new Error("Repository remote must use HTTPS on github.com without credentials or a custom port");
  }
  if (url.search || url.hash) throw new Error("Repository remote must not contain a query string or fragment");
  const match = /^\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?)\/?$/.exec(url.pathname.replace(/\.git$/i, ""));
  if (!match) throw new Error("Repository remote must identify exactly one GitHub owner/repository");
  const fullName = `${match[1]!}/${match[2]!}`;
  return { fullName, remoteUrl: `https://github.com/${fullName}.git`, name: match[2]! };
}

async function withLock<T>(operation: () => Promise<T>, targetLock = lockDirectory): Promise<T> {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await fs.mkdir(path.dirname(targetLock), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    try {
      await fs.mkdir(targetLock, { mode: 0o700 });
      await fs.writeFile(path.join(targetLock, "owner.json"), JSON.stringify({ pid: process.pid, createdAt: Date.now() }), { mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const stat = await fs.stat(targetLock);
        if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
          await fs.rm(targetLock, { recursive: true, force: true });
          continue;
        }
      } catch { continue; }
      if (Date.now() >= deadline) throw new Error("Repository registry is busy; retry the operation");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  try { return await operation(); } finally { await fs.rm(targetLock, { recursive: true, force: true }); }
}

async function readRegistry(lockHeld = false): Promise<Registry> {
  try {
    const parsed = JSON.parse(await fs.readFile(registryFile, "utf8")) as Partial<Registry>;
    if (!Array.isArray(parsed.repositories)) throw new Error("Corrupt repository registry: repositories must be an array");
    const version = parsed.schemaVersion ?? 0;
    if (version === 0 || version === 1) {
      if (!lockHeld) return withLock(async () => readRegistry(true));
      const migrated: Registry = {
        schemaVersion: SCHEMA_VERSION,
        repositories: parsed.repositories.map((entry) => {
          const item = entry as Partial<ManagedRepository>;
          if (!item.fullName || !item.remoteUrl || !item.name) throw new Error("Legacy repository registry contains an incomplete repository record");
          const identity = parseGitHubRemote(item.remoteUrl);
          const now = new Date().toISOString();
          return {
            id: item.id ?? slug(identity.fullName), fullName: identity.fullName, remoteUrl: identity.remoteUrl,
            name: identity.name, developmentHostname: item.developmentHostname ?? `${identity.name.toLowerCase().replace(/-/g, ".")}${HOSTNAME_SUFFIX}`,
            cachePath: item.cachePath ?? path.join(cacheRoot, slug(identity.fullName)), defaultBranch: item.defaultBranch ?? "unknown",
            requiredBranches: ["main", "development"],
            requiredStatusChecks: normalizeRequiredStatusChecks(Array.isArray(item.requiredStatusChecks) && item.requiredStatusChecks.length ? item.requiredStatusChecks : config.repositoryRequiredStatusChecks),
            languageProfile: item.languageProfile ?? "unspecified",
            createdAt: item.createdAt ?? now, updatedAt: now, ...(item.lastFetchAt ? { lastFetchAt: item.lastFetchAt } : {}),
            status: item.status ?? "registered", policyReferences: item.policyReferences ?? [],
            persistentEnvironmentPaths: item.persistentEnvironmentPaths ?? [], requiredBackupPaths: item.requiredBackupPaths ?? [],
          };
        }),
      };
      await writeRegistry(migrated);
      return migrated;
    }
    if (version !== SCHEMA_VERSION) throw new Error(`Unsupported repository registry schema version: ${version}`);
    return parsed as Registry;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: SCHEMA_VERSION, repositories: [] };
    throw error;
  }
}
async function writeRegistry(registry: Registry): Promise<void> {
  const temporary = `${registryFile}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(registry, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await fs.rename(temporary, registryFile);
}

export function sanitizeGitError(value: string): string {
  return value.replace(/https:\/\/[^\s/@]+:[^\s/@]+@/g, "https://[redacted]@").slice(0, 1000);
}

const SAFE_GIT_ENVIRONMENT_KEYS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "TZ",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const;

function safeGitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SAFE_GIT_ENVIRONMENT_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
  };
}

function git(args: string[], options: { cwd?: string; timeoutMs?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const gitArguments = ["-c", "core.hooksPath=/dev/null", "-c", "protocol.file.allow=never", "-c", "protocol.ext.allow=never"];
    const credentialHelper = process.env.REPOSITORY_GIT_CREDENTIAL_HELPER;
    if (credentialHelper) {
      if (!/^\/[A-Za-z0-9_./-]+$/.test(credentialHelper) || credentialHelper.split("/").includes("..")) {
        reject(new Error("REPOSITORY_GIT_CREDENTIAL_HELPER must be a trusted absolute executable path without arguments"));
        return;
      }
      try {
        const helperStat = lstatSync(credentialHelper);
        const ownerUid = typeof process.getuid === "function" ? process.getuid() : helperStat.uid;
        if (helperStat.isSymbolicLink() || !helperStat.isFile() || (helperStat.mode & 0o111) === 0 || (helperStat.mode & 0o022) !== 0 || (helperStat.uid !== 0 && helperStat.uid !== ownerUid)) {
          reject(new Error("Git credential helper must be a non-writable executable owned by root or the service account"));
          return;
        }
      } catch (error) {
        reject(new Error(`Configured Git credential helper is unavailable: ${(error as Error).message}`));
        return;
      }
      gitArguments.push("-c", `credential.helper=${credentialHelper}`);
    }
    const child = spawn("git", [...gitArguments, ...args], {
      cwd: options.cwd ?? root,
      env: safeGitEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let total = 0;
    const collect = (target: "stdout" | "stderr", chunk: Buffer) => {
      total += chunk.length;
      if (total <= MAX_OUTPUT_BYTES) {
        if (target === "stdout") stdout += chunk.toString("utf8");
        else stderr += chunk.toString("utf8");
      }
    };
    child.stdout.on("data", (chunk: Buffer) => collect("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => collect("stderr", chunk));
    const timer = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    child.once("error", (error) => { clearTimeout(timer); reject(new Error(`Git could not start: ${error.message}`)); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else {
        const detail = sanitizeGitError(stderr);
        reject(new Error(signal ? `Git operation timed out or was terminated (${signal})` : `Git operation failed${detail ? `: ${detail}` : ` (exit ${code})`}`));
      }
    });
  });
}

async function getById(id: string, lockHeld = false): Promise<ManagedRepository> {
  const repository = (await readRegistry(lockHeld)).repositories.find((item) => item.id === id || item.fullName.toLowerCase() === id.toLowerCase());
  if (!repository) throw new Error(`Repository '${id}' is not registered`);
  return repository;
}

export async function getManagedRepository(id: string): Promise<ManagedRepository> {
  return getById(id);
}

export async function withRepositoryLock<T>(id: string, operation: (repository: ManagedRepository) => Promise<T>): Promise<T> {
  const initial = await getById(id);
  return withLock(async () => operation(await getById(initial.id)), path.join(root, ".repository-locks", initial.id));
}

export async function runManagedGit(args: string[], options: { cwd?: string; timeoutMs?: number } = {}): Promise<string> {
  return git(args, options);
}

async function discover(repository: ManagedRepository): Promise<{ defaultBranch: string; branches: string[]; branchHeads: Record<string, string>; missingRequiredBranches: string[] }> {
  const refs = await git(["ls-remote", "--symref", repository.remoteUrl, "HEAD", "refs/heads/*"]);
  const lines = refs.split("\n").filter(Boolean);
  const defaultLine = lines.find((line) => line.startsWith("ref: ") && line.endsWith("\tHEAD"));
  const defaultBranch = defaultLine?.slice(5).split("\t")[0]?.replace(/^refs\/heads\//, "") ?? "unknown";
  const branchEntries = lines.filter((line) => !line.startsWith("ref: ")).map((line) => line.split("\t")).filter((parts) => parts[1]?.startsWith("refs/heads/"));
  const branchHeads = Object.fromEntries(branchEntries.map((parts) => [parts[1]!.slice("refs/heads/".length), parts[0]!]));
  const branches = Object.keys(branchHeads);
  const missingRequiredBranches = (["main", "development"] as const).filter((branch) => !branches.includes(branch));
  return { defaultBranch, branches, branchHeads, missingRequiredBranches };
}

async function directoryBytes(directory: string): Promise<number> {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return 0;
    throw error;
  }

  let total = 0;
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) total += await directoryBytes(target);
    else if (entry.isFile()) {
      try {
        total += (await fs.stat(target)).size;
      } catch (error) {
        // Git may remove transient lock files while the cache is being measured.
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
    if (total > MAX_CACHE_BYTES) return total;
  }
  return total;
}

async function listWorktrees(cachePath: string): Promise<string[]> {
  try {
    const output = await git(["--git-dir", cachePath, "worktree", "list", "--porcelain"]);
    return output.split(/\n\n/).map((block) => block.split("\n").find((line) => line.startsWith("worktree "))?.slice(9)).filter((item): item is string => typeof item === "string" && path.resolve(item) !== path.resolve(cachePath));
  } catch { return []; }
}

export async function registerRepository(input: { remoteUrl: string; developmentHostname?: string | undefined; languageProfile?: string | undefined; policyReferences?: string[] | undefined; requiredStatusChecks?: string[] | undefined }): Promise<ManagedRepository & { remote: Awaited<ReturnType<typeof discover>>; branchPolicy: Awaited<ReturnType<typeof inspectBranchPolicy>> }> {
  assertSafeConfig();
  const identity = parseGitHubRemote(input.remoteUrl);
  const registered = await withLock(async () => {
    const registry = await readRegistry(true);
    const existing = registry.repositories.find((item) => item.fullName.toLowerCase() === identity.fullName.toLowerCase());
    if (existing) throw new Error(`Repository ${identity.fullName} is already registered as ${existing.id}`);
    if (registry.repositories.length >= MAX_REPOSITORIES) throw new Error(`Repository registry capacity reached (${MAX_REPOSITORIES})`);
    const hostname = input.developmentHostname ?? `${identity.name.toLowerCase().replace(/-/g, ".")}${HOSTNAME_SUFFIX}`;
    if (registry.repositories.some((item) => item.developmentHostname === hostname)) throw new Error(`Development hostname ${hostname} is already assigned`);
    if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(hostname)) throw new Error("Development hostname must be a valid lowercase DNS hostname");
    const now = new Date().toISOString();
    const repository: ManagedRepository = {
      id: slug(identity.fullName), fullName: identity.fullName, remoteUrl: identity.remoteUrl, name: identity.name,
      developmentHostname: hostname, cachePath: path.join(cacheRoot, slug(identity.fullName)), defaultBranch: "unknown",
      requiredBranches: [...REQUIRED_BRANCHES], requiredStatusChecks: normalizeRequiredStatusChecks(input.requiredStatusChecks ?? config.repositoryRequiredStatusChecks), languageProfile: input.languageProfile?.trim() || "unspecified",
      createdAt: now, updatedAt: now, status: "registered", policyReferences: input.policyReferences ?? [], persistentEnvironmentPaths: [], requiredBackupPaths: [],
    };
    const remote = await discover(repository);
    repository.defaultBranch = remote.defaultBranch;
    registry.repositories.push(repository);
    await writeRegistry(registry);
    return { repository, remote };
  });
  const branchPolicy = await inspectBranchPolicy({
    fullName: registered.repository.fullName,
    branches: registered.remote.branches,
    requiredStatusChecks: registered.repository.requiredStatusChecks,
    ...(config.repositoryGitHubToken ? { token: config.repositoryGitHubToken } : {}),
  });
  return { ...registered.repository, remote: registered.remote, branchPolicy };
}
function normalizeRequiredStatusChecks(checks: string[]): string[] {
  const normalized = [...new Set(checks.map((check) => check.trim()).filter(Boolean))];
  if (normalized.length === 0 || normalized.length > 20 || normalized.some((check) => check.length > 200)) {
    throw new Error("requiredStatusChecks must contain between 1 and 20 non-empty check names of at most 200 characters");
  }
  return normalized;
}

export async function applyRepositoryBranchPolicy(id: string, confirm: boolean) {
  const repository = await getById(id);
  const remote = await discover(repository);
  return applyBranchPolicy({
    fullName: repository.fullName,
    branches: remote.branches,
    requiredStatusChecks: repository.requiredStatusChecks,
    ...(config.repositoryGitHubToken ? { token: config.repositoryGitHubToken } : {}),
    confirm,
  });
}

export async function listRepositories(): Promise<{ schemaVersion: number; count: number; repositories: ManagedRepository[] }> {
  const registry = await readRegistry();
  return { schemaVersion: registry.schemaVersion, count: registry.repositories.length, repositories: registry.repositories };
}

/**
 * Read the repository registry without creating directories, acquiring a write lock,
 * migrating legacy schemas, or changing registry contents. Intended for read-only
 * consumers such as the operator dashboard.
 */
export async function listRepositoriesReadOnly(): Promise<{ schemaVersion: number; count: number; repositories: ManagedRepository[] }> {
  try {
    const rootStat = await fs.lstat(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new Error("Repository registry root is not a managed directory");
    }
    const registryStat = await fs.lstat(registryFile);
    if (registryStat.isSymbolicLink() || !registryStat.isFile()) {
      throw new Error("Repository registry is not a regular file");
    }
    const parsed = JSON.parse(await fs.readFile(registryFile, "utf8")) as Partial<Registry>;
    if (parsed.schemaVersion !== SCHEMA_VERSION || !Array.isArray(parsed.repositories)) {
      throw new Error("Repository registry is not in the current schema; read-only access will not migrate it");
    }
    for (const repository of parsed.repositories) {
      if (!repository || typeof repository.id !== "string" || !repository.id
        || typeof repository.fullName !== "string" || !parseGitHubRemote("https://github.com/" + repository.fullName).fullName) {
        throw new Error("Repository registry contains an invalid record");
      }
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      count: parsed.repositories.length,
      repositories: parsed.repositories as ManagedRepository[],
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { schemaVersion: SCHEMA_VERSION, count: 0, repositories: [] };
    }
    throw error;
  }
}

export async function inspectRepository(id: string) {
  const repository = await getById(id);
  const remote = await discover(repository);
  const branchPolicy = await inspectBranchPolicy({ fullName: repository.fullName, branches: remote.branches, requiredStatusChecks: repository.requiredStatusChecks, ...(config.repositoryGitHubToken ? { token: config.repositoryGitHubToken } : {}) });
  let cache: { exists: boolean; bytes: number; valid: boolean } = { exists: false, bytes: 0, valid: false };
  try {
    const stat = await fs.lstat(repository.cachePath);
    cache = { exists: true, bytes: stat.isSymbolicLink() ? 0 : await directoryBytes(repository.cachePath), valid: !stat.isSymbolicLink() && stat.isDirectory() && await git(["--git-dir", repository.cachePath, "rev-parse", "--is-bare-repository"]) === "true" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") cache = { exists: true, bytes: 0, valid: false };
  }
  const worktrees = cache.valid ? await listWorktrees(repository.cachePath) : [];
  const cachedHeads = cache.valid
    ? Object.fromEntries((await git(["--git-dir", repository.cachePath, "for-each-ref", "--format=%(refname:short) %(objectname)", "refs/remotes/origin"])).split("\n").filter(Boolean).map((line) => {
        const [branch, sha] = line.split(" ");
        return [branch?.replace(/^origin\//, ""), sha];
      })) as Record<string, string>
    : {};
  const branchDrift = Object.entries(remote.branchHeads).filter(([branch, sha]) => cachedHeads[branch] !== sha).map(([branch]) => branch);
  const environments = [] as Array<{ path: string; exists: boolean }>;
  for (const environmentPath of repository.persistentEnvironmentPaths) {
    try { await fs.access(environmentPath); environments.push({ path: environmentPath, exists: true }); }
    catch { environments.push({ path: environmentPath, exists: false }); }
  }
  return { repository, remote, branchPolicy, cache, worktrees, persistentEnvironments: environments, health: {
    remoteReachable: true, requiredBranchesPresent: remote.missingRequiredBranches.length === 0,
    missingRequiredBranches: remote.missingRequiredBranches,
    branchPolicyCompliant: branchPolicy.compliant,
    branchPolicyStatus: branchPolicy.status,
    cacheWithinLimit: cache.bytes <= MAX_CACHE_BYTES,
    cacheStale: !repository.lastFetchAt || Date.now() - Date.parse(repository.lastFetchAt) > CACHE_STALE_AFTER_MS,
    branchDrift,
  } };
}

export async function updateRepository(input: { id: string; remoteUrl?: string | undefined; developmentHostname?: string | undefined; languageProfile?: string | undefined; policyReferences?: string[] | undefined; requiredStatusChecks?: string[] | undefined; persistentEnvironmentPaths?: string[] | undefined; requiredBackupPaths?: string[] | undefined }) {
  const initial = await getById(input.id);
  return withLock(async () => withLock(async () => {
    const registry = await readRegistry(true);
    const repository = registry.repositories.find((item) => item.id === input.id || item.fullName.toLowerCase() === input.id.toLowerCase());
    if (!repository) throw new Error(`Repository '${input.id}' is not registered`);
    if (input.remoteUrl !== undefined) {
      const identity = parseGitHubRemote(input.remoteUrl);
      if (registry.repositories.some((item) => item.id !== repository.id && item.fullName.toLowerCase() === identity.fullName.toLowerCase())) throw new Error(`Repository ${identity.fullName} is already registered`);
      const nextRemote = { ...repository, fullName: identity.fullName, remoteUrl: identity.remoteUrl, name: identity.name };
      const discovered = await discover(nextRemote);
      const oldDerivedHostname = `${repository.name.toLowerCase().replace(/-/g, ".")}${HOSTNAME_SUFFIX}`;
      const newDerivedHostname = `${identity.name.toLowerCase().replace(/-/g, ".")}${HOSTNAME_SUFFIX}`;
      if (repository.developmentHostname === oldDerivedHostname) repository.developmentHostname = newDerivedHostname;
      if (registry.repositories.some((item) => item.id !== repository.id && item.developmentHostname === repository.developmentHostname)) throw new Error(`Development hostname ${repository.developmentHostname} is already assigned`);
      repository.fullName = identity.fullName;
      repository.remoteUrl = identity.remoteUrl;
      repository.name = identity.name;
      repository.defaultBranch = discovered.defaultBranch;
      try {
        const stat = await fs.lstat(repository.cachePath);
        if (stat.isSymbolicLink() || !stat.isDirectory() || await git(["--git-dir", repository.cachePath, "rev-parse", "--is-bare-repository"]).catch(() => "false") !== "true") throw new Error("Repository cache is not a valid managed bare repository; remote URL was not updated");
        await git(["--git-dir", repository.cachePath, "remote", "set-url", "origin", repository.remoteUrl]);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (input.developmentHostname !== undefined) {
      if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(input.developmentHostname)) throw new Error("Development hostname must be a valid lowercase DNS hostname");
      if (registry.repositories.some((item) => item.id !== repository.id && item.developmentHostname === input.developmentHostname)) throw new Error(`Development hostname ${input.developmentHostname} is already assigned`);
      repository.developmentHostname = input.developmentHostname;
    }
    if (input.languageProfile !== undefined) repository.languageProfile = input.languageProfile.trim() || "unspecified";
    if (input.policyReferences !== undefined) repository.policyReferences = input.policyReferences;
    if (input.requiredStatusChecks !== undefined) repository.requiredStatusChecks = normalizeRequiredStatusChecks(input.requiredStatusChecks);
    const normalizeProtectedPaths = async (entries: string[], label: string): Promise<string[]> => Promise.all(entries.map(async (entry) => {
      if (!path.isAbsolute(entry) || entry.includes("\0")) throw new Error(`${label} paths must be absolute paths`);
      const resolved = await resolveAllowedPath(entry, { allowMissingLeaf: true });
      try {
        if (!(await fs.stat(resolved)).isDirectory()) throw new Error(`${label} path must be a directory`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      return resolved;
    }));
    if (input.persistentEnvironmentPaths !== undefined) repository.persistentEnvironmentPaths = await normalizeProtectedPaths(input.persistentEnvironmentPaths, "Persistent environment");
    if (input.requiredBackupPaths !== undefined) repository.requiredBackupPaths = await normalizeProtectedPaths(input.requiredBackupPaths, "Required backup");
    repository.updatedAt = new Date().toISOString();
    await writeRegistry(registry);
    return repository;
  }, lockDirectory), path.join(root, ".repository-locks", initial.id));
}

export async function validateRepository(id: string) {
  try {
    const inspection = await inspectRepository(id);
    const valid = inspection.health.remoteReachable
      && inspection.health.requiredBranchesPresent
      && inspection.cache.valid
      && inspection.health.cacheWithinLimit
      && !inspection.health.cacheStale
      && inspection.health.branchDrift.length === 0
      && inspection.branchPolicy.compliant;
    return { valid, ...inspection };
  } catch (error) {
    return { valid: false, remoteReachable: false, error: error instanceof Error ? error.message : "Repository validation failed" };
  }
}

export async function fetchRepository(id: string) {
  const initial = await getById(id);
  return withLock(async () => {
    const current = await withLock(async () => getById(initial.id, true));
    const remote = await discover(current);
    await fs.mkdir(cacheRoot, { recursive: true, mode: 0o700 });
    const temporary = `${current.cachePath}.${randomUUID()}.tmp`;
    try {
      let cacheExists = false;
      try {
        const cacheStat = await fs.lstat(current.cachePath);
        if (cacheStat.isSymbolicLink() || !cacheStat.isDirectory()) throw new Error("Repository cache path is not a managed directory; refusing to follow or replace it");
        cacheExists = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (cacheExists) {
        const bare = await git(["--git-dir", current.cachePath, "rev-parse", "--is-bare-repository"]).catch(() => "false");
        if (bare !== "true") throw new Error("Repository cache is corrupt; refusing to replace it automatically");
        // Fetch updates remote-tracking refs and objects only. It never checks out, resets, cleans, or mutates a worktree.
        await git(["--git-dir", current.cachePath, "fetch", "--prune", "--no-recurse-submodules", "origin"], { timeoutMs: DEFAULT_TIMEOUT_MS });
      } else {
        await git(["clone", "--bare", "--no-hardlinks", "--", current.remoteUrl, temporary], { timeoutMs: DEFAULT_TIMEOUT_MS });
        await git(["--git-dir", temporary, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
        await git(["--git-dir", temporary, "fetch", "--prune", "origin"], { timeoutMs: DEFAULT_TIMEOUT_MS });
        const temporaryBytes = await directoryBytes(temporary);
        if (temporaryBytes > MAX_CACHE_BYTES) throw new Error(`Repository cache exceeds configured capacity (${MAX_CACHE_BYTES} bytes)`);
        await fs.rename(temporary, current.cachePath);
      }
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
    const bytes = await directoryBytes(current.cachePath);
    if (bytes > MAX_CACHE_BYTES) throw new Error(`Repository cache exceeds configured capacity (${MAX_CACHE_BYTES} bytes)`);
    return withLock(async () => {
      const registry = await readRegistry(true);
      const repository = registry.repositories.find((item) => item.id === current.id);
      if (!repository) throw new Error(`Repository '${current.id}' was removed while its cache was being fetched`);
      const fetchedAt = new Date().toISOString();
      repository.defaultBranch = remote.defaultBranch;
      repository.lastFetchAt = fetchedAt;
      repository.updatedAt = fetchedAt;
      repository.status = "cloned";
      await writeRegistry(registry);
      return { repository, remote, cacheBytes: bytes, warning: remote.missingRequiredBranches.length ? `Missing required branches: ${remote.missingRequiredBranches.join(", ")}. No branches were created or changed.` : undefined };
    });
  }, path.join(root, ".repository-locks", initial.id));
}

export async function removeRepository(input: { id: string; dryRun: boolean }) {
  const initial = await getById(input.id);
  return withLock(async () => withLock(async () => {
    const registry = await readRegistry(true);
    const index = registry.repositories.findIndex((item) => item.id === initial.id);
    if (index < 0) throw new Error(`Repository '${input.id}' is not registered`);
    const repository = registry.repositories[index]!;
    let cacheExists = false;
    try {
      const cacheStat = await fs.lstat(repository.cachePath);
      if (cacheStat.isSymbolicLink() || !cacheStat.isDirectory()) throw new Error("Repository cache path is not a managed directory; refusing to follow or delete it");
      cacheExists = true;
      const bare = await git(["--git-dir", repository.cachePath, "rev-parse", "--is-bare-repository"]).catch(() => "false");
      if (bare !== "true") throw new Error("Repository cache is corrupt; refusing to delete it automatically");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const worktrees = cacheExists ? await listWorktrees(repository.cachePath) : [];
    const existingEnvironments = [] as string[];
    for (const environmentPath of repository.persistentEnvironmentPaths) {
      try { await fs.access(environmentPath); existingEnvironments.push(environmentPath); } catch { /* removed environment */ }
    }
    const existingBackups = [] as string[];
    for (const backupPath of repository.requiredBackupPaths) {
      try { await fs.access(backupPath); existingBackups.push(backupPath); } catch { /* backup removed or moved */ }
    }
    const blockers = [
      ...worktrees.map((item) => `linked worktree: ${item}`),
      ...existingEnvironments.map((item) => `persistent environment: ${item}`),
      ...existingBackups.map((item) => `required backup: ${item}`),
    ];
    if (input.dryRun) return { removed: false, dryRun: true, repository, cacheExists, blockers };
    if (blockers.length) throw new Error(`Repository removal is blocked: ${blockers.join("; ")}`);
    if (cacheExists) await fs.rm(repository.cachePath, { recursive: true, force: true });
    registry.repositories.splice(index, 1);
    await writeRegistry(registry);
    return { removed: true, dryRun: false, id: repository.id, fullName: repository.fullName };
  }, lockDirectory), path.join(root, ".repository-locks", initial.id));
}
