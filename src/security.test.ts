import { describe, expect, it, vi } from "vitest";
import { hasRequiredScopes, resolveJwksUrl } from "./security.js";

describe("hasRequiredScopes", () => {
  it("accepts a scope string containing every required scope", () => {
    expect(hasRequiredScopes({ scope: "openid mcp admin" }, ["mcp", "openid"])).toBe(true);
  });

  it("accepts the array-form scp claim", () => {
    expect(hasRequiredScopes({ scp: ["mcp", "read"] }, ["mcp"])).toBe(true);
  });

  it("rejects missing scopes and partial scope names", () => {
    expect(hasRequiredScopes({ scope: "mcp-read" }, ["mcp"])).toBe(false);
    expect(hasRequiredScopes({ scope: "mcp" }, ["mcp", "admin"])).toBe(false);
    expect(hasRequiredScopes({}, ["mcp"])).toBe(false);
  });

  it("rejects non-string values in scp", () => {
    expect(hasRequiredScopes({ scp: ["mcp", 42] }, ["mcp", "admin"])).toBe(false);
  });
});

describe("resolveJwksUrl", () => {
  const issuer = new URL("https://identity.example.com/tenant");

  it("uses the explicit HTTPS JWKS URL without discovery", async () => {
    const fetcher = vi.fn();
    const explicit = new URL("https://keys.example.com/jwks");
    await expect(resolveJwksUrl(issuer, explicit, fetcher as typeof fetch)).resolves.toEqual(explicit);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("discovers jwks_uri from the issuer's OIDC discovery document", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      issuer: issuer.toString(),
      jwks_uri: "https://identity.example.com/keys",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    await expect(resolveJwksUrl(issuer, undefined, fetcher as typeof fetch))
      .resolves.toEqual(new URL("https://identity.example.com/keys"));
    expect(fetcher).toHaveBeenCalledWith(
      new URL("https://identity.example.com/tenant/.well-known/openid-configuration"),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("rejects a discovery document for a different issuer", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      issuer: "https://attacker.example.com",
      jwks_uri: "https://attacker.example.com/jwks",
    }), { status: 200 }));
    await expect(resolveJwksUrl(issuer, undefined, fetcher as typeof fetch))
      .rejects.toThrow("issuer does not exactly match");
  });

  it("rejects non-HTTPS signing-key URLs", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      issuer: issuer.toString(),
      jwks_uri: "http://identity.example.com/jwks",
    }), { status: 200 }));
    await expect(resolveJwksUrl(issuer, undefined, fetcher as typeof fetch))
      .rejects.toThrow("must use HTTPS");
  });

  it("rejects failed discovery responses and missing jwks_uri", async () => {
    const failed = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    await expect(resolveJwksUrl(issuer, undefined, failed as typeof fetch))
      .rejects.toThrow("HTTP 503");

    const missing = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      issuer: issuer.toString(),
    }), { status: 200 }));
    await expect(resolveJwksUrl(issuer, undefined, missing as typeof fetch))
      .rejects.toThrow("missing jwks_uri");
  });
});
