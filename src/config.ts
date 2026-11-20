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

const authMode = process.env.MCP_AUTH_MODE ?? "token";
if (!["token", "none", "oauth"].includes(authMode)) {
  throw new Error("MCP_AUTH_MODE must be 'token', 'none' or 'oauth'");
}

const token = process.env.MCP_AUTH_TOKEN ?? "";
if (authMode === "token" && token.length < 32) {
  throw new Error("MCP_AUTH_TOKEN must contain at least 32 characters when MCP_AUTH_MODE=token");
}

const host = process.env.MCP_HOST ?? "127.0.0.1";
const loopbackHosts = ["127.0.0.1", "localhost", "::1"];
if (authMode === "none" && !loopbackHosts.includes(host)) {
  throw new Error("MCP_AUTH_MODE=none is only permitted when MCP_HOST is loopback");
}
if (authMode === "oauth" && !process.env.MCP_PUBLIC_URL) {
  throw new Error("MCP_PUBLIC_URL is required when MCP_AUTH_MODE=oauth");
}
if (authMode === "oauth" && !process.env.OAUTH_ISSUER_URL) {
  throw new Error("OAUTH_ISSUER_URL is required when MCP_AUTH_MODE=oauth");
}
if (authMode === "oauth" && !process.env.OAUTH_AUDIENCE) {
  throw new Error("OAUTH_AUDIENCE is required when MCP_AUTH_MODE=oauth");
}

function httpsUrl(name: string, value: string | undefined, required = false): URL | undefined {
  if (!value) {
    if (required) throw new Error(`${name} is required`);
    return undefined;
  }
  const parsed = new URL(value);
  if (parsed.protocol !== "https:") throw new Error(`${name} must use HTTPS`);
  return parsed;
}

const publicUrl = httpsUrl("MCP_PUBLIC_URL", process.env.MCP_PUBLIC_URL, authMode === "oauth");
const oauthIssuerUrl = httpsUrl("OAUTH_ISSUER_URL", process.env.OAUTH_ISSUER_URL, authMode === "oauth");
const oauthJwksUrl = httpsUrl("OAUTH_JWKS_URL", process.env.OAUTH_JWKS_URL);
const oauthAudience = process.env.OAUTH_AUDIENCE ?? "";
const oauthScopes = (process.env.OAUTH_REQUIRED_SCOPES ?? "mcp")
  .split(/[ ,]+/)
  .map((scope) => scope.trim())
  .filter(Boolean);

if (authMode === "oauth" && oauthScopes.length === 0) {
  throw new Error("OAUTH_REQUIRED_SCOPES must contain at least one scope");
}

const allowedRoots = (process.env.MCP_ALLOWED_ROOTS ?? `/srv,${path.join(os.homedir(), ".local/share/vps-mcp")}`)
  .split(",")
  .map((entry) => path.resolve(entry.trim()))
  .filter(Boolean);

if (allowedRoots.length === 0) {
  throw new Error("MCP_ALLOWED_ROOTS must contain at least one directory");
}

export const config = {
  host,
  port: integerFromEnv("MCP_PORT", 3000),
  authMode,
  authToken: token,
  publicUrl,
  oauthIssuerUrl,
  oauthJwksUrl,
  oauthAudience,
  oauthScopes,
  allowedRoots,
  dataDir: path.resolve(process.env.MCP_DATA_DIR ?? path.join(os.homedir(), ".local/share/vps-mcp")),
  maxRequestBytes: integerFromEnv("MCP_MAX_REQUEST_BYTES", 2 * 1024 * 1024),
  defaultCommandTimeoutMs: integerFromEnv("MCP_DEFAULT_COMMAND_TIMEOUT_MS", 30_000),
  maxCommandTimeoutMs: integerFromEnv("MCP_MAX_COMMAND_TIMEOUT_MS", 900_000),
  maxOutputBytes: integerFromEnv("MCP_MAX_OUTPUT_BYTES", 1_048_576),
};
