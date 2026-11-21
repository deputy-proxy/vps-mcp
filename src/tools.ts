import os from "node:os";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { config } from "./config.js";
import { VERSION } from "./version.js";
import { executeCommand, startExecution, getExecutionStatus, getExecutionLogs, cancelExecution } from "./executions.js";
import { listDirectory, readFile, writeFile } from "./filesystem.js";
import { isRuntimeOperation, runRuntimeOperation } from "./runtime.js";
import { applyRepositoryBranchPolicy, fetchRepository, inspectRepository, listRepositories, registerRepository, removeRepository, updateRepository, validateRepository } from "./repositories.js";
import { validateTaskBranchCreation } from "./branch-policy.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
};

function result(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown error";
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }], isError: true };
}

async function safely<T>(operation: () => Promise<T>) {
  try { return result(await operation()); } catch (error) { return failure(error); }
}

async function guarded<T extends ToolResult>(operation: () => Promise<T>): Promise<T> {
  return operation();
}

export function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: "vps-mcp", version: VERSION },
    { instructions: "Authenticated VPS administration and development execution. Filesystem tool paths and command working directories are restricted to configured allowed roots. Shell commands otherwise have the operating-system permissions of the unprivileged service account." },
  );

  server.registerTool("system.health", {
    title: "System health",
    description: "Check MCP service health, data directory writability and configured filesystem roots.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {},
  }, async () => guarded(() => safely(async () => {
    await fs.access(config.dataDir, constants.R_OK | constants.W_OK);
    return { status: "healthy", service: "vps-mcp", version: VERSION, uptimeSeconds: Math.floor(process.uptime()), dataDirectoryWritable: true, allowedRoots: config.allowedRoots };
  })));

  server.registerTool("system.info", {
    title: "System information",
    description: "Return non-secret VPS operating system, CPU, memory, load and disk information.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {},
  }, async () => guarded(() => safely(async () => {
    const disk = await fs.statfs(config.dataDir);
    const totalDiskBytes = Number(disk.blocks) * Number(disk.bsize);
    const freeDiskBytes = Number(disk.bavail) * Number(disk.bsize);
    return {
      hostname: os.hostname(), platform: os.platform(), release: os.release(), architecture: os.arch(),
      nodeVersion: process.version, cpuCount: os.cpus().length, cpuModel: os.cpus()[0]?.model ?? "unknown",
      totalMemoryBytes: os.totalmem(), freeMemoryBytes: os.freemem(), loadAverage: os.loadavg(),
      uptimeSeconds: os.uptime(), processUptimeSeconds: process.uptime(),
      dataFilesystem: { totalBytes: totalDiskBytes, freeBytes: freeDiskBytes },
      allowedRoots: config.allowedRoots,
    };
  })));

  server.registerTool("terminal.execute", {
    title: "Execute command",
    description: "Run a Bash command synchronously as the unprivileged MCP service user. The working directory must be inside MCP_ALLOWED_ROOTS. Maximum timeout and output are server-configured.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      command: z.string().min(1).max(20_000),
      cwd: z.string().optional(),
      timeoutMs: z.number().int().positive().max(900_000).optional(),
      maxOutputBytes: z.number().int().positive().max(1_048_576).optional(),
    },
  }, async ({ command, cwd, timeoutMs, maxOutputBytes }) => guarded(() => safely(() => executeCommand({ command, ...(cwd ? { cwd } : {}), ...(timeoutMs ? { timeoutMs } : {}), ...(maxOutputBytes ? { maxOutputBytes } : {}) }))));

  server.registerTool("terminal.start", {
    title: "Start background command",
    description: "Start a detached Bash command and persist its execution metadata and combined output log.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    inputSchema: { command: z.string().min(1).max(20_000), cwd: z.string().optional() },
  }, async ({ command, cwd }) => guarded(() => safely(() => startExecution({ command, ...(cwd ? { cwd } : {}) }))));

  server.registerTool("terminal.status", {
    title: "Execution status",
    description: "Inspect a background execution by its execution ID.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { executionId: z.string().uuid() },
  }, async ({ executionId }) => guarded(() => safely(() => getExecutionStatus(executionId))));

  server.registerTool("terminal.logs", {
    title: "Execution logs",
    description: "Read the most recent output from a background execution.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { executionId: z.string().uuid(), maxBytes: z.number().int().positive().max(262_144).optional() },
  }, async ({ executionId, maxBytes }) => guarded(() => safely(() => getExecutionLogs(executionId, maxBytes))));

  server.registerTool("terminal.cancel", {
    title: "Cancel execution",
    description: "Send SIGTERM to a background execution process group.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    inputSchema: { executionId: z.string().uuid() },
  }, async ({ executionId }) => guarded(() => safely(() => cancelExecution(executionId))));

  server.registerTool("runtime.acceptance", {
    title: "Rootless runtime acceptance",
    description: "Run fixed rootless Podman diagnostics or the isolated live acceptance suite through the narrowly scoped vps-sandboxctl helper. This does not expose arbitrary root commands or enable application workloads.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { operation: z.enum(["preflight", "info", "smoke", "acceptance"]) },
  }, async ({ operation }) => guarded(() => safely(async () => {
    if (!isRuntimeOperation(operation)) throw new Error("Unsupported runtime operation");
    return await runRuntimeOperation(operation);
  })));

  server.registerTool("filesystem.list", {
    title: "List directory",
    description: "List a directory within configured allowed roots. Symlinks resolving outside allowed roots are omitted.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { path: z.string().min(1) },
  }, async ({ path }) => guarded(() => safely(() => listDirectory(path))));

  server.registerTool("filesystem.read", {
    title: "Read file",
    description: "Read a UTF-8 file up to 2 MiB from configured allowed roots.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { path: z.string().min(1) },
  }, async ({ path }) => guarded(() => safely(() => readFile(path))));

  server.registerTool("filesystem.write", {
    title: "Write file",
    description: "Atomically create or replace a UTF-8 file up to 2 MiB inside configured allowed roots.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    inputSchema: { path: z.string().min(1), content: z.string().max(2 * 1024 * 1024) },
  }, async ({ path, content }) => guarded(() => safely(() => writeFile(path, content))));

  server.registerTool("repository.register", {
    title: "Register repository",
    description: "Register a canonical GitHub repository in the persistent managed registry. Inspects remote branches and active branch rulesets, returning safe remediation and governance status. Never creates or changes branches. Git credentials are not stored.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      remoteUrl: z.string().min(1).max(500),
      developmentHostname: z.string().max(253).optional(),
      languageProfile: z.string().max(100).optional(),
      policyReferences: z.array(z.string().min(1).max(500)).max(30).optional(),
      requiredStatusChecks: z.array(z.string().min(1).max(200)).min(1).max(20).optional(),
    },
  }, async (input) => guarded(() => safely(() => registerRepository(input))));

  server.registerTool("repository.list", {
    title: "List repositories",
    description: "List all registered repositories and their persistent metadata.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {},
  }, async () => guarded(() => safely(() => listRepositories())));

  server.registerTool("repository.inspect", {
    title: "Inspect repository",
    description: "Inspect remote branch policy, cache integrity and size, linked worktrees, persistent environments and health indicators.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: { id: z.string().min(1).max(200) },
  }, async ({ id }) => guarded(() => safely(() => inspectRepository(id))));

  server.registerTool("repository.update", {
    title: "Update repository metadata",
    description: "Update repository hostname, language/toolchain profile, policy references, required GitHub status-check contexts or protected persistent environment paths. Paths must be within configured allowed roots.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      id: z.string().min(1).max(200),
      remoteUrl: z.string().min(1).max(500).optional(),
      developmentHostname: z.string().max(253).optional(),
      languageProfile: z.string().max(100).optional(),
      policyReferences: z.array(z.string().min(1).max(500)).max(30).optional(),
      requiredStatusChecks: z.array(z.string().min(1).max(200)).min(1).max(20).optional(),
      persistentEnvironmentPaths: z.array(z.string().min(1).max(4096)).max(30).optional(),
      requiredBackupPaths: z.array(z.string().min(1).max(4096)).max(30).optional(),
    },
  }, async (input) => guarded(() => safely(() => updateRepository(input))));

  server.registerTool("repository.validate", {
    title: "Validate repository",
    description: "Validate the canonical remote, required main/development branches, active branch rulesets, remote reachability, cache integrity and configured resource limits.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: { id: z.string().min(1).max(200) },
  }, async ({ id }) => guarded(() => safely(() => validateRepository(id))));

  server.registerTool("repository.branch-policy.inspect", {
    title: "Inspect branch governance",
    description: "Inspect active GitHub rulesets applying to main and development. Reports compliant, non-compliant or unavailable; missing API access is never treated as protection.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: { id: z.string().min(1).max(200) },
  }, async ({ id }) => guarded(() => safely(async () => (await inspectRepository(id)).branchPolicy)));

  server.registerTool("repository.branch-policy.apply", {
    title: "Apply branch governance",
    description: "Create the managed GitHub ruleset for main and development. Defaults to a dry-run plan. Set confirm=true to apply; requires REPOSITORY_GITHUB_TOKEN with Administration: write. Never creates or repoints branches and never overwrites an existing ruleset.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    inputSchema: { id: z.string().min(1).max(200), confirm: z.boolean().default(false) },
  }, async ({ id, confirm }) => guarded(() => safely(() => applyRepositoryBranchPolicy(id, confirm))));

  server.registerTool("repository.task-branch.validate", {
    title: "Validate task branch",
    description: "Preflight a task branch name and enforce development as its base. Task/worktree creation must call the same validator before creating a branch or workspace.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { branchName: z.string().min(1).max(255), baseBranch: z.string().min(1).max(255).default("development") },
  }, async ({ branchName, baseBranch }) => guarded(() => safely(async () => validateTaskBranchCreation({ branchName, baseBranch }))));

  server.registerTool("repository.fetch", {
    title: "Fetch repository cache",
    description: "Clone or fetch the persistent bare Git cache. Fetch updates remote-tracking refs only and never checks out, resets, cleans or mutates a branch or worktree. Uses bounded Git execution and per-service registry locking.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: { id: z.string().min(1).max(200) },
  }, async ({ id }) => guarded(() => safely(() => fetchRepository(id))));

  server.registerTool("repository.remove", {
    title: "Remove repository",
    description: "Dry-run or remove a managed repository and its bare cache. Removal is refused when linked worktrees or existing registered persistent environments remain. Set dryRun=false to perform removal.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    inputSchema: { id: z.string().min(1).max(200), dryRun: z.boolean().default(true) },
  }, async ({ id, dryRun }) => guarded(() => safely(() => removeRepository({ id, dryRun }))));

  return server;
}
