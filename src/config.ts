import os from "node:os";
import path from "node:path";
import { parseCorsOrigins, parseOAuthAudience, parsePublicMcpUrl, parseHttpsUrl } from "./config-validation.js";

function integerFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

const authMode = process.env.MCP_AUTH_MODE ?? "token";
if (!["token", "none", "oauth"].includes(authMode)) throw new Error("MCP_AUTH_MODE must be 'token', 'none' or 'oauth'");

const token = process.env.MCP_AUTH_TOKEN ?? "";
if (authMode === "token" && token.length < 32) throw new Error("MCP_AUTH_TOKEN must contain at least 32 characters when MCP_AUTH_MODE=token");

const host = process.env.MCP_HOST ?? "127.0.0.1";
if (authMode === "none" && !["127.0.0.1", "localhost", "::1"].includes(host)) {
  throw new Error("MCP_AUTH_MODE=none is only permitted when MCP_HOST is loopback");
}

const publicUrl = parsePublicMcpUrl(process.env.MCP_PUBLIC_URL, authMode === "oauth");
const oauthIssuer = process.env.OAUTH_ISSUER_URL;
const oauthIssuerUrl = parseHttpsUrl("OAUTH_ISSUER_URL", oauthIssuer, authMode === "oauth");
const oauthJwksUrl = parseHttpsUrl("OAUTH_JWKS_URL", process.env.OAUTH_JWKS_URL);
const oauthAudience = parseOAuthAudience(process.env.OAUTH_AUDIENCE, authMode === "oauth");
const oauthScopes = (process.env.OAUTH_REQUIRED_SCOPES ?? "").split(/[ ,]+/).map((scope) => scope.trim()).filter(Boolean);
if (oauthScopes.some((scope) => /[\s,]/.test(scope))) throw new Error("OAUTH_REQUIRED_SCOPES entries must be individual scope tokens");

// ChatGPT's connector setup may fetch OAuth discovery metadata directly from the browser.
// Always allow the official ChatGPT web origins; deployments may add exact origins via env.
const corsOrigins = [...new Set([
  "https://chatgpt.com",
  "https://chat.openai.com",
  ...parseCorsOrigins(process.env.MCP_CORS_ORIGINS),
])];

const allowedRoots = (process.env.MCP_ALLOWED_ROOTS ?? `/srv,${path.join(os.homedir(), ".local/share/vps-mcp")}`)
  .split(",").map((entry) => path.resolve(entry.trim())).filter(Boolean);
if (allowedRoots.length === 0) throw new Error("MCP_ALLOWED_ROOTS must contain at least one directory");

const dashboardClientId = process.env.DASHBOARD_OIDC_CLIENT_ID?.trim() || undefined;
const dashboardClientSecret = process.env.DASHBOARD_OIDC_CLIENT_SECRET || undefined;
const dashboardRedirectUri = process.env.DASHBOARD_OIDC_REDIRECT_URI?.trim() || undefined;
const dashboardAllowedEmails = (process.env.DASHBOARD_ALLOWED_EMAILS ?? "")
  .split(",").map((email) => email.trim().toLowerCase()).filter(Boolean);
