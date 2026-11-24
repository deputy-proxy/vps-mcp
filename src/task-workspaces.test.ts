import { afterAll, beforeAll, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const paths = vi.hoisted(() => ({
  remotePath: "",
  spawnedGitEnvironments: [] as Array<Record<string, string | undefined>>,
  aclCalls: [] as Array<{ command: string; args: string[] }>,
}));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: (command: string, args?: readonly string[], options?: Parameters<typeof actual.execFileSync>[2]) => {
      if (command === "/usr/bin/setfacl" || command === "/usr/bin/find") {
        paths.aclCalls.push({ command, args: [...(args ?? [])] });
        return "";
      }
      return actual.execFileSync(command, args, options);
    },
    spawn: (command: string, args: string[], options: Parameters<typeof actual.spawn>[2]) => {
      if (command === "git") paths.spawnedGitEnvironments.push({ ...(options?.env ?? {}) });
      return actual.spawn(
        command,
        args.map((argument) => argument === "https://github.com/acme/workspace-demo.git" ? paths.remotePath : argument === "protocol.file.allow=never" ? "protocol.file.allow=always" : argument),
        options,
      );
    },
  };
});

const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "vps-mcp-task-workspaces-"));
const remotePath = path.join(temporaryDirectory, "remote.git");
const sourcePath = path.join(temporaryDirectory, "source");
process.env.MCP_DATA_DIR = path.join(temporaryDirectory, "data");
process.env.MCP_ALLOWED_ROOTS = temporaryDirectory;
process.env.MCP_AUTH_TOKEN = "test-token-with-at-least-32-characters";
process.env.REPOSITORY_DEV_HOST_SUFFIX = ".dev.example.test";
paths.remotePath = remotePath;
const rules = [
  { type: "deletion" }, { type: "non_fast_forward" },
  { type: "pull_request", parameters: { required_approving_review_count: 1, dismiss_stale_reviews_on_push: true } },
  { type: "required_status_checks", parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: "quality" }] } },
];
vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(rules), { status: 200 })));

const { registerRepository, fetchRepository } = await import("./repositories.js");
const {
  createTaskWorkspace, listTaskWorkspaces, inspectTaskWorkspace, getTaskWorkspaceDiff,
  getTaskWorkspaceStatus, prepareTaskWorkspaceForRuntime, retainTaskWorkspace, resumeTaskWorkspace, removeTaskWorkspace, pruneTaskWorkspaces,
} = await import("./task-workspaces.js");

function git(args: string[], cwd?: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } }).trim();
}

let repositoryId = "";
let developmentSha = "";
beforeAll(async () => {
  git(["init", "--bare", remotePath]);
  await fs.mkdir(sourcePath);
  git(["init", "-b", "main"], sourcePath);
  git(["config", "user.name", "Workspace Tests"], sourcePath);
  git(["config", "user.email", "tests@example.invalid"], sourcePath);
  await fs.writeFile(path.join(sourcePath, "README.md"), "main content\n");
  git(["add", "README.md"], sourcePath);
  git(["commit", "-m", "main"], sourcePath);
  git(["remote", "add", "origin", remotePath], sourcePath);
  git(["push", "-u", "origin", "main"], sourcePath);
  git(["switch", "-c", "development"], sourcePath);
  await fs.writeFile(path.join(sourcePath, "README.md"), "development content\n");
  git(["commit", "-am", "development"], sourcePath);
  git(["push", "-u", "origin", "development"], sourcePath);
  git(["--git-dir", remotePath, "symbolic-ref", "HEAD", "refs/heads/main"]);
  developmentSha = git(["rev-parse", "HEAD"], sourcePath);
  const registered = await registerRepository({ remoteUrl: "https://github.com/acme/workspace-demo" });
  repositoryId = registered.id;
  await fetchRepository(repositoryId);
});
afterAll(async () => { vi.unstubAllGlobals(); await fs.rm(temporaryDirectory, { recursive: true, force: true }); });

