import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function existingRoots(): Promise<string[]> {
  const roots: string[] = [];
  for (const configuredRoot of config.allowedRoots) {
    try {
      const realRoot = await fs.realpath(configuredRoot);
      if ((await fs.stat(realRoot)).isDirectory()) roots.push(realRoot);
    } catch {
      // A configured root may not exist until the VPS is provisioned.
    }
  }
  if (roots.length === 0) throw new Error("No configured MCP_ALLOWED_ROOTS directory currently exists");
  return roots;
}

export async function resolveAllowedPath(input: string, options: { allowMissingLeaf?: boolean } = {}): Promise<string> {
  if (!input.trim()) throw new Error("Path must not be empty");

  const requested = path.resolve(input);
  const roots = await existingRoots();

  try {
    const realTarget = await fs.realpath(requested);
    if (roots.some((root) => isWithin(root, realTarget))) return realTarget;
    throw new Error("Path is outside the configured allowed roots");
  } catch (error) {
    if (!options.allowMissingLeaf || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const parent = await fs.realpath(path.dirname(requested));
  const target = path.join(parent, path.basename(requested));
  if (roots.some((root) => isWithin(root, target))) return target;
  throw new Error("Path is outside the configured allowed roots");
}

export async function resolveAllowedDirectory(input: string): Promise<string> {
  const resolved = await resolveAllowedPath(input);
  const stats = await fs.stat(resolved);
  if (!stats.isDirectory()) throw new Error("Path is not a directory");
  return resolved;
}

const MANAGED_WORKSPACE_ROOTS = [
  "/var/lib/vps-mcp/task-workspaces/worktrees",
  "/srv/vps-mcp-workspaces",
] as const;
const REPOSITORY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,199}$/i;
const WORKTREE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function managedTaskWorkspaceIdentity(input: string): { repositoryId: string; worktreeId: string } | null {
  const candidate = path.resolve(input);
  for (const root of MANAGED_WORKSPACE_ROOTS) {
    const relative = path.relative(root, candidate);
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) continue;
    const [repositoryId, worktreeId, ...rest] = relative.split(path.sep);
    if (repositoryId && worktreeId && rest.length >= 1 && REPOSITORY_ID_PATTERN.test(repositoryId) && WORKTREE_ID_PATTERN.test(worktreeId)) {
      return { repositoryId, worktreeId };
    }
  }
  return null;
}
