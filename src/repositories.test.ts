import { afterAll, beforeAll, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const paths = vi.hoisted(() => ({ remotePath: "" }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (command: string, args: string[], options: Parameters<typeof actual.spawn>[2]) => actual.spawn(
      command,
      args.map((argument) => (argument === "https://github.com/acme/demo.git" || argument === "https://github.com/acme/demo-renamed.git") ? paths.remotePath : argument === "protocol.file.allow=never" ? "protocol.file.allow=always" : argument),
      options,
    ),
  };
});

const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "vps-mcp-repositories-"));
const remotePath = path.join(temporaryDirectory, "remote.git");
const sourcePath = path.join(temporaryDirectory, "source");
process.env.MCP_DATA_DIR = path.join(temporaryDirectory, "data");
process.env.MCP_ALLOWED_ROOTS = temporaryDirectory;
process.env.MCP_AUTH_TOKEN = "test-token-with-at-least-32-characters";
process.env.REPOSITORY_DEV_HOST_SUFFIX = ".dev.example.test";
paths.remotePath = remotePath;

const { fetchRepository, inspectRepository, listRepositories, parseGitHubRemote, registerRepository, removeRepository, sanitizeGitError, updateRepository, validateRepository } = await import("./repositories.js");

function git(args: string[], cwd?: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } }).trim();
}

beforeAll(async () => {
  git(["init", "--bare", remotePath]);
  await fs.mkdir(sourcePath);
  git(["init", "-b", "main"], sourcePath);
  git(["config", "user.name", "Repository Tests"], sourcePath);
  git(["config", "user.email", "tests@example.invalid"], sourcePath);
  await fs.writeFile(path.join(sourcePath, "README.md"), "main version\n");
  git(["add", "README.md"], sourcePath);
  git(["commit", "-m", "initial"], sourcePath);
  git(["remote", "add", "origin", remotePath], sourcePath);
  git(["push", "-u", "origin", "main"], sourcePath);
  git(["--git-dir", remotePath, "symbolic-ref", "HEAD", "refs/heads/main"]);
  git(["switch", "-c", "development"], sourcePath);
  await fs.writeFile(path.join(sourcePath, "README.md"), "development version\n");
  git(["commit", "-am", "development"], sourcePath);
  git(["push", "-u", "origin", "development"], sourcePath);
});

afterAll(async () => { await fs.rm(temporaryDirectory, { recursive: true, force: true }); });

