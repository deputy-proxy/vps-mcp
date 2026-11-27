import express from "express";
import fs from "node:fs/promises";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { config } from "./config.js";
import { authenticate } from "./security.js";
import { createMcpServer } from "./tools.js";
import { createDashboardAuth } from "./dashboard-auth.js";
import { getDashboardHistory, getDashboardSnapshot } from "./dashboard.js";
import { DASHBOARD_HTML } from "./dashboard-html.js";

const dashboardAuth = config.dashboard.enabled
  ? createDashboardAuth({
      issuer: config.oauthIssuer!,
      clientId: config.dashboard.clientId!,
      clientSecret: config.dashboard.clientSecret!,
      redirectUri: config.dashboard.redirectUri!,
      allowedEmails: config.dashboard.allowedEmails,
      sessionTtlSeconds: config.dashboard.sessionTtlSeconds,
      secureCookies: config.dashboard.secureCookies,
    })
  : null;

function setDashboardSecurityHeaders(response: express.Response): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
}

const CORS_ALLOWED_METHODS = ["GET", "POST"];
const CORS_ALLOWED_HEADERS = ["accept", "authorization", "content-type", "mcp-protocol-version"];
const CORS_EXPOSED_HEADERS = ["www-authenticate", "mcp-protocol-version"];

function protectedResourceMetadata() {
  return {
    resource: config.publicUrl!.toString(),
    // URL#toString() adds a trailing slash to origin-only URLs. OAuth issuer
    // identifiers are exact strings, so publish the original configured value.
    authorization_servers: [config.oauthIssuer!],
    bearer_methods_supported: ["header"],
    ...(config.oauthSupportedScopes.length > 0 ? { scopes_supported: config.oauthSupportedScopes } : {}),
  };
}

async function proxyAuthorizationServerMetadata(response: express.Response): Promise<void> {
  try {
    const metadataUrl = new URL("/.well-known/oauth-authorization-server", config.oauthIssuerUrl);
    const upstream = await fetch(metadataUrl, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
      redirect: "error",
    });
    if (!upstream.ok) {
      response.status(502).json({ error: "Authorization server metadata unavailable" });
      return;
    }
    const contentType = upstream.headers.get("content-type") ?? "";
    if (!contentType.includes("json")) {
      response.status(502).json({ error: "Authorization server returned invalid metadata" });
      return;
    }
    response.status(200).type("application/json").send(await upstream.text());
  } catch (error) {
    console.error("Authorization server metadata proxy failed", error);
    if (!response.headersSent) response.status(502).json({ error: "Authorization server metadata unavailable" });
  }
}

type AuthenticateRequest = (
  request: express.Request,
  response: express.Response,
  next: express.NextFunction,
) => void | Promise<void>;

