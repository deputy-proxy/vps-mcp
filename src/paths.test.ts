import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const temporaryRoots: string[] = [];
const originalRoots = process.env.MCP_ALLOWED_ROOTS;

async function loadResolver(root: string) {
  process.env.MCP_ALLOWED_ROOTS = root;
  vi.resetModules();
  const module = await import("./paths.js");
  return module.resolveAllowedPath;
}

import { vi } from "vitest";

afterEach(async () => {
  process.env.MCP_ALLOWED_ROOTS = originalRoots;
  vi.resetModules();
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("resolveAllowedPath", () => {
  it("accepts files inside an allowed root", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vps-mcp-"));
    temporaryRoots.push(root);
    const file = path.join(root, "safe.txt");
    await fs.writeFile(file, "safe");
    const resolve = await loadResolver(root);
    await expect(resolve(file)).resolves.toBe(file);
  });

  it("rejects paths outside allowed roots", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vps-mcp-"));
    temporaryRoots.push(root);
    const resolve = await loadResolver(root);
    await expect(resolve(path.join(os.tmpdir(), "outside.txt"), { allowMissingLeaf: true })).rejects.toThrow("outside");
  });

  it("rejects a symlink that escapes an allowed root", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vps-mcp-"));
    temporaryRoots.push(root);
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "vps-mcp-outside-"));
    temporaryRoots.push(outside);
    const link = path.join(root, "escape");
    await fs.symlink(outside, link, "dir");
    const resolve = await loadResolver(root);
    await expect(resolve(path.join(link, "secret.txt"), { allowMissingLeaf: true })).rejects.toThrow();
  });
});
