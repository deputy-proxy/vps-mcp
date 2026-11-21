import express from "express";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { config } from "./config.js";
import { authenticate } from "./security.js";
import { createMcpServer } from "./tools.js";

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
    ...(config.oauthScopes.length > 0 ? { scopes_supported: config.oauthScopes } : {}),
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

export function createHttpServer(dependencies: { authenticateRequest?: typeof authenticate } = {}) {
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
    void authenticateRequest(request, response, next).catch((error: unknown) => {
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
