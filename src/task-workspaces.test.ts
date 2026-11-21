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
      args.map((argument) => argument === "https://github.com/acme/workspace-demo.git" ? paths.remotePath : argument === "protocol.file.allow=never" ? "protocol.file.allow=always" : argument),
      options,
    ),
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
  getTaskWorkspaceStatus, retainTaskWorkspace, resumeTaskWorkspace, removeTaskWorkspace, pruneTaskWorkspaces,
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
  const [first, second] = await Promise.all([
    createTaskWorkspace({ repositoryId, taskId: "issue-100" }),
    createTaskWorkspace({ repositoryId, taskId: "issue-101", sandboxId: "sandbox-101" }),
  ]);
  expect(first).toMatchObject({ repositoryId, taskId: "issue-100", baseRef: "development", baseSha: developmentSha, targetPullRequestBranch: "development", status: "active" });
  expect(first.branchName).toMatch(/^task\/issue-100-[a-f0-9]{8}$/);
  expect(second.branchName).toMatch(/^task\/issue-101-[a-f0-9]{8}$/);
  expect(first.id).not.toBe(second.id);
  expect(first.worktreePath).not.toBe(second.worktreePath);
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
