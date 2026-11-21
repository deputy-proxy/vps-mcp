import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";

process.env.MCP_AUTH_TOKEN ??= "test-only-token-that-is-long-enough-for-vps-mcp";
const { createOAuthAuthenticator, hasRequiredScopes, resolveJwksUrl } = await import("./security.js");

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
      issuer: issuer.toString(), jwks_uri: "https://identity.example.com/keys",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    await expect(resolveJwksUrl(issuer, undefined, fetcher as typeof fetch))
      .resolves.toEqual(new URL("https://identity.example.com/keys"));
    expect(fetcher).toHaveBeenCalledWith(
      new URL("https://identity.example.com/tenant/.well-known/openid-configuration"),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
  it("preserves an origin-only issuer without adding a trailing slash", async () => {
    const exactIssuer = "https://identity.example.com";
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      issuer: exactIssuer, jwks_uri: "https://identity.example.com/oauth2/jwks",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    await expect(resolveJwksUrl(exactIssuer, undefined, fetcher as typeof fetch))
      .resolves.toEqual(new URL("https://identity.example.com/oauth2/jwks"));
    expect(fetcher).toHaveBeenCalledWith(
      new URL("https://identity.example.com/.well-known/openid-configuration"),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
  it("rejects a discovery document for a different issuer", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      issuer: "https://attacker.example.com", jwks_uri: "https://attacker.example.com/jwks",
    }), { status: 200 }));
    await expect(resolveJwksUrl(issuer, undefined, fetcher as typeof fetch))
      .rejects.toThrow("issuer does not exactly match");
  });
  it("rejects non-HTTPS signing-key URLs", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      issuer: issuer.toString(), jwks_uri: "http://identity.example.com/jwks",
    }), { status: 200 }));
    await expect(resolveJwksUrl(issuer, undefined, fetcher as typeof fetch)).rejects.toThrow("must use HTTPS");
  });
  it("rejects failed discovery responses and missing jwks_uri", async () => {
    const failed = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    await expect(resolveJwksUrl(issuer, undefined, failed as typeof fetch)).rejects.toThrow("HTTP 503");
    const missing = vi.fn().mockResolvedValue(new Response(JSON.stringify({ issuer: issuer.toString() }), { status: 200 }));
    await expect(resolveJwksUrl(issuer, undefined, missing as typeof fetch)).rejects.toThrow("missing jwks_uri");
  });
});

describe("OAuth authentication middleware", () => {
  const issuer = "https://identity.example.com/";
  const audience = "https://mcp.example.com/mcp";
  const publicUrl = new URL(audience);
  const requiredScopes = ["mcp", "vps:admin"];
  let server: Server;
  let baseUrl: string;
  let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
  let validKeySet: ReturnType<typeof createLocalJWKSet>;

  async function token(overrides: {
    issuer?: string; audience?: string; scope?: string; expiration?: number;
    key?: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
  } = {}) {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ scope: overrides.scope ?? "mcp vps:admin" })
      .setProtectedHeader({ alg: "RS256", kid: "valid-key" })
      .setIssuer(overrides.issuer ?? issuer)
      .setAudience(overrides.audience ?? audience)
      .setIssuedAt(now - 1)
      .setExpirationTime(overrides.expiration ?? now + 300)
      .sign(overrides.key ?? privateKey);
  }

  beforeAll(async () => {
    const validPair = await generateKeyPair("RS256");
    privateKey = validPair.privateKey;
    const publicJwk = await exportJWK(validPair.publicKey);
    validKeySet = createLocalJWKSet({
      keys: [{ ...publicJwk, kid: "valid-key", alg: "RS256", use: "sig" }],
    });

    const app = express();
    app.get("/protected", createOAuthAuthenticator(
      { issuer, audience, scopes: requiredScopes, publicUrl },
      async () => validKeySet,
    ), (_request, response) => response.status(200).json({ authenticated: true }));
    app.get("/unavailable", createOAuthAuthenticator(
      { issuer, audience, scopes: requiredScopes, publicUrl },
      async () => { throw new Error("discovery unavailable"); },
    ), (_request, response) => response.status(200).json({ authenticated: true }));

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
  });

  async function request(path: string, bearer?: string) {
    return fetch(`${baseUrl}${path}`, { headers: bearer ? { authorization: `Bearer ${bearer}` } : {} });
  }

  it("accepts a valid signed JWT with the required issuer, audience and scopes", async () => {
    const response = await request("/protected", await token());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ authenticated: true });
  });
  it("rejects a missing bearer token and advertises protected-resource metadata", async () => {
    const response = await request("/protected");
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toMatch(/^Bearer resource_metadata=/);
    expect(response.headers.get("www-authenticate")).not.toContain("error=");
    expect(response.headers.get("www-authenticate")).toContain(
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
    );
    expect(response.headers.get("www-authenticate")).toContain('scope="mcp vps:admin"');
  });
  it("rejects an expired JWT", async () => {
    const expired = await token({ expiration: Math.floor(Date.now() / 1000) - 30 });
    expect((await request("/protected", expired)).status).toBe(401);
  });
  it("rejects a JWT with the wrong issuer", async () => {
    expect((await request("/protected", await token({ issuer: "https://attacker.example/" }))).status).toBe(401);
  });
  it("rejects a JWT with the wrong audience", async () => {
    expect((await request("/protected", await token({ audience: "https://other.example/mcp" }))).status).toBe(401);
  });
  it("rejects a JWT with an invalid signature", async () => {
    const otherPair = await generateKeyPair("RS256");
    expect((await request("/protected", await token({ key: otherPair.privateKey }))).status).toBe(401);
  });
  it("returns 403 and the required scope challenge when scopes are insufficient", async () => {
    const response = await request("/protected", await token({ scope: "mcp" }));
    expect(response.status).toBe(403);
    expect(response.headers.get("www-authenticate")).toContain('error="insufficient_scope"');
    expect(response.headers.get("www-authenticate")).toContain('scope="mcp vps:admin"');
  });
  it("returns 503 when the JWKS/discovery resolver is unavailable", async () => {
    expect((await request("/unavailable", await token())).status).toBe(503);
  });
});
