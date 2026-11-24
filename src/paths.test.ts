import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.MCP_AUTH_TOKEN ??= "test-only-token-that-is-long-enough-for-vps-mcp";
const temporaryRoots: string[] = [];
const originalRoots = process.env.MCP_ALLOWED_ROOTS;

async function loadResolver(root: string) {
  process.env.MCP_ALLOWED_ROOTS = root;
  vi.resetModules();
  const module = await import("./paths.js");
  return module;
}

afterEach(async () => {
  if (originalRoots === undefined) delete process.env.MCP_ALLOWED_ROOTS;
  else process.env.MCP_ALLOWED_ROOTS = originalRoots;
  vi.resetModules();
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("resolveAllowedPath", () => {
  it("accepts files inside an allowed root", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vps-mcp-"));
    temporaryRoots.push(root);
    const file = path.join(root, "safe.txt");
    await fs.writeFile(file, "safe");
    const { resolveAllowedPath: resolve } = await loadResolver(root);
    await expect(resolve(file)).resolves.toBe(file);
  });

  it("rejects paths outside allowed roots", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vps-mcp-"));
    temporaryRoots.push(root);
    const { resolveAllowedPath: resolve } = await loadResolver(root);
    await expect(resolve(path.join(os.tmpdir(), "outside.txt"), { allowMissingLeaf: true })).rejects.toThrow("outside");
  });

  it("rejects a symlink that escapes an allowed root", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vps-mcp-"));
    temporaryRoots.push(root);
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "vps-mcp-outside-"));
    temporaryRoots.push(outside);
    const link = path.join(root, "escape");
    await fs.symlink(outside, link, "dir");
    const { resolveAllowedPath: resolve } = await loadResolver(root);
    await expect(resolve(path.join(link, "secret.txt"), { allowMissingLeaf: true })).rejects.toThrow();
  });
});


describe("managedTaskWorkspaceIdentity", () => {
  it("recognizes files nested under a managed task worktree", async () => {
    const { managedTaskWorkspaceIdentity } = await import("./paths.js");
    expect(managedTaskWorkspaceIdentity("/var/lib/vps-mcp/task-workspaces/worktrees/repo-123/134e5321-b4d7-4d4f-be92-ce56a984adaa/src/index.ts"))
      .toEqual({ repositoryId: "repo-123", worktreeId: "134e5321-b4d7-4d4f-be92-ce56a984adaa" });
    expect(managedTaskWorkspaceIdentity("/srv/vps-mcp-workspaces/repo-123/134e5321-b4d7-4d4f-be92-ce56a984adaa/README.md"))
      .toEqual({ repositoryId: "repo-123", worktreeId: "134e5321-b4d7-4d4f-be92-ce56a984adaa" });
  });

  it("does not classify arbitrary allowed-root files or workspace roots as task worktrees", async () => {
    const { managedTaskWorkspaceIdentity } = await import("./paths.js");
    expect(managedTaskWorkspaceIdentity("/var/lib/vps-mcp/task-workspaces/worktrees/repo-123/README.md")).toBeNull();
    expect(managedTaskWorkspaceIdentity("/var/lib/vps-mcp/task-workspaces/worktrees/repo-123/134e5321-b4d7-4d4f-be92-ce56a984adaa")).toBeNull();
    expect(managedTaskWorkspaceIdentity("/etc/hosts")).toBeNull();
  });
});
