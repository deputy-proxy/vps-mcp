import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Request, Response, NextFunction } from "express";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "vps-mcp-oauth-http-"));
process.env.MCP_AUTH_MODE = "oauth";
process.env.MCP_PUBLIC_URL = "https://mcp.example.com/mcp";
process.env.OAUTH_ISSUER_URL = "https://identity.example.com";
process.env.OAUTH_AUDIENCE = "https://mcp.example.com/mcp";
process.env.OAUTH_REQUIRED_SCOPES = "";
process.env.OAUTH_SUPPORTED_SCOPES = "vps:admin";
delete process.env.VPS_SERVICE_PROFILE_PROMOTION_ENABLED;
process.env.MCP_DATA_DIR = temporaryDirectory;
process.env.MCP_ALLOWED_ROOTS = temporaryDirectory;

const { createHttpServer } = await import("./server.js");

let server: Server;
let baseUrl: string;

function rpc(method: string, id: number, params: Record<string, unknown> = {}) {
  return { jsonrpc: "2.0", id, method, params };
}

async function request(method: string, id: number, params: Record<string, unknown> = {}, bearer?: string) {
  return fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(rpc(method, id, params)),
  });
}

function parseSse(text: string) {
  const line = text.split(String.fromCharCode(10)).find((entry) => entry.startsWith("data: "));
  if (!line) throw new Error("MCP response did not contain an SSE data event");
  return JSON.parse(line.slice(6)) as {
    result: {
      serverInfo?: { name: string };
      tools?: Array<Record<string, unknown>>;
      isError?: boolean;
      content?: Array<{ text?: string }>;
    };
  };
}

beforeAll(async () => {
  const authenticateRequest = (req: Request, res: Response, next: NextFunction) => {
    const authorization = req.header("authorization");
    if (authorization === "Bearer integration-test-token" || authorization === "Bearer integration-test-admin-token") {
      const authInfo: AuthInfo = {
        token: authorization.slice("Bearer ".length),
        clientId: "integration-test-client",
        scopes: authorization === "Bearer integration-test-admin-token" ? ["mcp", "vps:admin"] : ["mcp"],
      };
      (req as Request & { auth?: AuthInfo }).auth = authInfo;
      next();
      return;
    }
    res.setHeader(
      "WWW-Authenticate",
      'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"',
    );
    res.status(401).json({ error: "Unauthorized" });
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

describe("OAuth protected-resource discovery", () => {
  it.each([
    "/.well-known/oauth-protected-resource/mcp",
    "/.well-known/oauth-protected-resource/mcp%5C",
  ])("serves canonical metadata for %s", async (pathname) => {
    const response = await fetch(`${baseUrl}${pathname}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({
      resource: "https://mcp.example.com/mcp",
      authorization_servers: ["https://identity.example.com"],
      bearer_methods_supported: ["header"],
      scopes_supported: ["vps:admin"],
    });
  });

  it("does not accept arbitrary malformed metadata suffixes", async () => {
    const response = await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp%5Cextra`);
    expect(response.status).toBe(404);
  });
});
describe("server-level OAuth boundary", () => {
  it.each(["initialize", "tools/list", "tools/call"])("rejects unauthenticated %s before MCP transport", async (method) => {
    const params = method === "initialize"
      ? {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "integration-test", version: "1.0.0" },
        }
      : method === "tools/call"
        ? { name: "system.health", arguments: {} }
        : {};
    const response = await request(method, 1, params);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
    );
  });

  it("allows an authenticated client to initialize and list tools", async () => {
    const initialized = await request("initialize", 2, {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "integration-test", version: "1.0.0" },
    }, "integration-test-token");
    expect(initialized.status).toBe(200);
    expect(parseSse(await initialized.text()).result.serverInfo?.name).toBe("vps-mcp");

    const listed = await request("tools/list", 3, {}, "integration-test-token");
    expect(listed.status).toBe(200);
    const tools = parseSse(await listed.text()).result.tools ?? [];
    expect(tools).toHaveLength(65);
    for (const tool of tools) {
      expect(tool).not.toHaveProperty("_meta.securitySchemes");
    }
  });

  it("allows an authenticated client to execute a tool", async () => {
    const response = await request("tools/call", 4, {
      name: "system.health",
      arguments: {},
    }, "integration-test-token");
    expect(response.status).toBe(200);
    const payload = parseSse(await response.text());
    expect(payload.result).toBeDefined();
  });

  it("rejects profile promotion when an authenticated caller lacks vps:admin", async () => {
    const response = await request("tools/call", 5, {
      name: "project-environment.profile.promote",
      arguments: {
        profileId: "laravel-php",
        version: 3,
        imageDigest: "ghcr.io/deputy-proxy/vps-mcp-laravel-php@sha256:10a7f5152d0bea6be3bde3ea3c6697154f20245128372833629a6d547e298b72",
        approvalReference: "issue-42-disposable-laravel-acceptance",
      },
    }, "integration-test-token");
    expect(response.status).toBe(200);
    const payload = parseSse(await response.text());
    expect(payload.result.isError).toBe(true);
    expect(JSON.parse(payload.result.content?.[0]?.text ?? "{}")).toEqual({
      error: "Insufficient scope: vps:admin is required to promote service profiles",
    });
  });

  it("accepts vps:admin at the promotion tool boundary while keeping the feature flag independent", async () => {
    const response = await request("tools/call", 6, {
      name: "project-environment.profile.promote",
      arguments: {
        profileId: "laravel-php",
        version: 3,
        imageDigest: "ghcr.io/deputy-proxy/vps-mcp-laravel-php@sha256:10a7f5152d0bea6be3bde3ea3c6697154f20245128372833629a6d547e298b72",
        approvalReference: "issue-42-disposable-laravel-acceptance",
      },
    }, "integration-test-admin-token");
    expect(response.status).toBe(200);
    const payload = parseSse(await response.text());
    expect(payload.result.isError).toBe(true);
    expect(JSON.parse(payload.result.content?.[0]?.text ?? "{}")).toEqual({
      error: "Service profile promotion is disabled by server configuration",
    });
  });
});