export function createHttpServer(dependencies: { authenticateRequest?: AuthenticateRequest } = {}) {
  const app = createMcpExpressApp({ host: config.host });
  const authenticateRequest = dependencies.authenticateRequest ?? authenticate;

  app.use((request, response, next) => {
    const origin = request.header("origin");
    response.vary("Origin");

    if (origin && config.corsOrigins.includes(origin)) {
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Access-Control-Allow-Methods", CORS_ALLOWED_METHODS.join(", "));
      response.setHeader("Access-Control-Allow-Headers", CORS_ALLOWED_HEADERS.join(", "));
      response.setHeader("Access-Control-Expose-Headers", CORS_EXPOSED_HEADERS.join(", "));
    }

    if (request.method === "OPTIONS") {
      const requestedMethod = request.header("access-control-request-method")?.toUpperCase();
      const requestedHeaders = (request.header("access-control-request-headers") ?? "")
        .split(",").map((header) => header.trim().toLowerCase()).filter(Boolean);
      const originAllowed = Boolean(origin && config.corsOrigins.includes(origin));
      const methodAllowed = Boolean(requestedMethod && CORS_ALLOWED_METHODS.includes(requestedMethod));
      const headersAllowed = requestedHeaders.every((header) => CORS_ALLOWED_HEADERS.includes(header));

      if (!originAllowed || !methodAllowed || !headersAllowed) {
        response.status(403).json({ error: "CORS preflight rejected" });
        return;
      }
      response.status(204).end();
      return;
    }
    next();
  });

  app.get("/healthz", (_request, response) => {
    response.status(200).json({ status: "ok", service: "vps-mcp" });
  });

  if (config.authMode === "oauth") {
    // Log discovery requests without recording credentials, query strings or response bodies.
    app.use("/.well-known", (request, response, next) => {
      const startedAt = process.hrtime.bigint();
      response.once("finish", () => {
        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
        console.info(JSON.stringify({
          event: "oauth_discovery_request",
          method: request.method,
          path: request.path,
          status: response.statusCode,
          origin: request.header("origin") ?? null,
          userAgent: request.header("user-agent") ?? null,
          durationMs: Math.round(durationMs * 100) / 100,
        }));
      });
      next();
    });

    // RFC 9728 discovery for an MCP endpoint at /mcp permits both the
    // endpoint-specific well-known URI and the origin-level URI.
    app.get("/.well-known/oauth-protected-resource/mcp", (_request, response) => {
      response.status(200).json(protectedResourceMetadata());
    });
    // Some ChatGPT connector attempts request this path with a trailing
    // URL-encoded backslash (%5C). Accept only that exact malformed suffix
    // as a compatibility alias; keep the advertised canonical URL unchanged.
    app.get(/^\/\.well-known\/oauth-protected-resource\/mcp%5c$/i, (_request, response) => {
      response.status(200).json(protectedResourceMetadata());
    });
    app.get("/.well-known/oauth-protected-resource", (_request, response) => {
      response.status(200).json(protectedResourceMetadata());
    });

    // Compatibility for clients that look for authorization-server metadata
    // on the MCP server origin rather than following authorization_servers.
    app.get("/.well-known/oauth-authorization-server", (_request, response) => {
      void proxyAuthorizationServerMetadata(response);
    });
  }

  app.use(express.json({ limit: config.maxRequestBytes }));

  if (!dashboardAuth) {
    app.use("/dashboard", (_request, response) => {
      response.status(503).type("text/plain").send("Dashboard authentication is not configured.");
    });
  } else {
    app.get("/dashboard/auth/login", (request, response) => {
      setDashboardSecurityHeaders(response);
      void dashboardAuth.begin(request, response);
    });
    app.get("/dashboard/auth/callback", (request, response) => {
      setDashboardSecurityHeaders(response);
      void dashboardAuth.callback(request, response);
    });
    app.post("/dashboard/auth/logout", dashboardAuth.requireSession({ api: true }), (request, response) => {
      setDashboardSecurityHeaders(response);
      dashboardAuth.logout(request, response);
    });
    app.get("/dashboard/assets/dashboard.js", dashboardAuth.requireSession(), async (_request, response) => {
      setDashboardSecurityHeaders(response);
      try {
        response.type("application/javascript").send(await fs.readFile(new URL("../public/dashboard.js", import.meta.url), "utf8"));
      } catch {
        response.status(503).type("text/plain").send("Dashboard assets are unavailable.");
      }
    });
    app.get("/dashboard/assets/dashboard.css", dashboardAuth.requireSession(), async (_request, response) => {
      setDashboardSecurityHeaders(response);
      try {
        response.type("text/css").send(await fs.readFile(new URL("../public/dashboard.css", import.meta.url), "utf8"));
      } catch {
        response.status(503).type("text/plain").send("Dashboard assets are unavailable.");
      }
    });
    app.get("/dashboard/assets/cr8or-logo.svg", dashboardAuth.requireSession(), async (_request, response) => {
      setDashboardSecurityHeaders(response);
      try {
        response.type("image/svg+xml").send(await fs.readFile(new URL("../public/cr8or-logo.svg", import.meta.url), "utf8"));
      } catch {
        response.status(503).type("text/plain").send("Dashboard assets are unavailable.");
      }
    });
    app.get("/dashboard/api/overview", dashboardAuth.requireSession({ api: true }), async (request, response) => {
      setDashboardSecurityHeaders(response);
      try {
        response.status(200).json(await getDashboardSnapshot({ forceRefresh: request.query.refresh === "1" }));
      } catch {
        response.status(503).json({ error: "Dashboard data is temporarily unavailable." });
      }
    });
    app.get("/dashboard/api/history", dashboardAuth.requireSession({ api: true }), (_request, response) => {
      setDashboardSecurityHeaders(response);
      response.status(200).json(getDashboardHistory());
    });
    app.get("/dashboard/api/sandboxes/:id", dashboardAuth.requireSession({ api: true }), async (request, response) => {
      setDashboardSecurityHeaders(response);
      const sandboxId = Array.isArray(request.params.id) ? request.params.id[0] : request.params.id;
      if (!/^[0-9a-f-]{36}$/i.test(sandboxId ?? "")) {
        response.status(400).json({ error: "Invalid sandbox ID." });
        return;
      }
      try {
        const snapshot = await getDashboardSnapshot();
        const sandbox = snapshot.sandboxes.find((item) => item.id === sandboxId);
        if (!sandbox) response.status(404).json({ error: "Sandbox not found." });
        else response.status(200).json(sandbox);
      } catch {
        response.status(503).json({ error: "Dashboard data is temporarily unavailable." });
      }
    });
    app.get(["/dashboard", "/dashboard/"], dashboardAuth.requireSession(), (_request, response) => {
      setDashboardSecurityHeaders(response);
      response.type("html").send(DASHBOARD_HTML);
    });
    app.use("/dashboard", (_request, response) => {
      response.status(404).json({ error: "Not found" });
    });
  }

  app.use("/mcp", (request, response, next) => {
    const startedAt = process.hrtime.bigint();
    response.once("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      const body = request.body as { method?: unknown } | undefined;
      console.info(JSON.stringify({
        event: "mcp_http_request",
        method: request.method,
        path: request.baseUrl + request.path,
        status: response.statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
        rpcMethod: typeof body?.method === "string" ? body.method : undefined,
        origin: request.header("origin") ?? null,
        userAgent: request.header("user-agent") ?? null,
      }));
    });
    next();
  });

  // Match CR8OR's server-level OAuth boundary: every MCP request, including
  // initialize and tools/list, must carry a valid bearer token.
  app.use("/mcp", (request, response, next) => {
    void Promise.resolve(authenticateRequest(request, response, next)).catch((error: unknown) => {
      console.error("Authentication middleware failed", error);
      if (!response.headersSent) response.status(500).json({ error: "Authentication failed" });
    });
  });

  app.post("/mcp", async (request, response) => {
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({});
    response.on("close", () => { void transport.close(); });

    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      console.error("MCP request failed", error);
      if (!response.headersSent) response.status(500).json({ error: "MCP request failed" });
    }
  });

  app.all("/mcp", (_request, response) => {
    response.setHeader("Allow", "POST");
    response.status(405).json({ error: "Method not allowed" });
  });

  app.use((_request, response) => response.status(404).json({ error: "Not found" }));
  return app;
}

