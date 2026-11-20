import os from "node:os";
import path from "node:path";

function integerFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

const token = process.env.MCP_AUTH_TOKEN ?? "";
if (token.length < 32) {
  throw new Error("MCP_AUTH_TOKEN must contain at least 32 characters");
}

const allowedRoots = (process.env.MCP_ALLOWED_ROOTS ?? `/srv,${path.join(os.homedir(), ".local/share/vps-mcp")}`)
  .split(",")
  .map((entry) => path.resolve(entry.trim()))
  .filter(Boolean);

if (allowedRoots.length === 0) {
  throw new Error("MCP_ALLOWED_ROOTS must contain at least one directory");
}

export const config = {
  host: process.env.MCP_HOST ?? "127.0.0.1",
  port: integerFromEnv("MCP_PORT", 3000),
  authToken: token,
  allowedRoots,
  dataDir: path.resolve(process.env.MCP_DATA_DIR ?? path.join(os.homedir(), ".local/share/vps-mcp")),
  maxRequestBytes: integerFromEnv("MCP_MAX_REQUEST_BYTES", 2 * 1024 * 1024),
  defaultCommandTimeoutMs: integerFromEnv("MCP_DEFAULT_COMMAND_TIMEOUT_MS", 30_000),
  maxCommandTimeoutMs: integerFromEnv("MCP_MAX_COMMAND_TIMEOUT_MS", 900_000),
  maxOutputBytes: integerFromEnv("MCP_MAX_OUTPUT_BYTES", 1_048_576),
};
