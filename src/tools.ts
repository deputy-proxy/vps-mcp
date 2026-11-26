import os from "node:os";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { config } from "./config.js";
import { VERSION } from "./version.js";
import { executeCommand } from "./executions.js";
import { listDirectory, readFile, writeFile } from "./filesystem.js";
import { isRuntimeOperation, runRuntimeOperation } from "./runtime.js";
import { applyRepositoryBranchPolicy, fetchRepository, inspectRepository, listRepositories, registerRepository, removeRepository, updateRepository, validateRepository } from "./repositories.js";
import { validateTaskBranchCreation } from "./branch-policy.js";
import { createSandboxRuntimeAdapter, formatSandboxRuntimeError } from "./sandbox-runtime.js";
import { createTaskWorkspace, listTaskWorkspaces, inspectTaskWorkspace, getTaskWorkspaceStatus, getTaskWorkspaceDiff, retainTaskWorkspace, resumeTaskWorkspace, removeTaskWorkspace, pruneTaskWorkspaces } from "./task-workspaces.js";
import { inspectManagedStorage } from "./storage-metrics.js";
import { deprovisionProjectEnvironment, inspectProjectEnvironmentRuntime, inspectProjectEnvironment, listProjectEnvironments, provisionProjectEnvironment, registerProjectEnvironment, setProjectEnvironmentRelease, startProjectEnvironment, stopProjectEnvironment, updateProjectEnvironment } from "./project-environments.js";
import { registerProjectEnvironmentWithReservation } from "./project-environment-admission.js";
import { listServiceProfiles } from "./service-profiles.js";
import { resolveAllowedPath, managedTaskWorkspaceIdentity } from "./paths.js";

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

function sandboxFailure(error: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(formatSandboxRuntimeError(error), null, 2) }], isError: true };
}

async function safelySandbox<T>(operation: () => Promise<T>): Promise<ToolResult> {
  try { return result(await operation()); } catch (error) { return sandboxFailure(error); }
}

async function safely<T>(operation: () => Promise<T>) {
  try { return result(await operation()); } catch (error) { return failure(error); }
}

async function guarded<T extends ToolResult>(operation: () => Promise<T>): Promise<T> {
  return operation();
}

