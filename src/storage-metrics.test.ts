import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { scanManagedDirectory } from "./storage-metrics.js";

let root: string | undefined;
afterEach(async () => { if (root) await fs.rm(root, { recursive: true, force: true }); root = undefined; });

describe("managed storage metrics", () => {
  it("counts regular files and directories without following symlinks", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "vps-storage-metrics-"));
    const allowed = path.join(root, "allowed");
    const outside = path.join(root, "outside");
    await fs.mkdir(path.join(allowed, "nested"), { recursive: true });
    await fs.mkdir(outside);
    await fs.writeFile(path.join(allowed, "nested", "file.txt"), "12345");
    await fs.writeFile(path.join(outside, "secret.txt"), "not counted");
    await fs.symlink(outside, path.join(allowed, "linked"));
    const result = await scanManagedDirectory(allowed, [root]);
    expect(result).toMatchObject({ exists: true, bytes: 5, files: 1, directories: 1, truncated: false });
  });

  it("refuses paths outside approved roots and symlink roots", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "vps-storage-metrics-"));
    const allowed = path.join(root, "allowed");
    const outside = path.join(root, "outside");
    await fs.mkdir(allowed);
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(root, "linked"));
    expect((await scanManagedDirectory(outside, [allowed])).error).toBe("outside_allowed_roots");
    expect((await scanManagedDirectory(path.join(root, "linked"), [root])).error).toBe("not_a_real_directory");
  });
});
