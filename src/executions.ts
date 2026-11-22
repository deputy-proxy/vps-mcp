import { spawn } from "node:child_process";
import { config } from "./config.js";
import { resolveAllowedDirectory } from "./paths.js";

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
