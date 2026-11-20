import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveAllowedPath, resolveAllowedDirectory } from "./paths.js";

const MAX_FILE_BYTES = 2 * 1024 * 1024;

export async function readFile(input: string): Promise<{ path: string; content: string; bytes: number }> {
  const resolved = await resolveAllowedPath(input);
  const stats = await fs.stat(resolved);
  if (!stats.isFile()) throw new Error("Path is not a regular file");
  if (stats.size > MAX_FILE_BYTES) throw new Error(`File exceeds the ${MAX_FILE_BYTES}-byte read limit`);
  const content = await fs.readFile(resolved, "utf8");
  return { path: resolved, content, bytes: stats.size };
}

export async function writeFile(input: string, content: string): Promise<{ path: string; bytes: number }> {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_FILE_BYTES) throw new Error(`File exceeds the ${MAX_FILE_BYTES}-byte write limit`);
  const resolved = await resolveAllowedPath(input, { allowMissingLeaf: true });
  const temporary = path.join(path.dirname(resolved), `.${path.basename(resolved)}.${randomUUID()}.tmp`);
  await fs.writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await fs.rename(temporary, resolved);
  return { path: resolved, bytes };
}

export async function listDirectory(input: string): Promise<{ path: string; entries: Array<{ name: string; type: "file" | "directory" | "symlink" | "other"; size: number; modifiedAt: string }> }> {
  const resolved = await resolveAllowedDirectory(input);
  const entries = await fs.readdir(resolved, { withFileTypes: true });
  const result = [];
  for (const entry of entries.slice(0, 500)) {
    const fullPath = path.join(resolved, entry.name);
    let stats;
    try {
      const real = await fs.realpath(fullPath);
      await resolveAllowedPath(real);
      stats = await fs.stat(real);
    } catch {
      continue;
    }
    result.push({
      name: entry.name,
      type: entry.isSymbolicLink() ? "symlink" as const : entry.isFile() ? "file" as const : entry.isDirectory() ? "directory" as const : "other" as const,
      size: stats.size,
      modifiedAt: stats.mtime.toISOString(),
    });
  }
  return { path: resolved, entries: result };
}
