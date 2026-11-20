import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { resolveAllowedDirectory } from "./paths.js";

type ExecutionRecord = {
  id: string;
  command: string;
  cwd: string;
  pid: number;
  startedAt: string;
  logPath: string;
  exitPath: string;
};

async function ensureDataDir(): Promise<void> {
  await fsp.mkdir(config.dataDir, { recursive: true, mode: 0o700 });
}

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

async function readRecord(id: string): Promise<ExecutionRecord> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Invalid execution ID");
  const file = path.join(config.dataDir, "executions", id, "record.json");
  return JSON.parse(await fsp.readFile(file, "utf8")) as ExecutionRecord;
}

async function writeRecord(record: ExecutionRecord): Promise<void> {
  const directory = path.dirname(path.join(config.dataDir, "executions", record.id, "record.json"));
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  const destination = path.join(directory, "record.json");
  const temporary = `${destination}.tmp`;
  await fsp.writeFile(temporary, JSON.stringify(record, null, 2), { mode: 0o600 });
  await fsp.rename(temporary, destination);
}

export async function executeCommand(input: {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; truncated: boolean }> {
  const cwd = await resolveAllowedDirectory(input.cwd ?? "/srv");
  const timeoutMs = Math.min(input.timeoutMs ?? config.defaultCommandTimeoutMs, config.maxCommandTimeoutMs);
  const maxBytes = Math.min(input.maxOutputBytes ?? config.maxOutputBytes, config.maxOutputBytes);

  return await new Promise((resolve, reject) => {
    const child = spawn("/bin/bash", ["-lc", input.command], {
      cwd,
      detached: true,
      env: { ...process.env, HOME: process.env.HOME ?? "/tmp" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const collect = (target: "stdout" | "stderr") => (chunk: Buffer) => {
      outputBytes += chunk.length;
      const remaining = Math.max(0, maxBytes - (Buffer.byteLength(stdout) + Buffer.byteLength(stderr)));
      if (remaining > 0) {
        const text = chunk.subarray(0, remaining).toString("utf8");
        if (target === "stdout") stdout += text;
        else stderr += text;
      }
      if (outputBytes > maxBytes) truncated = true;
    };

    child.stdout.on("data", collect("stdout"));
    child.stderr.on("data", collect("stderr"));
    let timer: NodeJS.Timeout | undefined;
    child.once("error", (error) => {
      if (!settled) {
        settled = true;
        if (timer) clearTimeout(timer);
        reject(error);
      }
    });

    timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) {
        try { process.kill(-child.pid, "SIGTERM"); } catch { /* already exited */ }
        setTimeout(() => {
          if (child.pid) {
            try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ }
          }
        }, 1_000).unref();
      }
    }, timeoutMs);

    child.once("close", (code) => {
      if (timer) clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({ exitCode: code, stdout, stderr, timedOut, truncated });
    });
  });
}

export async function startExecution(input: { command: string; cwd?: string }): Promise<{ id: string; pid: number; cwd: string; startedAt: string }> {
  await ensureDataDir();
  const cwd = await resolveAllowedDirectory(input.cwd ?? "/srv");
  const id = randomUUID();
  const directory = path.join(config.dataDir, "executions", id);
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  const logPath = path.join(directory, "output.log");
  const exitPath = path.join(directory, "exit-code");
  const logFd = fs.openSync(logPath, "a", 0o600);
  const wrapper = `set +e\n${input.command}\ncode=$?\nprintf '%s' "$code" > ${shellQuote(exitPath)}\nexit "$code"\n`;

  const child = spawn("/bin/bash", ["-lc", wrapper], {
    cwd,
    detached: true,
    env: { ...process.env, HOME: process.env.HOME ?? "/tmp" },
    stdio: ["ignore", logFd, logFd],
  });
  fs.closeSync(logFd);

  await new Promise<void>((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", reject);
  });
  if (!child.pid) throw new Error("Failed to start execution process");

  const record: ExecutionRecord = {
    id,
    command: input.command,
    cwd,
    pid: child.pid,
    startedAt: new Date().toISOString(),
    logPath,
    exitPath,
  };
  await writeRecord(record);
  child.unref();

  return { id, pid: child.pid, cwd, startedAt: record.startedAt };
}

export async function getExecutionStatus(id: string): Promise<Record<string, unknown>> {
  const record = await readRecord(id);
  try {
    const exitCode = Number.parseInt(await fsp.readFile(record.exitPath, "utf8"), 10);
    return { id, pid: record.pid, status: "completed", exitCode, cwd: record.cwd, startedAt: record.startedAt };
  } catch {
    try {
      process.kill(record.pid, 0);
      return { id, pid: record.pid, status: "running", cwd: record.cwd, startedAt: record.startedAt };
    } catch {
      return { id, pid: record.pid, status: "unknown", detail: "Process is not running and no exit code was recorded", cwd: record.cwd, startedAt: record.startedAt };
    }
  }
}

export async function getExecutionLogs(id: string, maxBytes = 65_536): Promise<{ id: string; logs: string; truncated: boolean }> {
  const record = await readRecord(id);
  const stats = await fsp.stat(record.logPath);
  const length = Math.min(stats.size, Math.max(1_024, Math.min(maxBytes, 262_144)));
  const handle = await fsp.open(record.logPath, "r");
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, Math.max(0, stats.size - length));
    return { id, logs: buffer.toString("utf8"), truncated: stats.size > length };
  } finally {
    await handle.close();
  }
}

export async function cancelExecution(id: string): Promise<{ id: string; cancelled: boolean }> {
  const record = await readRecord(id);
  try {
    process.kill(-record.pid, "SIGTERM");
    return { id, cancelled: true };
  } catch {
    return { id, cancelled: false };
  }
}
