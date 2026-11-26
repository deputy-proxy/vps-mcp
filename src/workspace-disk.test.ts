import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceDiskScanner } from "./workspace-disk.js";

const temporaryDirectories: string[] = [];

async function createWorkspace(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "vps-mcp-workspace-disk-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("incremental workspace disk scanner", () => {
  it("resumes a bounded scan across calls and returns the complete total", async () => {
    const root = await createWorkspace();
    await Promise.all(Array.from({ length: 8 }, (_, index) => writeFile(path.join(root, `file-${index}.bin`), Buffer.alloc(100))));
    const scanner = new WorkspaceDiskScanner({ maxEntriesPerBatch: 3, maxDurationMs: 10_000 });

    const first = await scanner.measure(root);
    expect(first).toEqual({ bytes: 300, status: "partial" });

    const second = await scanner.measure(root);
    expect(second).toEqual({ bytes: 600, status: "partial" });

    const third = await scanner.measure(root);
    expect(third).toEqual({ bytes: 800, status: "available" });
  });

  it("caches a completed measurement until its TTL expires", async () => {
    const root = await createWorkspace();
    const file = path.join(root, "data.bin");
    await writeFile(file, Buffer.alloc(100));
    let now = 1_000;
    const scanner = new WorkspaceDiskScanner({ cacheTtlMs: 500, now: () => now });

    expect(await scanner.measure(root)).toEqual({ bytes: 100, status: "available" });
    await writeFile(file, Buffer.alloc(200));
    expect(await scanner.measure(root)).toEqual({ bytes: 100, status: "available" });

    now += 501;
    expect(await scanner.measure(root)).toEqual({ bytes: 200, status: "available" });
  });

  it("does not follow symbolic links", async () => {
    const root = await createWorkspace();
    const outside = await createWorkspace();
    await writeFile(path.join(outside, "outside.bin"), Buffer.alloc(500));
    await writeFile(path.join(root, "inside.bin"), Buffer.alloc(50));
    const { symlink } = await import("node:fs/promises");
    await symlink(outside, path.join(root, "linked-directory"));

    const scanner = new WorkspaceDiskScanner();
    expect(await scanner.measure(root)).toEqual({ bytes: 50, status: "available" });
  });

  it("forgets removed workspaces and can be reset", async () => {
    const root = await createWorkspace();
    await writeFile(path.join(root, "data.bin"), Buffer.alloc(50));
    const scanner = new WorkspaceDiskScanner();
    expect(await scanner.measure(root)).toEqual({ bytes: 50, status: "available" });
    scanner.forget(root);
    await writeFile(path.join(root, "data.bin"), Buffer.alloc(75));
    expect(await scanner.measure(root)).toEqual({ bytes: 75, status: "available" });
    scanner.clear();
    expect(await scanner.measure(root)).toEqual({ bytes: 75, status: "available" });
  });

  it("reports an unavailable measurement when the workspace cannot be read", async () => {
    const root = path.join(tmpdir(), "missing-workspace-disk-" + Date.now());
    const scanner = new WorkspaceDiskScanner();
    expect(await scanner.measure(root)).toEqual({ bytes: null, status: "unavailable" });
  });
});
