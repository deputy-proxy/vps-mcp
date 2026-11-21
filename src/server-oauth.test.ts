import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Request, Response as ExpressResponse, NextFunction } from "express";
import type { authenticate } from "./security.js";

const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "vps-mcp-oauth-"));
process.env.MCP_AUTH_MODE = "oauth";
process.env.MCP_PUBLIC_URL = "https://mcp.example.test/mcp";
process.env.OAUTH_ISSUER_URL = "https://issuer.example.test";
process.env.OAUTH_AUDIENCE = "https://mcp.example.test/mcp";
process.env.OAUTH_REQUIRED_SCOPES = "";
process.env.MCP_DATA_DIR = temporaryDirectory;
process.env.MCP_ALLOWED_ROOTS = temporaryDirectory;

const { createHttpServer } = await import("./server.js");

let server: Server;
let baseUrl: string;

function rpc(method: string, id: number, params: Record<string, unknown> = {}) {
  return { jsonrpc: "2.0", id, method, params };
}

async function post(body: unknown, authorization?: string) {
  return fetch(`${baseUrl}/mcp/`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(authorization ? { authorization } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function responseMessage(response: Response) {
  const payload = await response.text();
  const dataLine = payload.split("\n").find((line) => line.startsWith("data: "));
  expect(dataLine).toBeDefined();
  return JSON.parse(dataLine!.slice(6)) as Record<string, any>;
}

beforeAll(async () => {
  const authenticateRequest: typeof authenticate = async (request: Request, response: ExpressResponse, next: NextFunction) => {
    if (request.header("authorization") === "Bearer valid-test-token") {
      next();
      return;
    }
    response.setHeader(
      "WWW-Authenticate",
      'Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource/mcp"',
    );
    response.status(401).json({ error: "Unauthorized" });
  };
  const app = createHttpServer({ authenticateRequest });
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind to a TCP port");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

describe("protected resource metadata", () => {
  it("allows browser-based ChatGPT OAuth discovery from its official origins", async () => {
    const response = await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`, {
      headers: { origin: "https://chatgpt.com", accept: "application/json" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://chatgpt.com");
    expect(response.headers.get("access-control-allow-methods")).toContain("GET");
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  it("allows ChatGPT metadata preflight requests", async () => {
    const response = await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`, {
      method: "OPTIONS",
      headers: {
        origin: "https://chatgpt.com",
        "access-control-request-method": "GET",
        "access-control-request-headers": "accept",
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://chatgpt.com");
  });

  it("allows both official ChatGPT web origins to read discovery metadata", async () => {
    for (const origin of ["https://chatgpt.com", "https://chat.openai.com"]) {
      const response = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`, {
        headers: { origin, accept: "application/json" },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe(origin);
      expect(response.headers.get("access-control-allow-methods")).toContain("GET");
    }
  });

  it("rejects browser discovery from untrusted origins", async () => {
    const response = await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`, {
      headers: { origin: "https://attacker.example", accept: "application/json" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("omits scopes_supported when no scopes are required", async () => {
    const response = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      resource: "https://mcp.example.test/mcp",
      authorization_servers: ["https://issuer.example.test"],
      bearer_methods_supported: ["header"],
    });
  });
});

describe("HTTP OAuth authorization", () => {
  it("rejects unauthenticated MCP initialization with a protected-resource challenge", async () => {
    const response = await post(rpc("initialize", 1, {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "oauth-integration-test", version: "1.0.0" },
    }));
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toMatch(/^Bearer resource_metadata=/);
    expect(response.headers.get("www-authenticate")).not.toContain("error=");
    expect(response.headers.get("www-authenticate")).toContain(
      'resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it("allows authenticated MCP initialization", async () => {
    const response = await post(rpc("initialize", 1, {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "oauth-integration-test", version: "1.0.0" },
    }), "Bearer valid-test-token");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"serverInfo"');
  });

  it("rejects unauthenticated tool discovery", async () => {
    const response = await post(rpc("tools/list", 2));
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("resource_metadata=");
  });

  it("allows authenticated tool discovery and advertises OAuth security schemes", async () => {
    const response = await post(rpc("tools/list", 2), "Bearer valid-test-token");
    expect(response.status).toBe(200);
    const message = await responseMessage(response);
    const tools = message.result.tools as Array<{ name: string; _meta?: { securitySchemes?: Array<{ type: string; scopes: string[] }> } }>;
    expect(tools).toHaveLength(10);
    for (const tool of tools) {
      expect(tool._meta?.securitySchemes).toEqual([{ type: "oauth2", scopes: [] }]);
    }
  });

  it("rejects an unauthenticated tool call with an HTTP OAuth challenge", async () => {
    const response = await post(rpc("tools/call", 3, { name: "system.health", arguments: {} }));
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      'resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it("executes a protected tool when a valid bearer token is supplied", async () => {
    const response = await post(
      rpc("tools/call", 4, { name: "system.health", arguments: {} }),
      "Bearer valid-test-token",
    );
    expect(response.status).toBe(200);
    const message = await responseMessage(response);
    expect(message.result.isError).not.toBe(true);
    const health = JSON.parse(message.result.content[0].text) as { status: string };
    expect(health.status).toBe("healthy");
  });
});