const dashboardSessionTtlSeconds = integerFromEnv("DASHBOARD_SESSION_TTL_SECONDS", 8 * 60 * 60);
const dashboardConfigurationPresent = Boolean(
  dashboardClientId || dashboardClientSecret || dashboardRedirectUri || Boolean(process.env.DASHBOARD_ALLOWED_EMAILS?.trim()),
);
const dashboardRedirectUrl = dashboardRedirectUri ? new URL(dashboardRedirectUri) : undefined;
if (dashboardConfigurationPresent) {
  if (!dashboardClientId || !dashboardClientSecret || !dashboardRedirectUri || dashboardAllowedEmails.length === 0) {
    throw new Error("Dashboard OIDC requires DASHBOARD_OIDC_CLIENT_ID, DASHBOARD_OIDC_CLIENT_SECRET, DASHBOARD_OIDC_REDIRECT_URI and DASHBOARD_ALLOWED_EMAILS");
  }
  if (!oauthIssuer || !oauthIssuerUrl) throw new Error("Dashboard OIDC requires the existing OAUTH_ISSUER_URL configuration");
  if (!dashboardRedirectUrl || dashboardRedirectUrl.username || dashboardRedirectUrl.password
    || dashboardRedirectUrl.search || dashboardRedirectUrl.hash
    || dashboardRedirectUrl.pathname !== "/dashboard/auth/callback"
    || !(dashboardRedirectUrl.protocol === "https:" || (dashboardRedirectUrl.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(dashboardRedirectUrl.hostname) && process.env.NODE_ENV !== "production"))) {
    throw new Error("DASHBOARD_OIDC_REDIRECT_URI must be an HTTPS callback URL at /dashboard/auth/callback (HTTP localhost is allowed outside production)");
  }
  if (dashboardClientSecret.length < 8) throw new Error("DASHBOARD_OIDC_CLIENT_SECRET is too short");
  if (dashboardAllowedEmails.some((email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
    throw new Error("DASHBOARD_ALLOWED_EMAILS contains an invalid email address");
  }
  if (dashboardSessionTtlSeconds > 24 * 60 * 60) throw new Error("DASHBOARD_SESSION_TTL_SECONDS cannot exceed 24 hours");
}

const repositoryGitHubToken = process.env.REPOSITORY_GITHUB_TOKEN?.trim() || undefined;
if (repositoryGitHubToken && (/\s/.test(repositoryGitHubToken) || repositoryGitHubToken.length > 4096)) {
  throw new Error("REPOSITORY_GITHUB_TOKEN must be a single-line token of at most 4096 characters");
}
const repositoryRequiredStatusChecks = (process.env.REPOSITORY_REQUIRED_STATUS_CHECKS ?? "quality")
  .split(",").map((entry) => entry.trim()).filter(Boolean);
if (repositoryRequiredStatusChecks.length === 0 || repositoryRequiredStatusChecks.length > 20 || repositoryRequiredStatusChecks.some((entry) => entry.length > 200)) {
  throw new Error("REPOSITORY_REQUIRED_STATUS_CHECKS must contain 1 to 20 non-empty check names of at most 200 characters");
}

export const config = {
  host,
  port: integerFromEnv("MCP_PORT", 3000),
  authMode,
  authToken: token,
  publicUrl,
  oauthIssuer,
  oauthIssuerUrl,
  oauthJwksUrl,
  oauthAudience,
  oauthScopes,
  corsOrigins,
  allowedRoots,
  dataDir: path.resolve(process.env.MCP_DATA_DIR ?? path.join(os.homedir(), ".local/share/vps-mcp")),
  maxRequestBytes: integerFromEnv("MCP_MAX_REQUEST_BYTES", 2 * 1024 * 1024),
  defaultCommandTimeoutMs: integerFromEnv("MCP_DEFAULT_COMMAND_TIMEOUT_MS", 30_000),
  maxCommandTimeoutMs: integerFromEnv("MCP_MAX_COMMAND_TIMEOUT_MS", 900_000),
  maxOutputBytes: integerFromEnv("MCP_MAX_OUTPUT_BYTES", 1_048_576),
  dashboard: {
    enabled: dashboardConfigurationPresent,
    clientId: dashboardClientId,
    clientSecret: dashboardClientSecret,
    redirectUri: dashboardRedirectUri,
    allowedEmails: dashboardAllowedEmails,
    sessionTtlSeconds: dashboardSessionTtlSeconds,
    secureCookies: dashboardRedirectUrl?.protocol === "https:",
  },
  repositoryGitHubToken,
  repositoryRequiredStatusChecks,
  serviceProfilePromotionEnabled: process.env.VPS_SERVICE_PROFILE_PROMOTION_ENABLED === "true"
    && (authMode !== "oauth" || oauthScopes.includes("vps:admin")),
};
