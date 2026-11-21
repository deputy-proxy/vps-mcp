#!/usr/bin/env node
const endpoint = process.env.MCP_URL ?? "https://194.163.133.147/mcp";
const timeoutMs = 12_000;

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function parseRpcResponse(text, contentType) {
  if (contentType.includes("text/event-stream")) {
    const data = text.split(/\r?\n/).find((line) => line.startsWith("data: "));
    assert(data, "MCP response did not contain an SSE data event");
    return JSON.parse(data.slice(6));
  }
  return JSON.parse(text);
}

async function request(url, init = {}) {
  return fetch(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function rpc(method, id, params = {}) {
  const response = await request(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  assert(response.status === 200, method + " returned HTTP " + response.status);
  const contentType = response.headers.get("content-type") ?? "";
  assert(contentType.includes("application/json") || contentType.includes("text/event-stream"),
    method + " returned an unsupported content type: " + contentType);
  return parseRpcResponse(await response.text(), contentType);
}

async function main() {
  const parsedEndpoint = new URL(endpoint);
  assert(parsedEndpoint.protocol === "https:", "MCP_URL must use HTTPS");
  assert(parsedEndpoint.pathname === "/mcp", "MCP_URL must end in /mcp");

  const origin = parsedEndpoint.origin;
  const metadataUrl = new URL("/.well-known/oauth-protected-resource/mcp", parsedEndpoint);
  const metadataResponse = await request(metadataUrl, {
    headers: { accept: "application/json" },
  });
  assert(metadataResponse.status === 200, "Protected-resource metadata returned HTTP " + metadataResponse.status);
  assert((metadataResponse.headers.get("content-type") ?? "").includes("application/json"),
    "Protected-resource metadata is not application/json");
  const resource = await metadataResponse.json();
  assert(resource.resource === endpoint, "Protected-resource metadata resource does not exactly match MCP_URL");
  assert(Array.isArray(resource.authorization_servers) && resource.authorization_servers.length > 0,
    "Protected-resource metadata has no authorization_servers");
  console.log("PASS protected-resource metadata");

  const corsResponse = await request(metadataUrl, {
    headers: { accept: "application/json", origin: "https://chatgpt.com" },
  });
  assert(corsResponse.status === 200, "CORS metadata GET returned HTTP " + corsResponse.status);
  assert(corsResponse.headers.get("access-control-allow-origin") === "https://chatgpt.com",
    "CORS metadata GET did not allow https://chatgpt.com");
  const preflight = await request(metadataUrl, {
    method: "OPTIONS",
    headers: {
      origin: "https://chatgpt.com",
      "access-control-request-method": "GET",
      "access-control-request-headers": "accept",
    },
  });
  assert(preflight.status === 204, "CORS metadata preflight returned HTTP " + preflight.status);
  console.log("PASS ChatGPT browser CORS");

  const issuer = resource.authorization_servers[0];
  const issuerUrl = new URL(issuer);
  const asMetadataResponse = await request(new URL("/.well-known/oauth-authorization-server", issuerUrl), {
    headers: { accept: "application/json" },
  });
  assert(asMetadataResponse.status === 200, "Authorization-server metadata returned HTTP " + asMetadataResponse.status);
  const asMetadata = await asMetadataResponse.json();
  assert(asMetadata.issuer === issuer, "Authorization-server metadata issuer does not exactly match protected-resource metadata");
  assert(typeof asMetadata.authorization_endpoint === "string", "authorization_endpoint is missing");
  assert(typeof asMetadata.token_endpoint === "string", "token_endpoint is missing");
  assert(asMetadata.code_challenge_methods_supported?.includes("S256"), "Authorization server does not advertise PKCE S256");
  const methods = asMetadata.token_endpoint_auth_methods_supported ?? [];
  assert(asMetadata.client_id_metadata_document_supported === true || typeof asMetadata.registration_endpoint === "string",
    "Authorization server advertises neither CIMD nor DCR");
  if (asMetadata.client_id_metadata_document_supported === true) {
    assert(methods.includes("none") || methods.includes("private_key_jwt"),
      "CIMD is advertised without a ChatGPT-compatible token endpoint authentication method");
  }
  console.log("PASS authorization-server metadata and client registration capabilities");

  const initialized = await rpc("initialize", 1, {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "github-public-smoke-test", version: "1.0.0" },
  });
  assert(initialized.result?.serverInfo?.name === "vps-mcp", "MCP initialize did not return vps-mcp serverInfo");
  console.log("PASS unauthenticated MCP initialize");

  const listed = await rpc("tools/list", 2);
  const tools = listed.result?.tools;
  assert(Array.isArray(tools) && tools.length === 10, "tools/list did not return the expected 10 tools");
  for (const tool of tools) {
    assert(tool._meta?.securitySchemes?.some((scheme) => scheme.type === "oauth2"),
      "Tool does not advertise OAuth security: " + tool.name);
  }
  console.log("PASS unauthenticated tools/list and OAuth security declarations (" + tools.length + " tools)");

  const challenge = await rpc("tools/call", 3, {
    name: "system.health",
    arguments: {},
  });
  assert(challenge.result?.isError === true, "Unauthenticated system.health did not return an MCP authorization error");
  const challenges = challenge.result?._meta?.["mcp/www_authenticate"];
  assert(Array.isArray(challenges) && challenges.some((value) => String(value).includes(metadataUrl.toString())),
    "Tool authorization error did not contain the protected-resource metadata challenge");
  console.log("PASS unauthenticated protected-tool OAuth challenge");

  console.log("PUBLIC MCP SMOKE TEST PASSED: " + origin);
}

main().catch((error) => {
  console.error("PUBLIC MCP SMOKE TEST FAILED:", error.message);
  process.exitCode = 1;
});
