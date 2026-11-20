import os from "node:os";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { config } from "./config.js";
import { executeCommand, startExecution, getExecutionStatus, getExecutionLogs, cancelExecution } from "./executions.js";
import { listDirectory, readFile, writeFile } from "./filesystem.js";

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

export function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: "vps-mcp", version: "0.1.0" },
    { instructions: "Authenticated VPS administration and development execution. All filesystem paths and command working directories are restricted to configured allowed roots. Commands execute as the unprivileged service account." },
  );

  server.registerTool("system.health", {
    title: "System health",
    description: "Check MCP service health, data directory writability and configured filesystem roots.",
    inputSchema: {},
  }, async () => safely(async () => {
    await fs.mkdir(config.dataDir, { recursive: true });
    await fs.access(config.dataDir, constants.R_OK | constants.W_OK);
    return { status: "healthy", service: "vps-mcp", version: "0.1.0", uptimeSeconds: Math.floor(process.uptime()), dataDirectoryWritable: true, allowedRoots: config.allowedRoots };
  }));

  server.registerTool("system.info", {
    title: "System information",
    description: "Return non-secret VPS operating system, CPU, memory, load and disk information.",
    inputSchema: {},
  }, async () => safely(async () => {
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
  }));

  server.registerTool("terminal.execute", {
    title: "Execute command",
    description: "Run a Bash command synchronously as the unprivileged MCP service user. The working directory must be inside MCP_ALLOWED_ROOTS. Maximum timeout and output are server-configured.",
    inputSchema: {
      command: z.string().min(1).max(20_000),
      cwd: z.string().optional(),
      timeoutMs: z.number().int().positive().max(900_000).optional(),
      maxOutputBytes: z.number().int().positive().max(1_048_576).optional(),
    },
  }, async ({ command, cwd, timeoutMs, maxOutputBytes }) => safely(() => executeCommand({ command, ...(cwd ? { cwd } : {}), ...(timeoutMs ? { timeoutMs } : {}), ...(maxOutputBytes ? { maxOutputBytes } : {}) })));

  server.registerTool("terminal.start", {
    title: "Start background command",
    description: "Start a detached Bash command and persist its execution metadata and combined output log.",
    inputSchema: { command: z.string().min(1).max(20_000), cwd: z.string().optional() },
  }, async ({ command, cwd }) => safely(() => startExecution({ command, ...(cwd ? { cwd } : {}) })));

  server.registerTool("terminal.status", {
    title: "Execution status",
    description: "Inspect a background execution by its execution ID.",
    inputSchema: { executionId: z.string().uuid() },
  }, async ({ executionId }) => safely(() => getExecutionStatus(executionId)));

  server.registerTool("terminal.logs", {
    title: "Execution logs",
    description: "Read the most recent output from a background execution.",
    inputSchema: { executionId: z.string().uuid(), maxBytes: z.number().int().positive().max(262_144).optional() },
  }, async ({ executionId, maxBytes }) => safely(() => getExecutionLogs(executionId, maxBytes)));

  server.registerTool("terminal.cancel", {
    title: "Cancel execution",
    description: "Send SIGTERM to a background execution process group.",
    inputSchema: { executionId: z.string().uuid() },
  }, async ({ executionId }) => safely(() => cancelExecution(executionId)));

  server.registerTool("filesystem.list", {
    title: "List directory",
    description: "List a directory within configured allowed roots. Symlinks resolving outside allowed roots are omitted.",
    inputSchema: { path: z.string().min(1) },
  }, async ({ path }) => safely(() => listDirectory(path)));

  server.registerTool("filesystem.read", {
    title: "Read file",
    description: "Read a UTF-8 file up to 2 MiB from configured allowed roots.",
    inputSchema: { path: z.string().min(1) },
  }, async ({ path }) => safely(() => readFile(path)));

  server.registerTool("filesystem.write", {
    title: "Write file",
    description: "Atomically create or replace a UTF-8 file up to 2 MiB inside configured allowed roots.",
    inputSchema: { path: z.string().min(1), content: z.string().max(2 * 1024 * 1024) },
  }, async ({ path, content }) => safely(() => writeFile(path, content)));

  return server;
}
