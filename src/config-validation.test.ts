import { describe, expect, it } from "vitest";
import { parseCorsOrigins, parseHttpsUrl, parseOAuthAudience, parsePublicMcpUrl } from "./config-validation.js";

describe("OAuth URL configuration", () => {
  it("requires canonical HTTPS MCP resource URLs", () => {
    expect(parsePublicMcpUrl("https://mcp.example.com/mcp")?.toString()).toBe("https://mcp.example.com/mcp");
    expect(() => parsePublicMcpUrl("http://mcp.example.com/mcp")).toThrow("must use HTTPS");
    expect(() => parsePublicMcpUrl("https://mcp.example.com/")).toThrow("ending in /mcp");
    expect(() => parsePublicMcpUrl("https://user:pass@mcp.example.com/mcp")).toThrow("credentials");
    expect(() => parsePublicMcpUrl("https://mcp.example.com/mcp?debug=1")).toThrow("query or fragment");
  });

  it("requires an HTTPS URL for the OAuth audience", () => {
    expect(parseOAuthAudience("https://mcp.example.com/mcp", true)).toBe("https://mcp.example.com/mcp");
    expect(() => parseOAuthAudience("mcp-resource", true)).toThrow("valid absolute URL");
    expect(() => parseOAuthAudience("http://mcp.example.com/mcp", true)).toThrow("must use HTTPS");
  });

  it("validates issuer and optional JWKS URLs", () => {
    expect(parseHttpsUrl("OAUTH_ISSUER_URL", "https://identity.example.com/")?.hostname).toBe("identity.example.com");
    expect(() => parseHttpsUrl("OAUTH_ISSUER_URL", "not-a-url", true)).toThrow("valid absolute URL");
    expect(() => parseHttpsUrl("OAUTH_JWKS_URL", "http://identity.example.com/jwks")).toThrow("must use HTTPS");
  });
});

describe("CORS origin configuration", () => {
  it("accepts exact HTTPS origins and localhost development origins", () => {
    expect(parseCorsOrigins("https://client.example,http://localhost:5173,https://other.example"))
      .toEqual(["https://client.example", "http://localhost:5173", "https://other.example"]);
  });

  it("deduplicates origins", () => {
    expect(parseCorsOrigins("https://client.example,https://client.example")).toEqual(["https://client.example"]);
  });

  it.each([
    "*",
    "https://*.example.com",
    "http://client.example",
    "https://client.example/path",
    "https://client.example?x=1",
    "https://user:pass@client.example",
    "not-a-url",
  ])("rejects unsafe or malformed origin %s", (origin) => {
    expect(() => parseCorsOrigins(origin)).toThrow();
  });
});
