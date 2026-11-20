import express from "express";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { config } from "./config.js";
import { authenticate } from "./security.js";
import { createMcpServer } from "./tools.js";

export function createHttpServer() {
  const app = createMcpExpressApp({ host: config.host });
  app.use((request, response, next) => {
    if (request.path === "/healthz" && request.method === "GET") return next();
    authenticate(request, response, next);
  });
  app.use(express.json({ limit: config.maxRequestBytes }));

  app.get("/healthz", (_request, response) => {
    response.status(200).json({ status: "ok", service: "vps-mcp" });
  });

  app.post("/mcp", async (request, response) => {
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
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
