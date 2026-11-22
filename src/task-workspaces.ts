import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { validateTaskBranchCreation } from "./branch-policy.js";
import { fetchRepository, runManagedGit, withRepositoryLock, type ManagedRepository } from "./repositories.js";

const SCHEMA_VERSION = 1;
const SANDBOX_RUNTIME_USER = "vps-sandbox";
const LOCK_TIMEOUT_MS = 10_000;
const root = path.join(config.dataDir, "task-workspaces");
const worktreeRoot = path.join(root, "worktrees");
const registryPath = path.join(root, "registry.json");
const registryLock = path.join(root, ".registry-lock");

export type WorkspaceStatus = "creating" | "active" | "retained" | "removing" | "removed" | "failed";
export type TaskWorkspace = {
  id: string; repositoryId: string; repositoryFullName: string; taskId: string; sandboxId?: string;
  worktreePath: string; branchName: string; baseRef: "development"; baseSha: string;
  targetPullRequestBranch: "development"; status: WorkspaceStatus;
  retentionPolicy: { mode: "manual" } | { mode: "expires"; expiresAt: string };
  createdAt: string; updatedAt: string; retainedAt?: string; removedAt?: string; lastError?: string;
};
type Registry = { schemaVersion: number; workspaces: TaskWorkspace[] };
type Worktree = { path: string; branch?: string; head?: string };

async function ensureManagedRoots(): Promise<void> {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const rootStat = await fs.lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("Task workspace metadata root is not a managed directory");
  await fs.mkdir(worktreeRoot, { recursive: true, mode: 0o700 });
  const worktreeStat = await fs.lstat(worktreeRoot);
  if (worktreeStat.isSymbolicLink() || !worktreeStat.isDirectory()) throw new Error("Task worktree root is not a managed directory");
  const [realRoot, realWorktreeRoot] = await Promise.all([fs.realpath(root), fs.realpath(worktreeRoot)]);
  const relative = path.relative(realRoot, realWorktreeRoot);
  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw new Error("Task worktree root resolves outside the metadata root");
}

async function ensureRepositoryWorktreeDirectory(repositoryId: string): Promise<void> {
  await ensureManagedRoots();
  const directory = path.join(worktreeRoot, repositoryId);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Repository worktree directory is not a managed directory");
  const [realRoot, realDirectory] = await Promise.all([fs.realpath(worktreeRoot), fs.realpath(directory)]);
  const relative = path.relative(realRoot, realDirectory);
  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw new Error("Repository worktree directory resolves outside the managed root");
}

