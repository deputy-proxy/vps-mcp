import { describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import { createDashboardAuth } from "./dashboard-auth.js";

const baseConfig = {
  issuer: "https://example.authkit.app",
  clientId: "client_test",
  clientSecret: "test-client-secret",
  redirectUri: "http://localhost:3000/dashboard/auth/callback",
  allowedEmails: ["operator@example.com"],
  sessionTtlSeconds: 3600,
  secureCookies: false,
};

function responseMock() {
  const value: Record<string, unknown> = { headers: {}, statusCode: 200, body: null, redirectStatus: null, redirectUrl: null };
  value.setHeader = (name: string, content: unknown) => { (value.headers as Record<string, unknown>)[name] = content; return value; };
  value.status = (status: number) => { value.statusCode = status; return value; };
  value.type = (type: string) => { value.contentType = type; return value; };
  value.send = (body: unknown) => { value.body = body; return value; };
  value.json = (body: unknown) => { value.body = body; return value; };
  value.end = () => value;
  value.redirect = (status: number, url: string) => { value.redirectStatus = status; value.redirectUrl = url; return value; };
  return value as unknown as Response & Record<string, unknown>;
}

function requestMock(query: Record<string, string> = {}, headers: Record<string, string> = {}, method = "GET") {
  return { query, headers, header: (name: string) => headers[name.toLowerCase()], method } as unknown as Request;
}

function createHarness(email = "operator@example.com", overrides: Record<string, unknown> = {}) {
  let now = 1_800_000_000_000;
  let claims: Record<string, unknown> = {};
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes(".well-known/openid-configuration")) {
      return new Response(JSON.stringify({
        issuer: baseConfig.issuer,
        authorization_endpoint: "https://example.authkit.app/authorize",
        token_endpoint: "https://example.authkit.app/token",
        jwks_uri: "https://example.authkit.app/jwks",
        authorization_response_iss_parameter_supported: true,
        token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url === "https://example.authkit.app/token") {
      const form = new URLSearchParams(String(init?.body ?? ""));
      expect(form.get("grant_type")).toBe("authorization_code");
      expect(form.get("code_verifier")).toBeTruthy();
      return new Response(JSON.stringify({ id_token: "signed-test-id-token" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error("Unexpected provider URL");
  });
  const auth = createDashboardAuth({ ...baseConfig, ...overrides }, {
    fetcher,
    now: () => now,
    verifyIdToken: async () => claims,
  });
  return {
    auth, fetcher,
    setClaims(value: Record<string, unknown>) { claims = value; },
    advance(ms: number) { now += ms; },
  };
}

async function startLogin(auth: ReturnType<typeof createDashboardAuth>) {
  const response = responseMock();
  await auth.begin(requestMock(), response);
  const location = String(response.redirectUrl);
  const url = new URL(location);
  const stateCookieHeader = String((response.headers as Record<string, unknown>)["Set-Cookie"]);
  const stateCookie = stateCookieHeader.split(";")[0]!;
  return { response, state: url.searchParams.get("state")!, nonce: url.searchParams.get("nonce")!, stateCookie, url };
}

describe("dashboard browser authentication", () => {
  it("starts Authorization Code + PKCE with state, nonce and S256", async () => {
    const harness = createHarness();
    const login = await startLogin(harness.auth);
    expect(login.response.redirectStatus).toBe(302);
    expect(login.url.searchParams.get("response_type")).toBe("code");
    expect(login.url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(login.url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(login.url.searchParams.get("scope")).toBe("openid profile email");
    expect(login.state).toHaveLength(43);
    expect(login.nonce).toHaveLength(43);
    expect(login.stateCookie).toBe("vps_dashboard_state=" + login.state);
  });

  it("exchanges a valid callback and issues an HttpOnly SameSite session cookie", async () => {
    const harness = createHarness();
    const login = await startLogin(harness.auth);
    harness.setClaims({
      sub: "user_123", email: "operator@example.com", email_verified: true,
      nonce: login.nonce, exp: 1_800_003_600,
    });
    const response = responseMock();
    await harness.auth.callback(requestMock({ state: login.state, code: "one-time-code", iss: baseConfig.issuer }, { cookie: login.stateCookie }), response);
    expect(response.statusCode).toBe(200);
    expect(response.redirectStatus).toBe(303);
    expect(response.redirectUrl).toBe("/dashboard");
    const cookies = (response.headers as Record<string, unknown>)["Set-Cookie"] as string[];
    const cookie = cookies.find((item) => item.startsWith("vps_dashboard="))!;
    expect(cookie).toMatch(/^vps_dashboard=[A-Za-z0-9_-]+;/);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).not.toContain("Secure");
    expect(harness.fetcher).toHaveBeenCalledTimes(2);

    const request = requestMock({}, { cookie: cookie.split(";")[0]! });
    const next = vi.fn();
    harness.auth.requireSession({ api: true })(request, responseMock(), next as NextFunction);
    expect(next).toHaveBeenCalledOnce();
  });

  it("rejects a callback when the browser does not hold the initiating state cookie", async () => {
    const harness = createHarness();
    const login = await startLogin(harness.auth);
    const response = responseMock();
    await harness.auth.callback(requestMock({ state: login.state, code: "code", iss: baseConfig.issuer }), response);
    expect(response.statusCode).toBe(400);
    expect(String((response.headers as Record<string, unknown>)["Set-Cookie"])).toContain("Max-Age=0");
  });

  it("rejects state replay, unverified email and identities outside the allowlist", async () => {
    const replayHarness = createHarness();
    const login = await startLogin(replayHarness.auth);
    const replayResponse = responseMock();
    await replayHarness.auth.callback(requestMock({ state: login.state, code: "code", iss: baseConfig.issuer }, { cookie: login.stateCookie }), replayResponse);
    expect(replayResponse.statusCode).toBe(403);
    const replayAgain = responseMock();
    await replayHarness.auth.callback(requestMock({ state: login.state, code: "code", iss: baseConfig.issuer }, { cookie: login.stateCookie }), replayAgain);
    expect(replayAgain.statusCode).toBe(400);

    const deniedHarness = createHarness("intruder@example.com");
    const deniedLogin = await startLogin(deniedHarness.auth);
    deniedHarness.setClaims({
      sub: "user_456", email: "intruder@example.com", email_verified: true,
      nonce: deniedLogin.nonce, exp: 1_800_003_600,
    });
    const deniedResponse = responseMock();
    await deniedHarness.auth.callback(requestMock({ state: deniedLogin.state, code: "code", iss: baseConfig.issuer }, { cookie: deniedLogin.stateCookie }), deniedResponse);
    expect(deniedResponse.statusCode).toBe(403);
    const deniedCookies = String((deniedResponse.headers as Record<string, unknown>)["Set-Cookie"]);
    expect(deniedCookies).toContain("vps_dashboard_state=");
    expect(deniedCookies).not.toContain("vps_dashboard=");
  });

  it("requires the authorization response issuer when discovery advertises issuer identification", async () => {
    const harness = createHarness();
    const login = await startLogin(harness.auth);
    const response = responseMock();
    await harness.auth.callback(requestMock({ state: login.state, code: "code" }, { cookie: login.stateCookie }), response);
    expect(response.statusCode).toBe(403);
  });

  it("uses a Secure __Host cookie for HTTPS deployments", async () => {
    const harness = createHarness("operator@example.com", {
      redirectUri: "https://vps.example.com/dashboard/auth/callback",
      secureCookies: true,
    });
    const login = await startLogin(harness.auth);
    harness.setClaims({
      sub: "user_123", email: "operator@example.com", email_verified: true,
      nonce: login.nonce, exp: 1_800_003_600,
    });
    const response = responseMock();
    await harness.auth.callback(requestMock({ state: login.state, code: "code", iss: baseConfig.issuer }, { cookie: login.stateCookie }), response);
    const cookies = (response.headers as Record<string, unknown>)["Set-Cookie"] as string[];
    const cookie = cookies.find((item) => item.startsWith("__Host-vps_dashboard="))!;
    expect(cookie).toMatch(/^__Host-vps_dashboard=/);
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Path=/");
    const stateCookie = String((login.response.headers as Record<string, unknown>)["Set-Cookie"]);
    expect(stateCookie).toMatch(/^__Host-vps_dashboard_state=/);
    expect(stateCookie).toContain("Secure");
    expect(stateCookie).toContain("HttpOnly");
  });

  it("rejects nonce mismatch and expired authorization state", async () => {
    const nonceHarness = createHarness();
    const nonceLogin = await startLogin(nonceHarness.auth);
    nonceHarness.setClaims({
      sub: "user_123", email: "operator@example.com", email_verified: true,
      nonce: "wrong-nonce", exp: 1_800_003_600,
    });
    const nonceResponse = responseMock();
    await nonceHarness.auth.callback(requestMock({ state: nonceLogin.state, code: "code", iss: baseConfig.issuer }, { cookie: nonceLogin.stateCookie }), nonceResponse);
    expect(nonceResponse.statusCode).toBe(403);

    const expiryHarness = createHarness();
    const expiryLogin = await startLogin(expiryHarness.auth);
    expiryHarness.advance(5 * 60 * 1000 + 1);
    const expiryResponse = responseMock();
    await expiryHarness.auth.callback(requestMock({ state: expiryLogin.state, code: "code" }, { cookie: expiryLogin.stateCookie }), expiryResponse);
    expect(expiryResponse.statusCode).toBe(400);
  });

  it("returns API 401 without a session and enforces same-origin logout", async () => {
    const harness = createHarness();
    const response = responseMock();
    const next = vi.fn();
    harness.auth.requireSession({ api: true })(requestMock(), response, next as NextFunction);
    expect(response.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();

    const htmlResponse = responseMock();
    harness.auth.requireSession()(requestMock(), htmlResponse, next as NextFunction);
    expect(htmlResponse.redirectStatus).toBe(303);
    expect(htmlResponse.redirectUrl).toBe("/dashboard/auth/login");

    const deniedLogout = responseMock();
    harness.auth.logout(requestMock({}, { origin: "https://attacker.example" }, "POST"), deniedLogout);
    expect(deniedLogout.statusCode).toBe(403);
  });
});