export function createMcpServer(): McpServer {
  const sandboxRuntime = createSandboxRuntimeAdapter();
  const attachedTaskSandbox = async (worktreeId: string) => {
    const { workloads } = await sandboxRuntime.listWorkloads();
    return workloads.find((workload) => workload.workloadType === 'task' && workload.worktreeId === worktreeId && workload.status !== 'removed');
  };
  const retainWorkspaceSafely = async (id: string) => {
    const current = await inspectTaskWorkspace(id);
    const attached = await attachedTaskSandbox(current.workspace.id);
    if (attached) await sandboxRuntime.setTaskSandboxRetention({ sandboxId: attached.id, retained: true });
    try {
      return current.workspace.status === 'retained' ? current : await retainTaskWorkspace(id);
    } catch (error) {
      if (attached) await sandboxRuntime.setTaskSandboxRetention({ sandboxId: attached.id, retained: false }).catch(() => {});
      throw error;
    }
  };
  const resumeWorkspaceSafely = async (id: string) => {
    const current = await inspectTaskWorkspace(id);
    const attached = await attachedTaskSandbox(current.workspace.id);
    if (current.workspace.status === 'active') {
      if (attached) await sandboxRuntime.setTaskSandboxRetention({ sandboxId: attached.id, retained: false });
      return current;
    }
    if (current.workspace.status !== 'retained') throw new Error('Only retained workspaces can be resumed');
    const resumed = await resumeTaskWorkspace(id);
    if (attached) await sandboxRuntime.setTaskSandboxRetention({ sandboxId: attached.id, retained: false });
    return resumed;
  };
  const ensureTaskWorkspaceHasNoSandbox = async (worktreeId: string): Promise<void> => {
    const { workloads } = await sandboxRuntime.listWorkloads();
    const attached = workloads.find((workload) =>
      workload.workloadType === "task" && workload.worktreeId === worktreeId && workload.status !== "removed"
    );
    if (attached) throw new Error("Task workspace is attached to sandbox '" + attached.id + "' (" + attached.status + "); stop and remove the sandbox before removing its worktree");
  };
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
    description: "Atomically create or replace a UTF-8 file up to 2 MiB inside configured allowed roots. Writes to managed task worktrees respect the emergency maintenance pause.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    inputSchema: { path: z.string().min(1), content: z.string().max(2 * 1024 * 1024) },
  }, async ({ path, content }) => guarded(() => safely(async () => {
    const resolved = await resolveAllowedPath(path, { allowMissingLeaf: true });
    const workspace = managedTaskWorkspaceIdentity(resolved);
    if (!workspace) return writeFile(resolved, content);
    const lease = await sandboxRuntime.beginWorkspaceWrite(workspace);
    try {
      return await writeFile(resolved, content);
    } finally {
      await sandboxRuntime.finishWorkspaceWrite(lease.leaseId).catch(() => {});
    }
  })));

  server.registerTool("sandbox.image.inspect", {
    title: "Inspect approved sandbox image",
    description: "Inspect an administrator-allowlisted, SHA-256 digest-pinned image. Images not present in the runtime allowlist are rejected.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { image: z.string().min(1).max(255) },
  }, async ({ image }) => guarded(() => safelySandbox(() => sandboxRuntime.inspectImage(image))));

  server.registerTool("sandbox.image.pull", {
    title: "Pull approved sandbox image",
    description: "Pull an administrator-allowlisted, SHA-256 digest-pinned image. No mutable tags or unapproved images are accepted.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: { image: z.string().min(1).max(255) },
  }, async ({ image }) => guarded(() => safelySandbox(() => sandboxRuntime.pullImage(image))));

  server.registerTool("sandbox.create", {
    title: "Create task sandbox",
    description: "Create a rootless task container for an existing registered task workspace. The runtime verifies the exact workspace identity and grants access only to that worktree. The image must be digest-pinned and administrator-allowlisted. Task containers run as the mapped non-root runtime user with an explicit seccomp profile, no network egress, a read-only root filesystem, dropped capabilities, bounded CPU/memory/PID limits and a monitored workspace disk budget. Returns a distinct sandboxId; it is not the task-workspace ID.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      repositoryId: z.string().min(1).max(200),
      worktreeId: z.string().uuid(),
      image: z.string().min(1).max(255),
      resources: z.object({
        cpuMilli: z.number().int().min(100).max(2000).optional(),
        memoryMiB: z.number().int().min(128).max(4096).optional(),
        pids: z.number().int().min(32).max(512).optional(),
        diskMiB: z.number().int().min(128).max(102400).optional(),
      }).strict().optional(),
      workspaceAccess: z.enum(["read-only", "read-write"]).default("read-write"),
      command: z.array(z.string().min(1).max(4096)).min(1).max(64).optional(),
    },
  }, async ({ repositoryId, worktreeId, image, resources, workspaceAccess, command }) => guarded(() => safelySandbox(async () => {
    const workload = await sandboxRuntime.createTaskSandbox({
      repositoryId, worktreeId, image, workspaceAccess,
      ...(resources ? { resources: {
        cpuMilli: resources.cpuMilli ?? 500,
        memoryMiB: resources.memoryMiB ?? 512,
        pids: resources.pids ?? 64,
        diskMiB: resources.diskMiB ?? 2048,
      } } : {}),
      ...(command ? { command } : {}),
    });
    return { sandboxId: workload.id, workload };
  })));

  server.registerTool("sandbox.start", {
    title: "Start task sandbox",
    description: "Start a task workload by its sandbox ID. Project-service workloads are rejected.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    inputSchema: { sandboxId: z.string().uuid() },
  }, async ({ sandboxId }) => guarded(() => safelySandbox(async () => ({
    sandboxId,
    result: await sandboxRuntime.startTaskSandbox(sandboxId),
  }))));

  server.registerTool("sandbox.inspect", {
    title: "Inspect task sandbox",
    description: "Inspect a task sandbox and reconcile its durable record with the rootless container runtime. Project-service workloads are not exposed.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { sandboxId: z.string().uuid() },
  }, async ({ sandboxId }) => guarded(() => safelySandbox(async () => ({
    sandboxId,
    result: await sandboxRuntime.inspectTaskSandbox(sandboxId),
  }))));

  server.registerTool("sandbox.list", {
    title: "List task sandboxes",
    description: "List task workloads only. Persistent project-service workloads are excluded.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {},
  }, async () => guarded(() => safelySandbox(async () => {
    const { workloads } = await sandboxRuntime.listTaskSandboxes();
    return { workloads: workloads.map((workload) => ({ sandboxId: workload.id, ...workload })) };
  })));

  server.registerTool("sandbox.stop", {
    title: "Stop task sandbox",
    description: "Stop a task workload by its sandbox ID. Project-service workloads are rejected.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    inputSchema: { sandboxId: z.string().uuid() },
  }, async ({ sandboxId }) => guarded(() => safelySandbox(async () => ({
    sandboxId,
    result: await sandboxRuntime.stopTaskSandbox(sandboxId),
  }))));

  server.registerTool("sandbox.remove", {
    title: "Remove task sandbox",
    description: "Force-remove only a task workload. Requires confirm=true. The associated task workspace and its files are preserved.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    inputSchema: { sandboxId: z.string().uuid(), confirm: z.boolean() },
  }, async ({ sandboxId, confirm }) => guarded(() => safelySandbox(async () => {
    if (!confirm) throw new Error("Sandbox removal requires confirm=true");
    return { sandboxId, result: await sandboxRuntime.removeTaskSandbox(sandboxId) };
  })));

  server.registerTool("sandbox.logs", {
    title: "Read task sandbox logs",
    description: "Read bounded runtime logs for a task sandbox. Project-service workload logs are not exposed.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { sandboxId: z.string().uuid() },
  }, async ({ sandboxId }) => guarded(() => safelySandbox(async () => ({
    sandboxId,
    ...(await sandboxRuntime.readTaskSandboxLogs(sandboxId)),
  }))));

  server.registerTool("sandbox.exec", {
    title: "Execute in task sandbox",
    description: "Execute an argument-array command inside the selected running task sandbox. Requires its sandbox ID; never falls back to host execution. Supply a stable operationId UUID when retrying so completed results are replayed rather than executing twice. cwd is workspace-relative, environment overrides are allowlisted, and timeout/output/concurrency are bounded.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      sandboxId: z.string().uuid(),
      operationId: z.string().uuid().optional(),
      command: z.array(z.string().min(1).max(4096)).min(1).max(64),
      cwd: z.string().max(4096).optional(),
      timeoutMs: z.number().int().min(1000).max(120_000).optional(),
      maxOutputBytes: z.number().int().min(1024).max(1_048_576).optional(),
      env: z.record(z.string(), z.string().max(256)).optional(),
    },
  }, async ({ sandboxId, operationId, command, cwd, timeoutMs, maxOutputBytes, env }) => guarded(() => safelySandbox(() => sandboxRuntime.executeTaskSandbox({ sandboxId, ...(operationId ? { operationId } : {}), command, ...(cwd !== undefined ? { cwd } : {}), ...(timeoutMs !== undefined ? { timeoutMs } : {}), ...(maxOutputBytes !== undefined ? { maxOutputBytes } : {}), ...(env !== undefined ? { env } : {}) }))));

  server.registerTool("sandbox.filesystem.list", {
    title: "List task sandbox files",
    description: "List regular files and directories inside the selected task sandbox workspace. Symlinks and special files are omitted; paths are workspace-relative.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { sandboxId: z.string().uuid(), path: z.string().max(4096).default("") },
  }, async ({ sandboxId, path }) => guarded(() => safelySandbox(() => sandboxRuntime.listTaskSandboxFiles({ sandboxId, path }))));

  server.registerTool("sandbox.filesystem.read", {
    title: "Read task sandbox file",
    description: "Read a UTF-8 regular file up to 2 MiB from the selected task sandbox workspace. Symlinks and paths outside the workspace are rejected.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { sandboxId: z.string().uuid(), path: z.string().min(1).max(4096) },
  }, async ({ sandboxId, path }) => guarded(() => safelySandbox(() => sandboxRuntime.readTaskSandboxFile({ sandboxId, path }))));

  server.registerTool("sandbox.filesystem.write", {
    title: "Write task sandbox file",
    description: "Atomically create or replace a UTF-8 file up to 1 MiB inside the selected task sandbox workspace. Parent directories must already exist; symlinks and paths outside the workspace are rejected.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    inputSchema: { sandboxId: z.string().uuid(), path: z.string().min(1).max(4096), content: z.string().max(1024 * 1024) },
  }, async ({ sandboxId, path, content }) => guarded(() => safelySandbox(() => sandboxRuntime.writeTaskSandboxFile({ sandboxId, path, content }))));

  server.registerTool("sandbox.execution.start", {
    title: "Start background task execution",
    description: "Start a durable background command inside the selected running task sandbox. Supply a stable executionId UUID when retrying so an existing execution is returned instead of started twice. Command arguments are not persisted; only a redacted executable summary and fingerprint are stored. Execution timeout, log size, concurrency and disk quotas are enforced.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      sandboxId: z.string().uuid(),
      executionId: z.string().uuid().optional(),
      command: z.array(z.string().min(1).max(4096)).min(1).max(64),
      cwd: z.string().max(4096).optional(),
      timeoutMs: z.number().int().min(1000).max(86_400_000).optional(),
    },
  }, async ({ sandboxId, executionId, command, cwd, timeoutMs }) => guarded(() => safelySandbox(() => sandboxRuntime.startTaskSandboxExecution({
    sandboxId, ...(executionId ? { executionId } : {}), command, ...(cwd !== undefined ? { cwd } : {}), ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  }))));

  server.registerTool("sandbox.execution.list", {
    title: "List task sandbox executions",
    description: "List recent durable executions belonging only to the selected task sandbox. Project-service workloads and executions from other sandboxes are never included.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { sandboxId: z.string().uuid() },
  }, async ({ sandboxId }) => guarded(() => safelySandbox(() => sandboxRuntime.listTaskSandboxExecutions(sandboxId))));

  server.registerTool("sandbox.execution.status", {
    title: "Inspect task execution status",
    description: "Reconcile one execution's durable record against its process identity inside the selected task sandbox. After restart, missing or indeterminate processes are reported honestly rather than inferred from reusable host PIDs.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { sandboxId: z.string().uuid(), executionId: z.string().uuid() },
  }, async ({ sandboxId, executionId }) => guarded(() => safelySandbox(() => sandboxRuntime.getTaskSandboxExecutionStatus({ sandboxId, executionId }))));

  server.registerTool("sandbox.execution.logs", {
    title: "Read task execution logs",
    description: "Read bounded persistent logs for one execution. Without offset, returns the latest bytes; with offset, supports incremental reads. Logs have a seven-day retention period and explicit truncation/continuation metadata.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      sandboxId: z.string().uuid(),
      executionId: z.string().uuid(),
      offset: z.number().int().min(0).optional(),
      maxBytes: z.number().int().min(1024).max(262_144).optional(),
    },
  }, async ({ sandboxId, executionId, offset, maxBytes }) => guarded(() => safelySandbox(() => sandboxRuntime.getTaskSandboxExecutionLogs({
    sandboxId, executionId, ...(offset !== undefined ? { offset } : {}), ...(maxBytes !== undefined ? { maxBytes } : {}),
  }))));

  server.registerTool("sandbox.execution.cancel", {
    title: "Cancel task execution",
    description: "Gracefully terminate only the selected execution process group inside its owning task sandbox, then escalate to SIGKILL after a bounded grace period. Never signals host PIDs or project-service workloads.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: { sandboxId: z.string().uuid(), executionId: z.string().uuid() },
  }, async ({ sandboxId, executionId }) => guarded(() => safelySandbox(() => sandboxRuntime.cancelTaskSandboxExecution({ sandboxId, executionId }))));

  server.registerTool("resource.capacity", {
    title: "Inspect workload capacity",
    description: "Inspect global and per-repository CPU, memory, PID and disk reservations, active task counts, container storage and the host disk safety margin. This is a private operational view.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {},
  }, async () => guarded(() => safely(async () => {
    const [runtime, repositories] = await Promise.all([sandboxRuntime.inspectResourceCapacity(), listRepositories()]);
    const managedStorage = await inspectManagedStorage(repositories.repositories, config.dataDir, config.allowedRoots);
    return { ...runtime, managedStorage };
  })));

  server.registerTool("resource.reserve", {
    title: "Reserve project resources",
    description: "Create or replace a durable per-repository resource reservation for a future persistent development environment. Reservations are enforced against global and per-repository capacity before task workloads are admitted.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      repositoryId: z.string().min(2).max(200),
      resources: z.object({
        cpuMilli: z.number().int().min(100).max(2000),
        memoryMiB: z.number().int().min(128).max(4096),
        pids: z.number().int().min(32).max(512),
        diskMiB: z.number().int().min(128).max(102400).optional(),
      }).strict(),
    },
  }, async ({ repositoryId, resources }) => guarded(() => safelySandbox(() => sandboxRuntime.reserveProjectResources({ repositoryId, resources: { cpuMilli: resources.cpuMilli, memoryMiB: resources.memoryMiB, pids: resources.pids, ...(resources.diskMiB !== undefined ? { diskMiB: resources.diskMiB } : {}) } }))));

  server.registerTool("resource.release", {
    title: "Release project resource reservation",
    description: "Release the durable resource reservation for a repository after its persistent project environment has been deprovisioned.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: { repositoryId: z.string().min(2).max(200) },
  }, async ({ repositoryId }) => guarded(() => safelySandbox(() => sandboxRuntime.releaseProjectResources(repositoryId))));

  server.registerTool("sandbox.cleanup.preview", {
    title: "Preview expired sandbox cleanup",
    description: "Preview expired task containers, terminal orphan task containers, stale lock directories and eligible temporary files. Persistent project-service containers, running/unknown orphans, retained sandboxes and worktree files are protected.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {},
  }, async () => guarded(() => safelySandbox(() => sandboxRuntime.previewSandboxCleanup())));

  server.registerTool("sandbox.cleanup.run", {
    title: "Run expired sandbox cleanup",
    description: "Run a dry-run cleanup by default. Actual cleanup requires dryRun=false and confirm=true. Removes only expired task containers and eligible terminal orphan task containers, then reaps stale locks and old atomic-write temporary files. Project services and worktree contents are never removed.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    inputSchema: { dryRun: z.boolean().default(true), confirm: z.boolean().default(false) },
  }, async ({ dryRun, confirm }) => guarded(() => safelySandbox(() => sandboxRuntime.runSandboxCleanup({ dryRun, confirm }))));

  server.registerTool("sandbox.maintenance.pause", {
    title: "Emergency workload pause",
    description: "Pause or resume new sandbox creation, starts, command execution and writes to managed task worktrees, including generic filesystem.write requests. Existing workloads can still be stopped or removed. Automatic cleanup is also suspended while paused.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: { paused: z.boolean() },
  }, async ({ paused }) => guarded(() => safelySandbox(() => sandboxRuntime.setMaintenancePause(paused))));

  server.registerTool("sandbox.audit.list", {
    title: "Read runtime audit events",
    description: "Read recent private lifecycle, resource-governance, cleanup and maintenance audit events. Sensitive token patterns are redacted and command arguments are not recorded.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { limit: z.number().int().min(1).max(500).default(100) },
  }, async ({ limit }) => guarded(() => safelySandbox(() => sandboxRuntime.listRuntimeAudit(limit))));

  server.registerTool("project-environment.profile.list", {
    title: "List project environment service profiles",
    description: "List versioned framework-neutral service profile definitions and their readiness. Definition-only profiles cannot be provisioned; no runtime or resource state is changed.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { includeDefinitionOnly: z.boolean().default(true) },
  }, async ({ includeDefinitionOnly }) => guarded(() => safely(async () => listServiceProfiles({ includeDefinitionOnly }))));

  server.registerTool("project-environment.list", {
    title: "List persistent project environments",
    description: "List durable per-repository development environment records. This is metadata only; it does not start, stop, deploy or modify project workloads.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { repositoryId: z.string().min(2).max(200).optional() },
  }, async ({ repositoryId }) => guarded(() => safely(() => listProjectEnvironments(repositoryId ? { repositoryId } : {}))));

  server.registerTool("project-environment.inspect", {
    title: "Inspect persistent project environment",
    description: "Inspect the durable environment record and its isolated data-path plan for one registered repository. Does not expose secret values or change runtime state.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { repositoryId: z.string().min(2).max(200) },
  }, async ({ repositoryId }) => guarded(() => safely(() => inspectProjectEnvironment(repositoryId))));

  server.registerTool("project-environment.register", {
    title: "Register persistent project environment",
    description: "Create an idempotent durable metadata record for a registered repository and reserve its profile resource vector through the resource-governance API. This does not provision or start containers; provisioning remains gated pending an approved deployable profile with a pinned runtime image digest.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      repositoryId: z.string().min(2).max(200),
      profileId: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
      profileVersion: z.number().int().min(1).max(1000).optional(),
      resources: z.object({
        cpuMilli: z.number().int().min(100).max(2000).optional(),
        memoryMiB: z.number().int().min(128).max(4096).optional(),
        pids: z.number().int().min(32).max(512).optional(),
        diskMiB: z.number().int().min(128).max(102400).optional(),
      }).strict().optional(),
    },
  }, async ({ repositoryId, profileId, profileVersion, resources }) => guarded(() => safelySandbox(() => registerProjectEnvironmentWithReservation({
    repositoryId, profileId,
    ...(profileVersion !== undefined ? { profileVersion } : {}),
    ...(resources !== undefined ? { resources: {
      ...(resources.cpuMilli !== undefined ? { cpuMilli: resources.cpuMilli } : {}),
      ...(resources.memoryMiB !== undefined ? { memoryMiB: resources.memoryMiB } : {}),
      ...(resources.pids !== undefined ? { pids: resources.pids } : {}),
      ...(resources.diskMiB !== undefined ? { diskMiB: resources.diskMiB } : {}),
    } } : {}),
  }, {
    register: registerProjectEnvironment,
    reserve: (input) => sandboxRuntime.reserveProjectResources(input),
    update: updateProjectEnvironment,
  }))));

  server.registerTool("project-environment.release.set", {
    title: "Select persistent project release",
    description: "Register an existing canonical release directory as the active or candidate project release. This does not build, copy or modify release files and does not change a running workload.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { repositoryId: z.string().min(2).max(200), releaseId: z.string().uuid(), channel: z.enum(["active", "candidate"]) },
  }, async ({ repositoryId, releaseId, channel }) => guarded(() => safelySandbox(() => setProjectEnvironmentRelease({ repositoryId, releaseId, channel }))));

  server.registerTool("project-environment.provision", {
    title: "Provision persistent project service",
    description: "Create the repository's persistent project-service workload from its active or candidate release. Requires a deployable profile pinned to an administrator-approved immutable image digest and canonical project data mounts. Does not start the service.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { repositoryId: z.string().min(2).max(200) },
  }, async ({ repositoryId }) => guarded(() => safelySandbox(() => provisionProjectEnvironment(repositoryId, sandboxRuntime))));

  server.registerTool("project-environment.runtime.inspect", {
    title: "Inspect persistent project-service runtime",
    description: "Inspect the project-service workload associated with a registered environment. Does not expose secrets or mutate the workload.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { repositoryId: z.string().min(2).max(200) },
  }, async ({ repositoryId }) => guarded(() => safelySandbox(() => inspectProjectEnvironmentRuntime(repositoryId, sandboxRuntime))));

  server.registerTool("project-environment.start", {
    title: "Start persistent project service",
    description: "Start the registered project-service workload after verifying its workload identity. Task sandbox lifecycle tools cannot target project services.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { repositoryId: z.string().min(2).max(200) },
  }, async ({ repositoryId }) => guarded(() => safelySandbox(() => startProjectEnvironment(repositoryId, sandboxRuntime))));

  server.registerTool("project-environment.stop", {
    title: "Stop persistent project service",
    description: "Stop the registered project-service workload without deleting its persistent project data or releasing its resource reservation.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: { repositoryId: z.string().min(2).max(200) },
  }, async ({ repositoryId }) => guarded(() => safelySandbox(() => stopProjectEnvironment(repositoryId, sandboxRuntime))));

  server.registerTool("project-environment.deprovision", {
    title: "Deprovision persistent project service",
    description: "Remove the project-service container, unstage its canonical mounts and release the repository resource reservation. Persistent project release and data directories are retained. Requires explicit confirmation.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: { repositoryId: z.string().min(2).max(200), confirm: z.boolean() },
  }, async ({ repositoryId, confirm }) => guarded(() => safelySandbox(async () => {
    if (!confirm) throw new Error("Deprovisioning requires confirm=true");
    return deprovisionProjectEnvironment(repositoryId, sandboxRuntime);
  })));

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

  server.registerTool("task-workspace.create", {
    title: "Create task workspace",
    description: "Create an isolated Git worktree and unique task branch from origin/development in the registered repository cache. Branch names are generated from task IDs, never task titles.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    inputSchema: { repositoryId: z.string().min(1).max(200), taskId: z.string().min(1).max(128), sandboxId: z.string().min(1).max(128).optional(), retentionDays: z.number().int().min(1).max(3650).optional() },
  }, async ({ repositoryId, taskId, sandboxId, retentionDays }) => guarded(() => safely(() => createTaskWorkspace({ repositoryId, taskId, ...(sandboxId ? { sandboxId } : {}), ...(retentionDays ? { retentionDays } : {}) }))));

  server.registerTool("task-workspace.list", {
    title: "List task workspaces",
    description: "List durable task workspace records, optionally filtered by repository or task ID.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { repositoryId: z.string().min(1).max(200).optional(), taskId: z.string().min(1).max(128).optional(), includeRemoved: z.boolean().optional() },
  }, async ({ repositoryId, taskId, includeRemoved }) => guarded(() => safely(() => listTaskWorkspaces({ ...(repositoryId ? { repositoryId } : {}), ...(taskId ? { taskId } : {}), ...(includeRemoved !== undefined ? { includeRemoved } : {}) }))));

  server.registerTool("task-workspace.inspect", {
    title: "Inspect task workspace",
    description: "Inspect task workspace metadata, Git worktree linkage, branch, base commit and dirty state.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { id: z.string().uuid() },
  }, async ({ id }) => guarded(() => safely(() => inspectTaskWorkspace(id))));

  server.registerTool("task-workspace.status", {
    title: "Task workspace status",
    description: "Return lifecycle, worktree availability, branch and modified/staged/untracked change counts.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { id: z.string().uuid() },
  }, async ({ id }) => guarded(() => safely(() => getTaskWorkspaceStatus(id))));

  server.registerTool("task-workspace.diff", {
    title: "Task workspace diff summary",
    description: "Return a bounded Git diff summary and list untracked and ignored files without exposing file contents.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { id: z.string().uuid() },
  }, async ({ id }) => guarded(() => safely(() => getTaskWorkspaceDiff(id))));

  server.registerTool("task-workspace.retain", {
    title: "Retain task workspace",
    description: "Mark a task worktree as retained without removing it or discarding dirty/untracked work.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { id: z.string().uuid() },
  }, async ({ id }) => guarded(() => safely(() => retainWorkspaceSafely(id))));

  server.registerTool("task-workspace.resume", {
    title: "Resume task workspace",
    description: "Resume an existing retained worktree. Missing or unlinked worktrees are not recreated automatically.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { id: z.string().uuid() },
  }, async ({ id }) => guarded(() => safely(() => resumeWorkspaceSafely(id))));

  server.registerTool("task-workspace.remove", {
    title: "Remove task workspace",
    description: "Remove a task worktree only with confirm=true. Dirty, staged or untracked work is preserved unless discardChanges=true is also explicitly confirmed.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    inputSchema: { id: z.string().uuid(), confirm: z.boolean(), discardChanges: z.boolean().optional() },
  }, async ({ id, confirm, discardChanges }) => guarded(() => safely(async () => {
    await ensureTaskWorkspaceHasNoSandbox(id);
    return removeTaskWorkspace({ id, confirm, ...(discardChanges !== undefined ? { discardChanges } : {}) });
  })));

  server.registerTool("task-workspace.prune", {
    title: "Prune expired task workspaces",
    description: "Preview or remove only expired, retained, clean task worktrees. Dry-run is the default; actual pruning requires confirm=true.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    inputSchema: { olderThanDays: z.number().int().min(1).max(3650), dryRun: z.boolean().default(true), confirm: z.boolean().optional() },
  }, async ({ olderThanDays, dryRun, confirm }) => guarded(() => safely(() => pruneTaskWorkspaces(
    { olderThanDays, dryRun, ...(confirm !== undefined ? { confirm } : {}) },
    ensureTaskWorkspaceHasNoSandbox,
  ))));

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
