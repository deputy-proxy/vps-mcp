import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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
  return fetch(`${baseUrl}/mcp`, {
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
  const app = createHttpServer({ verifyOAuthAccessToken: async (authorization) => authorization === "Bearer valid-test-token" });
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

describe("per-tool OAuth authorization", () => {
  it("allows unauthenticated MCP initialization", async () => {
    const response = await post(rpc("initialize", 1, {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "oauth-integration-test", version: "1.0.0" },
    }));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"serverInfo"');
  });

  it("allows unauthenticated tool discovery and advertises OAuth on every tool", async () => {
    const response = await post(rpc("tools/list", 2));
    expect(response.status).toBe(200);
    const message = await responseMessage(response);
    const tools = message.result.tools as Array<{ name: string; _meta?: { securitySchemes?: Array<{ type: string; scopes: string[] }> } }>;
    expect(tools).toHaveLength(10);
    for (const tool of tools) {
      expect(tool._meta?.securitySchemes).toEqual([{ type: "oauth2", scopes: [] }]);
    }
  });

  it("rejects an unauthenticated tool call with the ChatGPT OAuth challenge", async () => {
    const response = await post(rpc("tools/call", 3, { name: "system.health", arguments: {} }));
    expect(response.status).toBe(200);
    const message = await responseMessage(response);
    expect(message.result.isError).toBe(true);
    expect(message.result._meta["mcp/www_authenticate"][0]).toContain(
      'resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource/mcp"',
    );
    expect(message.result._meta["mcp/www_authenticate"][0]).toContain('error_description="A valid OAuth access token is required"');
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