it("validates, migrates, registers, inspects, fetches and safely removes managed repositories", async () => {
  expect(parseGitHubRemote("https://github.com/acme/demo")).toEqual({ fullName: "acme/demo", remoteUrl: "https://github.com/acme/demo.git", name: "demo" });
  expect(parseGitHubRemote("https://github.com/acme/demo.git").fullName).toBe("acme/demo");
  expect(sanitizeGitError("fatal: https://token:secret@github.com/acme/demo.git denied")).not.toContain("token:secret");
  expect(sanitizeGitError("fatal: https://token:secret@github.com/acme/demo.git denied")).toContain("https://[redacted]@");
  for (const remote of ["file:///etc/passwd", "https://evil.example/acme/demo", "http://github.com/acme/demo", "https://user:pass@github.com/acme/demo", "https://github.com/acme/demo/other", "https://github.com/acme/demo?token=secret"]) {
    expect(() => parseGitHubRemote(remote)).toThrow();
  }

  const registryPath = path.join(process.env.MCP_DATA_DIR!, "repositories", "registry.json");
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  await fs.writeFile(registryPath, JSON.stringify({ repositories: [{ fullName: "acme/demo", remoteUrl: "https://github.com/acme/demo.git", name: "demo" }] }));
  const migrated = await listRepositories();
  expect(migrated.schemaVersion).toBe(1);
  expect(migrated.repositories[0]).toMatchObject({ id: expect.stringMatching(/^acme-demo-[a-f0-9]{10}$/), requiredBranches: ["main", "development"], status: "registered" });
  await fs.rm(registryPath);

  const registered = await registerRepository({ remoteUrl: "https://github.com/acme/demo", languageProfile: "node-22" });
  expect(registered).toMatchObject({ fullName: "acme/demo", defaultBranch: "main", developmentHostname: "demo.dev.example.test" });
  expect(registered.remote.missingRequiredBranches).toEqual([]);
  expect((await listRepositories()).count).toBe(1);
  const escapedLink = path.join(temporaryDirectory, "outside-link");
  await fs.symlink("/tmp", escapedLink);
  await expect(updateRepository({ id: registered.id, persistentEnvironmentPaths: [escapedLink] })).rejects.toThrow("outside the configured allowed roots");
  await fs.unlink(escapedLink);

  const fetched = await fetchRepository(registered.id);
  expect(fetched.repository.status).toBe("cloned");
  expect(fetched.cacheBytes).toBeGreaterThan(0);
  expect((await inspectRepository(registered.id)).health).toMatchObject({ requiredBranchesPresent: true, cacheStale: false, branchDrift: [] });
  expect((await validateRepository(registered.id)).valid).toBe(true);
  const persistedRegistry = JSON.parse(await fs.readFile(registryPath, "utf8")) as { repositories: Array<{ lastFetchAt: string }> };
  persistedRegistry.repositories[0]!.lastFetchAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  await fs.writeFile(registryPath, JSON.stringify(persistedRegistry));
  expect((await inspectRepository(registered.id)).health.cacheStale).toBe(true);
  expect((await validateRepository(registered.id)).valid).toBe(false);
  await fetchRepository(registered.id);
  expect((await fs.readFile(registryPath, "utf8"))).not.toMatch(/token|password|secret/i);
  const checkout = path.join(temporaryDirectory, "checkout");
  git(["--git-dir", registered.cachePath, "worktree", "add", checkout, "development"]);
  const beforeHead = git(["rev-parse", "HEAD"], checkout);
  const beforeFile = await fs.readFile(path.join(checkout, "README.md"), "utf8");

  await fs.writeFile(path.join(sourcePath, "README.md"), "new remote version\n");
  git(["commit", "-am", "remote update"], sourcePath);
  git(["push", "origin", "development"], sourcePath);
  expect((await inspectRepository(registered.id)).health.branchDrift).toContain("development");
  const inheritedGitConfig = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE, GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT, GIT_CONFIG_KEY_0: process.env.GIT_CONFIG_KEY_0, GIT_CONFIG_VALUE_0: process.env.GIT_CONFIG_VALUE_0, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM, GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND };
  process.env.GIT_DIR = "/tmp/hostile-git-dir";
  process.env.GIT_WORK_TREE = "/tmp/hostile-worktree";
  process.env.GIT_CONFIG_COUNT = "1";
  process.env.GIT_CONFIG_KEY_0 = "core.worktree";
  process.env.GIT_CONFIG_VALUE_0 = "/tmp/hostile-worktree";
  process.env.GIT_CONFIG_GLOBAL = "/tmp/hostile-gitconfig";
  process.env.GIT_CONFIG_SYSTEM = "/tmp/hostile-gitconfig";
  process.env.GIT_SSH_COMMAND = "touch /tmp/hostile-git-command";
  try { await Promise.all([fetchRepository(registered.id), fetchRepository(registered.id)]); } finally {
    for (const [key, value] of Object.entries(inheritedGitConfig)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
  expect(git(["rev-parse", "HEAD"], checkout)).toBe(beforeHead);
  expect(await fs.readFile(path.join(checkout, "README.md"), "utf8")).toBe(beforeFile);
  expect(await removeRepository({ id: registered.id, dryRun: true })).toMatchObject({ dryRun: true, blockers: [expect.stringContaining("linked worktree")] });
  git(["--git-dir", registered.cachePath, "worktree", "remove", checkout]);

  await updateRepository({ id: registered.id, persistentEnvironmentPaths: [sourcePath] });
  await expect(removeRepository({ id: registered.id, dryRun: false })).rejects.toThrow("persistent environment");
  await updateRepository({ id: registered.id, persistentEnvironmentPaths: [], requiredBackupPaths: [sourcePath] });
  await expect(removeRepository({ id: registered.id, dryRun: false })).rejects.toThrow("required backup");
  await updateRepository({ id: registered.id, persistentEnvironmentPaths: [], requiredBackupPaths: [] });
  const renamedMetadata = await updateRepository({ id: registered.id, remoteUrl: "https://github.com/acme/demo-renamed" });
  expect(renamedMetadata.id).toBe(registered.id);
  expect(renamedMetadata.fullName).toBe("acme/demo-renamed");
  expect(renamedMetadata.remoteUrl).toBe("https://github.com/acme/demo-renamed.git");
  expect(renamedMetadata.developmentHostname).toBe("demo.renamed.dev.example.test");
  await fetchRepository(registered.id);
  const renamedValidation = await validateRepository(registered.id);
  expect(renamedValidation.valid).toBe(true);
  expect(await removeRepository({ id: registered.id, dryRun: false })).toMatchObject({ removed: true });
  expect((await listRepositories()).count).toBe(0);

  git(["switch", "-c", "trunk"], sourcePath);
  await fs.writeFile(path.join(sourcePath, "README.md"), "trunk only\n");
  git(["commit", "-am", "trunk"], sourcePath);
  git(["push", "origin", "trunk"], sourcePath);
  git(["--git-dir", remotePath, "symbolic-ref", "HEAD", "refs/heads/trunk"]);
  git(["push", "origin", ":main"], sourcePath);
  git(["push", "origin", ":development"], sourcePath);
  const nonstandard = await registerRepository({ remoteUrl: "https://github.com/acme/demo" });
  expect(nonstandard.defaultBranch).toBe("trunk");
  expect(nonstandard.remote.missingRequiredBranches).toEqual(["main", "development"]);
  expect((await validateRepository(nonstandard.id)).valid).toBe(false);
  const reachableRemote = paths.remotePath;
  paths.remotePath = path.join(temporaryDirectory, "offline.git");
  expect(await validateRepository(nonstandard.id)).toMatchObject({ valid: false, remoteReachable: false });
  paths.remotePath = reachableRemote;
  expect((await listRepositories()).repositories[0]?.requiredBranches).toEqual(["main", "development"]);
  expect(await removeRepository({ id: nonstandard.id, dryRun: false })).toMatchObject({ removed: true });
}, 15000);