it("creates unique isolated worktrees from development and persists metadata", async () => {
  await expect(createTaskWorkspace({ repositoryId, taskId: "Implement a dashboard" })).rejects.toThrow("stable identifier, not a task title");
  const injectedKeys = [
    "OPENAI_API_KEY", "AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN", "REPOSITORY_GITHUB_TOKEN", "CUSTOM_SECRET",
    "GIT_DIR", "GIT_CONFIG_COUNT", "SSH_AUTH_SOCK", "SSH_AGENT_PID",
  ] as const;
  const originalEnvironment = Object.fromEntries(injectedKeys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    OPENAI_API_KEY: "synthetic-openai-key",
    AWS_SECRET_ACCESS_KEY: "synthetic-aws-secret",
    GITHUB_TOKEN: "synthetic-github-token",
    REPOSITORY_GITHUB_TOKEN: "synthetic-repository-github-token",
    CUSTOM_SECRET: "synthetic-custom-secret",
    GIT_DIR: "/tmp/hostile-git-dir",
    GIT_CONFIG_COUNT: "1",
    SSH_AUTH_SOCK: "/tmp/fake-ssh-agent.sock",
    SSH_AGENT_PID: "98765",
  });
  paths.spawnedGitEnvironments.length = 0;
  const [first, second] = await (async () => {
    try {
      return await Promise.all([
        createTaskWorkspace({ repositoryId, taskId: "issue-100" }),
        createTaskWorkspace({ repositoryId, taskId: "issue-101", sandboxId: "sandbox-101" }),
      ]);
    } finally {
      for (const key of injectedKeys) {
        const value = originalEnvironment[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  })();
  expect(first).toMatchObject({ repositoryId, taskId: "issue-100", baseRef: "development", baseSha: developmentSha, targetPullRequestBranch: "development", status: "active" });
  expect(first.branchName).toMatch(/^task\/issue-100-[a-f0-9]{8}$/);
  expect(second.branchName).toMatch(/^task\/issue-101-[a-f0-9]{8}$/);
  expect(first.id).not.toBe(second.id);
  expect(first.worktreePath).not.toBe(second.worktreePath);
  expect(paths.spawnedGitEnvironments.length).toBeGreaterThan(0);
  for (const env of paths.spawnedGitEnvironments) {
    for (const key of [
      "MCP_AUTH_TOKEN", "OPENAI_API_KEY", "AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN",
      "REPOSITORY_GITHUB_TOKEN", "CUSTOM_SECRET", "GIT_DIR", "GIT_CONFIG_COUNT", "SSH_AUTH_SOCK", "SSH_AGENT_PID",
    ]) {
      expect(env[key]).toBeUndefined();
    }
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
  }
  expect(git(["-C", first.worktreePath, "rev-parse", "HEAD"])).toBe(developmentSha);
  expect(await fs.readFile(path.join(first.worktreePath, "README.md"), "utf8")).toBe("development content\n");
  await fs.writeFile(path.join(first.worktreePath, "README.md"), "first task only\n");
  expect(await fs.readFile(path.join(second.worktreePath, "README.md"), "utf8")).toBe("development content\n");
  expect((await listTaskWorkspaces({ repositoryId })).length).toBe(2);
  await expect(createTaskWorkspace({ repositoryId, taskId: "issue-100" })).rejects.toThrow("already exists");
});

it("retains and resumes dirty work without losing tracked or untracked files", async () => {
  const workspace = await createTaskWorkspace({ repositoryId, taskId: "issue-dirty" });
  await fs.writeFile(path.join(workspace.worktreePath, "README.md"), "local edits\n");
  await fs.writeFile(path.join(workspace.worktreePath, "notes.txt"), "untracked work\n");
  const ignoreFile = path.join(temporaryDirectory, "workspace-ignore");
  await fs.writeFile(ignoreFile, "ignored-output.txt\n");
  git(["-C", workspace.worktreePath, "config", "core.excludesfile", ignoreFile]);
  await fs.writeFile(path.join(workspace.worktreePath, "ignored-output.txt"), "ignored but valuable\n");
  const before = await getTaskWorkspaceStatus(workspace.id);
  expect(before).toMatchObject({ status: "active", exists: true, linked: true, changes: { dirty: true, untracked: 1, ignored: 1 } });
  expect((await getTaskWorkspaceDiff(workspace.id)).untrackedFiles).toEqual(["notes.txt"]);
  expect((await getTaskWorkspaceDiff(workspace.id)).ignoredFiles).toEqual(["ignored-output.txt"]);
  await expect(removeTaskWorkspace({ id: workspace.id, confirm: true })).rejects.toThrow("explicitly request discardChanges");
  await retainTaskWorkspace(workspace.id);
  expect((await inspectTaskWorkspace(workspace.id)).workspace.status).toBe("retained");
  await resumeTaskWorkspace(workspace.id);
  expect((await getTaskWorkspaceStatus(workspace.id)).status).toBe("active");
  expect(await fs.readFile(path.join(workspace.worktreePath, "README.md"), "utf8")).toBe("local edits\n");
  expect(await fs.readFile(path.join(workspace.worktreePath, "notes.txt"), "utf8")).toBe("untracked work\n");
  expect(await fs.readFile(path.join(workspace.worktreePath, "ignored-output.txt"), "utf8")).toBe("ignored but valuable\n");
  await expect(removeTaskWorkspace({ id: workspace.id, confirm: true, discardChanges: true })).resolves.toMatchObject({ removed: true, discardedChanges: true });
  expect(await fs.access(workspace.worktreePath).then(() => true).catch(() => false)).toBe(false);
  expect((await listTaskWorkspaces({ repositoryId, includeRemoved: true })).find((item) => item.id === workspace.id)?.status).toBe("removed");
});

it("cleans a missing worktree registration without touching another workspace", async () => {
  const missing = await createTaskWorkspace({ repositoryId, taskId: "issue-missing-worktree" });
  const survivor = await createTaskWorkspace({ repositoryId, taskId: "issue-survivor" });
  await fs.rm(missing.worktreePath, { recursive: true, force: true });
  await expect(removeTaskWorkspace({ id: missing.id, confirm: true })).resolves.toMatchObject({ removed: true, worktreeMissing: true, staleGitRegistrationPruned: true });
  expect((await getTaskWorkspaceStatus(survivor.id)).status).toBe("active");
});

it("requires confirmation, recovers interrupted transitions and prunes only expired clean retained work", async () => {
  const workspace = await createTaskWorkspace({ repositoryId, taskId: "issue-retention", retentionDays: 1 });
  await expect(removeTaskWorkspace({ id: workspace.id, confirm: false })).rejects.toThrow("confirm=true");
  const registryPath = path.join(process.env.MCP_DATA_DIR!, "task-workspaces", "registry.json");
  const registry = JSON.parse(await fs.readFile(registryPath, "utf8")) as { workspaces: Array<Record<string, unknown>> };
  const record = registry.workspaces.find((item) => item.id === workspace.id)!;
  record.status = "creating";
  await fs.writeFile(registryPath, JSON.stringify(registry));
  expect((await inspectTaskWorkspace(workspace.id)).workspace.status).toBe("active");
  const interruptedRemoval = JSON.parse(await fs.readFile(registryPath, "utf8")) as { workspaces: Array<Record<string, unknown>> };
  interruptedRemoval.workspaces.find((item) => item.id === workspace.id)!.status = "removing";
  await fs.writeFile(registryPath, JSON.stringify(interruptedRemoval));
  expect((await inspectTaskWorkspace(workspace.id)).workspace.status).toBe("active");
  await retainTaskWorkspace(workspace.id);
  const updated = JSON.parse(await fs.readFile(registryPath, "utf8")) as { workspaces: Array<Record<string, unknown>> };
  const retained = updated.workspaces.find((item) => item.id === workspace.id)!;
  retained.updatedAt = new Date(Date.now() - 3 * 86_400_000).toISOString();
  (retained.retentionPolicy as { expiresAt: string }).expiresAt = new Date(Date.now() - 2 * 86_400_000).toISOString();
  await fs.writeFile(registryPath, JSON.stringify(updated));
  expect(await pruneTaskWorkspaces({ olderThanDays: 1, dryRun: true })).toMatchObject({ dryRun: true, candidates: [{ id: workspace.id, eligible: true }], removedCount: 0 });
  expect(await pruneTaskWorkspaces({ olderThanDays: 1, dryRun: false, confirm: true })).toMatchObject({ dryRun: false, removedCount: 1 });
  expect((await getTaskWorkspaceStatus(workspace.id)).status).toBe("removed");
});


it("authorizes only a verified registered worktree for the rootless runtime", async () => {
  const workspace = await createTaskWorkspace({ repositoryId, taskId: "issue-runtime-access" });
  paths.aclCalls.length = 0;
  const prepared = await prepareTaskWorkspaceForRuntime(workspace.id);
  expect(prepared).toEqual({
    id: workspace.id,
    repositoryId,
    worktreeId: workspace.id,
    workspacePath: workspace.worktreePath,
  });
  expect(paths.aclCalls).toHaveLength(3);
  expect(paths.aclCalls[0]!.command).toBe("/usr/bin/setfacl");
  expect(paths.aclCalls[0]!.args.slice(0, 2)).toEqual(["-m", "u:vps-sandbox:--x"]);
  expect(paths.aclCalls[0]!.args).toContain(process.env.MCP_DATA_DIR!);
  expect(paths.aclCalls[1]!.command).toBe("/usr/bin/find");
  expect(paths.aclCalls[1]!.args).toEqual([
    workspace.worktreePath, "-uid", String(process.getuid?.() ?? -1), "-exec", "/usr/bin/setfacl", "-m",
    "u:vps-sandbox:rwX", "{}", "+",
  ]);
  expect(paths.aclCalls[2]!.command).toBe("/usr/bin/find");
  expect(paths.aclCalls[2]!.args).toEqual([
    workspace.worktreePath, "-type", "d", "-uid", String(process.getuid?.() ?? -1), "-exec", "/usr/bin/setfacl", "-m",
    "d:u:vps-sandbox:rwX", "{}", "+",
  ]);
  await retainTaskWorkspace(workspace.id);
  await expect(prepareTaskWorkspaceForRuntime(workspace.id)).resolves.toMatchObject({ id: workspace.id });
  await removeTaskWorkspace({ id: workspace.id, confirm: true, discardChanges: true });
  await expect(prepareTaskWorkspaceForRuntime(workspace.id)).rejects.toThrow("Only active or retained");
});


it("refuses symlinked repository paths before granting runtime ACLs", async () => {
  const workspace = await createTaskWorkspace({ repositoryId, taskId: "issue-runtime-symlink" });
  const repositoryDirectory = path.dirname(workspace.worktreePath);
  const backupDirectory = repositoryDirectory + ".backup";
  paths.aclCalls.length = 0;
  await fs.rename(repositoryDirectory, backupDirectory);
  await fs.symlink(backupDirectory, repositoryDirectory, "dir");
  try {
    await expect(prepareTaskWorkspaceForRuntime(workspace.id)).rejects.toThrow("symlink or non-directory");
    expect(paths.aclCalls).toHaveLength(0);
  } finally {
    await fs.rm(repositoryDirectory, { force: true });
    await fs.rename(backupDirectory, repositoryDirectory);
  }
  await removeTaskWorkspace({ id: workspace.id, confirm: true, discardChanges: true });
});
