import fs from "node:fs/promises";
import path from "node:path";

type DirectoryUsage = {
  path: string;
  exists: boolean;
  bytes: number;
  files: number;
  directories: number;
  truncated: boolean;
  error?: string;
};

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export async function scanManagedDirectory(directory: string, allowedRoots: string[], maxEntries = 250_000): Promise<DirectoryUsage> {
  const target = path.resolve(directory);
  if (!allowedRoots.some((root) => isWithin(path.resolve(root), target))) {
    return { path: target, exists: false, bytes: 0, files: 0, directories: 0, truncated: false, error: "outside_allowed_roots" };
  }
  let stat;
  try { stat = await fs.lstat(target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path: target, exists: false, bytes: 0, files: 0, directories: 0, truncated: false };
    return { path: target, exists: false, bytes: 0, files: 0, directories: 0, truncated: false, error: "stat_failed" };
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return { path: target, exists: false, bytes: 0, files: 0, directories: 0, truncated: false, error: "not_a_real_directory" };
  try {
    if (await fs.realpath(target) !== target) return { path: target, exists: false, bytes: 0, files: 0, directories: 0, truncated: false, error: "non_canonical_directory" };
  } catch { return { path: target, exists: false, bytes: 0, files: 0, directories: 0, truncated: false, error: "realpath_failed" }; }

  let bytes = 0;
  let files = 0;
  let directories = 0;
  let visited = 0;
  let truncated = false;
  const pending = [target];
  while (pending.length && !truncated) {
    const current = pending.pop()!;
    let entries;
    try { entries = await fs.readdir(current, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      visited += 1;
      if (visited > maxEntries) { truncated = true; break; }
      const item = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { directories += 1; pending.push(item); }
      else if (entry.isFile()) {
        try {
          const fileStat = await fs.lstat(item);
          if (fileStat.isFile() && !fileStat.isSymbolicLink()) { files += 1; bytes += fileStat.size; }
        } catch { /* concurrently removed entries do not invalidate the scan */ }
      }
    }
  }
  return { path: target, exists: true, bytes, files, directories, truncated };
}

export async function inspectManagedStorage(repositories: Array<{ id: string; persistentEnvironmentPaths?: string[] }>, dataDir: string, allowedRoots: string[]) {
  const roots = new Map<string, { category: string; repositoryId?: string }>();
  roots.set("repositoryCaches", { category: "repository_caches" });
  roots.set("taskWorktrees", { category: "task_worktrees" });
  roots.set("projectEnvironments", { category: "project_environments" });
  for (const repository of repositories) {
    for (const directory of repository.persistentEnvironmentPaths ?? []) {
      roots.set(path.resolve(directory), { category: "project_environment", repositoryId: repository.id });
    }
  }
  const paths = [
    ["repositoryCaches", path.join(dataDir, "repositories", "cache")],
    ["taskWorktrees", path.join(dataDir, "task-workspaces", "worktrees")],
    ["projectEnvironments", path.join(dataDir, "project-environments")],
    ...[...roots.entries()].filter(([key]) => !["repositoryCaches", "taskWorktrees", "projectEnvironments"].includes(key)),
  ] as Array<[string, string] | [string, { category: string; repositoryId?: string }] >;
  const results: Array<DirectoryUsage & { category: string; repositoryId?: string; includedInTotal: boolean }> = [];
  const countedRoots: string[] = [];
  for (const [key, value] of paths) {
    const directory = typeof value === "string" ? value : key;
    const metadata = typeof value === "string" ? roots.get(key)! : value;
    const resolved = path.resolve(directory);
    const includedInTotal = !countedRoots.some((parent) => isWithin(parent, resolved));
    const usage = await scanManagedDirectory(directory, allowedRoots);
    results.push({ ...metadata, ...usage, includedInTotal });
    if (includedInTotal && usage.exists) countedRoots.push(resolved);
  }
  return { scannedAt: new Date().toISOString(), directories: results, totalBytes: results.filter((item) => item.includedInTotal).reduce((total, item) => total + item.bytes, 0), truncated: results.some((item) => item.truncated) };
}