async function locked<T>(operation: () => Promise<T>): Promise<T> {
  await ensureManagedRoots();
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    try {
      await fs.mkdir(registryLock, { mode: 0o700 });
      await fs.writeFile(path.join(registryLock, "owner.json"), JSON.stringify({ pid: process.pid, at: Date.now() }), { mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - (await fs.stat(registryLock)).mtimeMs > 300_000) {
          await fs.rm(registryLock, { recursive: true, force: true }); continue;
        }
      } catch { continue; }
      if (Date.now() >= deadline) throw new Error("Task workspace registry is busy; retry the operation");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  try { return await operation(); } finally { await fs.rm(registryLock, { recursive: true, force: true }); }
}
async function readRegistry(): Promise<Registry> {
  try {
    const value = JSON.parse(await fs.readFile(registryPath, "utf8")) as Partial<Registry>;
    if (value.schemaVersion !== SCHEMA_VERSION || !Array.isArray(value.workspaces)) throw new Error("Task workspace registry has an unsupported or corrupt schema");
    for (const record of value.workspaces) {
      if (!record || typeof record !== "object"
        || !/^[a-z0-9][a-z0-9-]*-[a-f0-9]{10}$/.test(record.repositoryId)
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(record.id)
        || !/^task\/[a-z0-9][a-z0-9._-]*-[a-f0-9]{8}$/.test(record.branchName)
        || record.baseRef !== "development" || record.targetPullRequestBranch !== "development") {
        throw new Error("Task workspace registry contains an invalid or unsafe record");
      }
    }
    return value as Registry;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: SCHEMA_VERSION, workspaces: [] };
    throw error;
  }
}
async function writeRegistry(registry: Registry): Promise<void> {
  await ensureManagedRoots();
  const temp = registryPath + "." + randomUUID() + ".tmp";
  await fs.writeFile(temp, JSON.stringify(registry, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  await fs.rename(temp, registryPath);
}
async function update(id: string, mutate: (record: TaskWorkspace) => void): Promise<TaskWorkspace> {
  return locked(async () => {
    const registry = await readRegistry();
    const record = registry.workspaces.find((item) => item.id === id);
    if (!record) throw new Error("Task workspace '" + id + "' was not found");
    mutate(record); record.updatedAt = new Date().toISOString();
    await writeRegistry(registry); return record;
  });
}
async function find(id: string): Promise<TaskWorkspace> {
  const record = (await readRegistry()).workspaces.find((item) => item.id === id);
  if (!record) throw new Error("Task workspace '" + id + "' was not found");
  return record;
}
function parseWorktrees(output: string): Worktree[] {
  return output.split(/\n\n/).filter(Boolean).map((block) => {
    const lines = block.split("\n");
    const get = (prefix: string) => lines.find((line) => line.startsWith(prefix))?.slice(prefix.length);
    const branch = get("branch ");
    const head = get("HEAD ");
    return { path: get("worktree ") ?? "", ...(branch ? { branch: branch.replace(/^refs\/heads\//, "") } : {}), ...(head ? { head } : {}) };
  }).filter((item) => item.path);
}
async function worktrees(repo: ManagedRepository) {
  return parseWorktrees(await runManagedGit(["--git-dir", repo.cachePath, "worktree", "list", "--porcelain"]));
}
function safeTaskId(taskId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(taskId)) throw new Error("taskId must be a stable identifier, not a task title, with at most 128 safe characters");
  const slug = taskId.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/\.{2,}/g, "-").replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "").slice(0, 64);
  if (!slug) throw new Error("taskId does not contain usable identifier characters");
  return slug;
}
function expectedPath(record: TaskWorkspace) { return path.join(worktreeRoot, record.repositoryId, record.id); }
async function verifyPath(record: TaskWorkspace, missingOkay = false): Promise<string> {
  const expected = expectedPath(record);
  if (path.resolve(expected) !== path.resolve(record.worktreePath)) throw new Error("Workspace path does not match its managed metadata identity");
  const [rootStat, worktreeRootStat, repositoryStat, stat] = await Promise.all([
    fs.lstat(root), fs.lstat(worktreeRoot), fs.lstat(path.dirname(expected)),
    fs.lstat(expected).catch((error: NodeJS.ErrnoException) => {
      if (missingOkay && error.code === "ENOENT") return undefined;
      throw error;
    }),
  ]);
  if (!stat) return expected;
  if ([rootStat, worktreeRootStat, repositoryStat, stat].some((item) => item.isSymbolicLink() || !item.isDirectory())) {
    throw new Error("Workspace path contains a symlink or non-directory component; refusing to follow it");
  }
  const [realRoot, realPath] = await Promise.all([fs.realpath(worktreeRoot), fs.realpath(expected)]);
  const relative = path.relative(realRoot, realPath);
  if (path.resolve(realPath) !== path.resolve(expected) || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
    throw new Error("Workspace resolves outside its exact managed path");
  }
  return realPath;
}
async function status(repo: ManagedRepository, record: TaskWorkspace) {
  const target = await verifyPath(record, true);
  try { await fs.access(target); } catch { return { exists: false, linked: false, dirty: false, staged: false, untracked: 0, ignored: 0, branch: null as string | null, head: null as string | null, porcelain: "" }; }
  const linked = (await worktrees(repo)).some((item) => path.resolve(item.path) === path.resolve(target));
  if (!linked) return { exists: true, linked: false, dirty: false, staged: false, untracked: 0, ignored: 0, branch: null, head: null, porcelain: "" };
  const branch = await runManagedGit(["-C", target, "branch", "--show-current"]);
  if (!branch || branch === "main" || branch === "development" || branch !== record.branchName) throw new Error("Protected-branch invariant failed: expected task branch '" + record.branchName + "'");
  const porcelain = await runManagedGit(["-C", target, "status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching"]);
  const lines = porcelain ? porcelain.split("\n") : [];
  return {
    exists: true, linked: true, dirty: lines.length > 0,
    staged: lines.some((line) => /^[MADRCU][MADRCU? ]/.test(line)),
    untracked: lines.filter((line) => line.startsWith("?? ")).length,
    ignored: lines.filter((line) => line.startsWith("!! ")).length,
    branch, head: await runManagedGit(["-C", target, "rev-parse", "HEAD"]), porcelain,
  };
}
async function recover(repo: ManagedRepository) {
  const pending = (await readRegistry()).workspaces.filter((item) => item.repositoryId === repo.id && (item.status === "creating" || item.status === "removing"));
  if (!pending.length) return;
  const linked = await worktrees(repo);
  await locked(async () => {
    const registry = await readRegistry(); let changed = false;
    for (const record of registry.workspaces) {
      if (record.repositoryId !== repo.id || !["creating", "removing"].includes(record.status)) continue;
      const hasLink = linked.some((item) => path.resolve(item.path) === path.resolve(record.worktreePath));
      const exists = await fs.lstat(record.worktreePath).then(() => true).catch(() => false);
      if (record.status === "creating") {
        record.status = hasLink && exists ? "active" : "failed";
        if (!hasLink || !exists) record.lastError = "Creation interrupted before a linked worktree was ready";
      } else if (!hasLink && !exists) { record.status = "removed"; record.removedAt = new Date().toISOString(); }
      else { record.status = "active"; record.lastError = "Removal interrupted; worktree preserved"; }
      record.updatedAt = new Date().toISOString(); changed = true;
    }
    if (changed) await writeRegistry(registry);
  });
}

export async function createTaskWorkspace(input: { repositoryId: string; taskId: string; sandboxId?: string; retentionDays?: number }) {
  const taskSlug = safeTaskId(input.taskId);
  if (input.sandboxId !== undefined && (!input.sandboxId.trim() || input.sandboxId.length > 128)) throw new Error("sandboxId must be a non-empty identifier of at most 128 characters");
  if (input.retentionDays !== undefined && (!Number.isInteger(input.retentionDays) || input.retentionDays < 1 || input.retentionDays > 3650)) throw new Error("retentionDays must be between 1 and 3650 days");
  await fetchRepository(input.repositoryId);
  return withRepositoryLock(input.repositoryId, async (repo) => {
    if (!/^[a-z0-9][a-z0-9-]*-[a-f0-9]{10}$/.test(repo.id)) throw new Error("Registered repository ID is invalid for task workspace storage");
    const cache = await fs.lstat(repo.cachePath);
    if (cache.isSymbolicLink() || !cache.isDirectory() || await runManagedGit(["--git-dir", repo.cachePath, "rev-parse", "--is-bare-repository"]) !== "true") throw new Error("Repository cache is not a valid managed bare repository");
    const baseSha = await runManagedGit(["--git-dir", repo.cachePath, "rev-parse", "refs/remotes/origin/development^{commit}"]);
    const id = randomUUID(), branchName = "task/" + taskSlug + "-" + id.slice(0, 8);
    const validation = validateTaskBranchCreation({ branchName, baseBranch: "development" });
    if (!validation.valid) throw new Error(validation.reason ?? "Task branch policy validation failed");
    await ensureRepositoryWorktreeDirectory(repo.id);
    const worktreePath = path.join(worktreeRoot, repo.id, id);
    try { await fs.lstat(worktreePath); throw new Error("Generated workspace path already exists"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const now = new Date().toISOString();
    const record: TaskWorkspace = {
      id, repositoryId: repo.id, repositoryFullName: repo.fullName, taskId: input.taskId,
      ...(input.sandboxId ? { sandboxId: input.sandboxId } : {}), worktreePath, branchName,
      baseRef: "development", baseSha, targetPullRequestBranch: "development", status: "creating",
      retentionPolicy: input.retentionDays ? { mode: "expires", expiresAt: new Date(Date.now() + input.retentionDays * 86_400_000).toISOString() } : { mode: "manual" },
      createdAt: now, updatedAt: now,
    };
    await locked(async () => {
      const registry = await readRegistry();
      if (registry.workspaces.some((item) => item.repositoryId === repo.id && item.taskId.toLowerCase() === input.taskId.toLowerCase() && !["removed", "failed"].includes(item.status))) {
        throw new Error("An active or retained workspace already exists for task '" + input.taskId + "'");
      }
      registry.workspaces.push(record); await writeRegistry(registry);
    });
    try {
      await runManagedGit(["--git-dir", repo.cachePath, "worktree", "add", "-b", branchName, worktreePath, baseSha], { timeoutMs: 120_000 });
      return update(id, (item) => { item.status = "active"; delete item.lastError; });
    } catch (error) {
      await update(id, (item) => { item.status = "failed"; item.lastError = error instanceof Error ? error.message : "Workspace creation failed"; });
      throw error;
    }
  });
}

export async function listTaskWorkspaces(input: { repositoryId?: string; taskId?: string; includeRemoved?: boolean } = {}) {
  return (await readRegistry()).workspaces.filter((item) =>
    (!input.repositoryId || item.repositoryId === input.repositoryId || item.repositoryFullName.toLowerCase() === input.repositoryId.toLowerCase())
    && (!input.taskId || item.taskId === input.taskId) && (input.includeRemoved || item.status !== "removed"));
}
export async function inspectTaskWorkspace(id: string) {
  const initial = await find(id);
  return withRepositoryLock(initial.repositoryId, async (repo) => {
    await recover(repo);
    const record = await find(id);
    if (record.status === "removed") return { workspace: record, filesystem: { exists: false, linked: false }, git: null, changes: { dirty: false, staged: false, untracked: 0, ignored: 0, porcelain: "" } };
    const state = await status(repo, record);
    return { workspace: record, filesystem: { exists: state.exists, linked: state.linked }, git: { branch: state.branch, head: state.head, baseSha: record.baseSha, targetPullRequestBranch: record.targetPullRequestBranch }, changes: { dirty: state.dirty, staged: state.staged, untracked: state.untracked, ignored: state.ignored, porcelain: state.porcelain } };
  });
}
export async function prepareTaskWorkspaceForRuntime(id: string) {
  const initial = await find(id);
  return withRepositoryLock(initial.repositoryId, async (repo) => {
    const record = await find(id);
    if (record.status !== "active" && record.status !== "retained") {
      throw new Error("Only active or retained task workspaces can be mounted into a runtime");
    }
    const target = await verifyPath(record);
    const linked = (await worktrees(repo)).some((item) => path.resolve(item.path) === path.resolve(target));
    if (!linked) throw new Error("Task workspace is not a registered Git worktree; refusing runtime access");

    const repositoryDirectory = path.dirname(target);
    const traversalPaths = [path.dirname(root), root, worktreeRoot, repositoryDirectory];
    try {
      execFileSync("/usr/bin/setfacl", ["-m", `u:${SANDBOX_RUNTIME_USER}:--x`, ...traversalPaths], {
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5_000,
      });
      execFileSync("/usr/bin/setfacl", ["-R", "-m", `u:${SANDBOX_RUNTIME_USER}:rwX`, target], {
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000,
      });
      execFileSync("/usr/bin/find", [
        target, "-type", "d", "-exec", "/usr/bin/setfacl", "-m",
        `d:u:${SANDBOX_RUNTIME_USER}:rwX`, "{}", "+",
      ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
    } catch {
      throw new Error("Cannot authorize the vps-sandbox runtime for this worktree; install the acl package and verify setfacl permissions");
    }
    return { id: record.id, repositoryId: record.repositoryId, worktreeId: record.id, workspacePath: target };
  });
}

export async function getTaskWorkspaceStatus(id: string) {
  const result = await inspectTaskWorkspace(id);
  return { id, status: result.workspace.status, ...result.filesystem, branch: result.git?.branch ?? null, changes: result.changes };
}
export async function getTaskWorkspaceDiff(id: string) {
  const record = await find(id);
  return withRepositoryLock(record.repositoryId, async (repo) => {
    const state = await status(repo, record);
    if (!state.exists || !state.linked) throw new Error("Task workspace worktree is not available");
    return {
      id, branch: record.branchName, baseSha: record.baseSha, head: state.head, dirty: state.dirty,
      diffStat: await runManagedGit(["-C", record.worktreePath, "diff", "HEAD", "--stat"]),
      numstat: await runManagedGit(["-C", record.worktreePath, "diff", "HEAD", "--numstat"]),
      untrackedFiles: state.porcelain.split("\n").filter((line) => line.startsWith("?? ")).map((line) => line.slice(3)),
      ignoredFiles: state.porcelain.split("\n").filter((line) => line.startsWith("!! ")).map((line) => line.slice(3)),
    };
  });
}
export async function retainTaskWorkspace(id: string) {
  const record = await find(id);
  return withRepositoryLock(record.repositoryId, async (repo) => {
    const current = await find(id);
    if (current.status !== "active") throw new Error("Only active workspaces can be retained");
    const state = await status(repo, current);
    if (!state.exists || !state.linked) throw new Error("Cannot retain a missing or unlinked worktree");
    return update(id, (item) => { item.status = "retained"; item.retainedAt = new Date().toISOString(); });
  });
}
export async function resumeTaskWorkspace(id: string) {
  const record = await find(id);
  return withRepositoryLock(record.repositoryId, async (repo) => {
    await recover(repo);
    const current = await find(id);
    if (current.status !== "retained") throw new Error("Only retained workspaces can be resumed");
    const state = await status(repo, current);
    if (!state.exists || !state.linked) throw new Error("Retained worktree is missing or unlinked; it was not recreated automatically");
    return update(id, (item) => { item.status = "active"; });
  });
}
export async function removeTaskWorkspace(input: { id: string; confirm: boolean; discardChanges?: boolean }) {
  if (!input.confirm) throw new Error("Workspace removal requires confirm=true");
  const record = await find(input.id);
  return withRepositoryLock(record.repositoryId, async (repo) => {
    const current = await find(input.id);
    if (current.status === "removed") return { removed: true, alreadyRemoved: true, id: current.id };
    if (["creating", "removing"].includes(current.status)) throw new Error("Workspace is in an unfinished lifecycle transition");
    const state = await status(repo, current);
    if (!state.exists) {
      const staleLink = (await worktrees(repo)).some((item) => path.resolve(item.path) === path.resolve(current.worktreePath));
      if (staleLink) await runManagedGit(["--git-dir", repo.cachePath, "worktree", "prune", "--expire", "now"]);
      let branchDeleted = true;
      try { await runManagedGit(["--git-dir", repo.cachePath, "branch", "-D", "--", current.branchName]); }
      catch { branchDeleted = false; }
      await update(current.id, (item) => { item.status = "removed"; item.removedAt = new Date().toISOString(); });
      return { removed: true, id: current.id, worktreeMissing: true, staleGitRegistrationPruned: staleLink, branchDeleted };
    }
    if (!state.linked) throw new Error("Workspace directory is not a registered Git worktree; refusing deletion");
    if (state.dirty && !input.discardChanges) throw new Error("Workspace contains modified, staged or untracked files. Retain it or explicitly request discardChanges=true with confirm=true.");
    await update(current.id, (item) => { item.status = "removing"; });
    try {
      await runManagedGit(["--git-dir", repo.cachePath, "worktree", "remove", ...(input.discardChanges ? ["--force"] : []), current.worktreePath]);
      await update(current.id, (item) => { item.status = "removed"; item.removedAt = new Date().toISOString(); delete item.lastError; });
      let branchDeleted = true;
      try { await runManagedGit(["--git-dir", repo.cachePath, "branch", "-D", "--", current.branchName]); }
      catch { branchDeleted = false; }
      return { removed: true, id: current.id, discardedChanges: Boolean(input.discardChanges), branchDeleted };
    } catch (error) {
      await update(current.id, (item) => { item.status = "active"; item.lastError = error instanceof Error ? error.message : "Workspace removal failed"; });
      throw error;
    }
  });
}
export async function pruneTaskWorkspaces(input: { olderThanDays: number; dryRun: boolean; confirm?: boolean }, beforeRemove?: (id: string) => Promise<void>) {
  if (!Number.isInteger(input.olderThanDays) || input.olderThanDays < 1 || input.olderThanDays > 3650) throw new Error("olderThanDays must be between 1 and 3650");
  if (!input.dryRun && input.confirm !== true) throw new Error("Pruning requires confirm=true when dryRun=false");
  const cutoff = Date.now() - input.olderThanDays * 86_400_000;
  const candidates = (await readRegistry()).workspaces.filter((item) => item.status === "retained" && item.retentionPolicy.mode === "expires" && Date.parse(item.retentionPolicy.expiresAt) <= Date.now() && Date.parse(item.updatedAt) <= cutoff);
  const results: Array<{ id: string; eligible: boolean; reason?: string; removed?: boolean }> = [];
  for (const candidate of candidates) {
    try {
      const state = await getTaskWorkspaceStatus(candidate.id);
      if (!state.exists || !state.linked) results.push({ id: candidate.id, eligible: false, reason: "worktree missing or unlinked" });
      else if (state.changes.dirty) results.push({ id: candidate.id, eligible: false, reason: "workspace has uncommitted or untracked changes" });
      else if (input.dryRun) results.push({ id: candidate.id, eligible: true });
      else { await beforeRemove?.(candidate.id); await removeTaskWorkspace({ id: candidate.id, confirm: true }); results.push({ id: candidate.id, eligible: true, removed: true }); }
    } catch (error) { results.push({ id: candidate.id, eligible: false, reason: error instanceof Error ? error.message : "prune check failed" }); }
  }
  return { dryRun: input.dryRun, olderThanDays: input.olderThanDays, candidates: results, removedCount: results.filter((item) => item.removed).length };
}
