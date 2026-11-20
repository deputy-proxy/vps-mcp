import express from "express";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { config } from "./config.js";
import { authenticate } from "./security.js";
import { createMcpServer } from "./tools.js";

const CORS_ALLOWED_METHODS = ["POST"];
const CORS_ALLOWED_HEADERS = ["authorization", "content-type", "mcp-protocol-version"];
const CORS_EXPOSED_HEADERS = ["www-authenticate", "mcp-protocol-version"];

function protectedResourceMetadata() {
  return {
    resource: config.publicUrl!.toString(),
    authorization_servers: [config.oauthIssuerUrl!.toString()],
    bearer_methods_supported: ["header"],
    scopes_supported: config.oauthScopes,
  };
}

export function createHttpServer() {
  const app = createMcpExpressApp({ host: config.host });

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
    app.get("/.well-known/oauth-protected-resource/mcp", (_request, response) => {
      response.status(200).json(protectedResourceMetadata());
    });
  }

  app.use("/mcp", (request, response, next) => {
    void authenticate(request, response, next).catch((error: unknown) => {
      console.error("Authentication middleware failed", error);
      if (!response.headersSent) response.status(500).json({ error: "Authentication failed" });
    });
  });
  app.use(express.json({ limit: config.maxRequestBytes }));

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
