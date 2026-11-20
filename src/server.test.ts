import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const token = "integration-test-token-with-at-least-32-characters";
const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "vps-mcp-http-"));
process.env.MCP_AUTH_MODE = "token";
process.env.MCP_AUTH_TOKEN = token;
process.env.MCP_CORS_ORIGINS = "https://client.example";
process.env.MCP_DATA_DIR = temporaryDirectory;
process.env.MCP_ALLOWED_ROOTS = temporaryDirectory;

const { createHttpServer } = await import("./server.js");

let server: Server;
let baseUrl: string;

async function request(method: string, body?: unknown, headers: Record<string, string> = {}) {
  return fetch(`${baseUrl}/mcp`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function rpc(method: string, id: number, params: Record<string, unknown> = {}) {
  return { jsonrpc: "2.0", id, method, params };
}

beforeAll(async () => {
  const app = createHttpServer();
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

describe("Streamable HTTP endpoint", () => {
  it("keeps the health endpoint public", async () => {
    const response = await fetch(`${baseUrl}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok", service: "vps-mcp" });
  });

  it("rejects requests without a bearer token", async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(rpc("initialize", 1, {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "integration-test", version: "1.0.0" },
      })),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("initializes a client using Streamable HTTP", async () => {
    const response = await request("POST", rpc("initialize", 1, {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "integration-test", version: "1.0.0" },
    }), { accept: "application/json, text/event-stream" });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const payload = await response.text();
    expect(payload).toContain('"serverInfo"');
    expect(payload).toContain('"vps-mcp"');
    expect(response.headers.get("mcp-session-id")).toBeNull();
  });

  it("serves tools/list as a stateless POST without a session ID", async () => {
    const response = await request("POST", rpc("tools/list", 2), {
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-03-26",
    });
    expect(response.status).toBe(200);
    const payload = await response.text();
    expect(payload).toContain('"system.health"');
    expect(payload).toContain('"terminal.execute"');
    expect(response.headers.get("mcp-session-id")).toBeNull();
  });

  it("executes a registered tool through JSON-RPC", async () => {
    const response = await request("POST", rpc("tools/call", 3, {
      name: "system.health",
      arguments: {},
    }), {
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-03-26",
    });
    expect(response.status).toBe(200);
    const payload = await response.text();
    const dataLine = payload.split("\n").find((line) => line.startsWith("data: "));
    expect(dataLine).toBeDefined();
    const message = JSON.parse(dataLine!.slice(6)) as { result: { content: Array<{ text: string }> } };
    const health = JSON.parse(message.result.content[0]!.text) as { status: string; dataDirectoryWritable: boolean };
    expect(health.status).toBe("healthy");
    expect(health.dataDirectoryWritable).toBe(true);
  });

  it.each(["GET", "DELETE", "PATCH"])("%s is rejected for this stateless endpoint", async (method) => {
    const response = await request(method);
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });
});

describe("CORS policy", () => {
  it("allows preflight only for POST and supported headers", async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "OPTIONS",
      headers: {
        origin: "https://client.example",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type,mcp-protocol-version",
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://client.example");
    expect(response.headers.get("access-control-allow-methods")).toBe("POST");
    expect(response.headers.get("access-control-allow-headers")).toContain("authorization");
    expect(response.headers.get("access-control-expose-headers")).toContain("www-authenticate");
    expect(response.headers.get("vary")).toContain("Origin");
  });

  it.each([
    ["https://attacker.example", "POST", "authorization"],
    ["https://client.example", "DELETE", "authorization"],
    ["https://client.example", "POST", "x-evil-header"],
  ])("rejects preflight with origin=%s method=%s headers=%s", async (origin, method, headers) => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "OPTIONS",
      headers: {
        origin,
        "access-control-request-method": method,
        "access-control-request-headers": headers,
      },
    });
    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBe(origin === "https://client.example" ? origin : null);
  });

  it("does not grant CORS access to an unconfigured origin on normal requests", async () => {
    const response = await request("POST", rpc("tools/list", 4), {
      origin: "https://attacker.example",
      accept: "application/json, text/event-stream",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});
