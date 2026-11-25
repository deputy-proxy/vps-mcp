import { createHash, randomBytes } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";

export type DashboardAuthConfig = {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  allowedEmails: string[];
  sessionTtlSeconds: number;
  secureCookies: boolean;
};

type OidcMetadata = {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  issuerParameterRequired: boolean;
  tokenEndpointAuthMethod: "client_secret_basic" | "client_secret_post";
};

type ProviderMetadata = {
  issuer?: unknown;
  authorization_endpoint?: unknown;
  token_endpoint?: unknown;
  jwks_uri?: unknown;
  authorization_response_iss_parameter_supported?: unknown;
  token_endpoint_auth_methods_supported?: unknown;
};

type PendingAuthorization = {
  nonce: string;
  verifier: string;
  expiresAt: number;
};

type DashboardSession = {
  subject: string;
  email: string;
  expiresAt: number;
};

type DashboardAuthDependencies = {
  fetcher?: typeof fetch;
  now?: () => number;
  verifyIdToken?: (token: string, metadata: { issuer: string; jwksUri: string; clientId: string }) => Promise<Record<string, unknown>>;
};

const PENDING_TTL_MS = 5 * 60 * 1000;
const MAX_PENDING = 256;
const MAX_SESSIONS = 1000;
const SESSION_COOKIE_SECURE = "__Host-vps_dashboard";
const SESSION_COOKIE_INSECURE = "vps_dashboard";
const STATE_COOKIE_SECURE = "__Host-vps_dashboard_state";
const STATE_COOKIE_INSECURE = "vps_dashboard_state";

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try { return new URL(value).protocol === "https:"; } catch { return false; }
}

function cookieValue(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1 || part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim() || null;
  }
  return null;
}

function cookieHeader(name: string, value: string, options: { secure: boolean; maxAge: number }): string {
  return [
    name + "=" + value,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=" + String(Math.max(0, Math.floor(options.maxAge))),
    ...(options.secure ? ["Secure"] : []),
  ].join("; ");
}

function safeRedirect(response: Response, destination: string): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.redirect(303, destination);
}

export function createDashboardAuth(config: DashboardAuthConfig, dependencies: DashboardAuthDependencies = {}) {
  const fetcher = dependencies.fetcher ?? fetch;
  const now = dependencies.now ?? Date.now;
  const secure = config.secureCookies;
  const cookieName = secure ? SESSION_COOKIE_SECURE : SESSION_COOKIE_INSECURE;
  const stateCookieName = secure ? STATE_COOKIE_SECURE : STATE_COOKIE_INSECURE;
  const redirectOrigin = new URL(config.redirectUri).origin;
  const pending = new Map<string, PendingAuthorization>();
  const sessions = new Map<string, DashboardSession>();
  let metadataPromise: Promise<{
    authorizationEndpoint: string; tokenEndpoint: string; jwksUri: string;
    issuerParameterRequired: boolean; tokenEndpointAuthMethod: "client_secret_basic" | "client_secret_post";
  }> | null = null;
  let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

  function sweep(): void {
    const timestamp = now();
    for (const [state, item] of pending) if (item.expiresAt <= timestamp) pending.delete(state);
    for (const [id, session] of sessions) if (session.expiresAt <= timestamp) sessions.delete(id);
    while (pending.size > MAX_PENDING) pending.delete(pending.keys().next().value!);
  }

  async function providerMetadata(): Promise<OidcMetadata> {
    if (metadataPromise) return metadataPromise;
    const promise: Promise<OidcMetadata> = (async () => {
      const issuerUrl = new URL(config.issuer);
      if (issuerUrl.protocol !== "https:") throw new Error("OIDC issuer must use HTTPS");
      if (!issuerUrl.pathname.endsWith("/")) issuerUrl.pathname += "/";
      const discoveryUrl = new URL(".well-known/openid-configuration", issuerUrl);
      const response = await fetcher(discoveryUrl, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5000), redirect: "error" });
      if (!response.ok) throw new Error("OIDC discovery is unavailable");
      const document = await response.json() as ProviderMetadata;
      if (document.issuer !== config.issuer) throw new Error("OIDC discovery issuer does not match configured issuer");
      if (!isHttpsUrl(document.authorization_endpoint) || !isHttpsUrl(document.token_endpoint) || !isHttpsUrl(document.jwks_uri)) {
        throw new Error("OIDC discovery contains an invalid endpoint");
      }
      const advertisedMethods = Array.isArray(document.token_endpoint_auth_methods_supported)
        ? document.token_endpoint_auth_methods_supported.filter((item): item is string => typeof item === "string")
        : [];
      const tokenEndpointAuthMethod: "client_secret_basic" | "client_secret_post" | null =
        advertisedMethods.length === 0 || advertisedMethods.includes("client_secret_basic")
          ? "client_secret_basic"
          : advertisedMethods.includes("client_secret_post") ? "client_secret_post" : null;
      if (!tokenEndpointAuthMethod) throw new Error("OIDC token endpoint has no supported confidential-client authentication method");
      return {
        authorizationEndpoint: document.authorization_endpoint,
        tokenEndpoint: document.token_endpoint,
        jwksUri: document.jwks_uri,
        issuerParameterRequired: document.authorization_response_iss_parameter_supported === true,
        tokenEndpointAuthMethod,
      };
    })().catch((error) => {
      metadataPromise = null;
      throw error;
    });
    metadataPromise = promise;
    return promise;
  }

  async function verifyIdToken(token: string, metadata: { issuer: string; jwksUri: string; clientId: string }) {
    if (dependencies.verifyIdToken) return dependencies.verifyIdToken(token, metadata);
    jwks ??= createRemoteJWKSet(new URL(metadata.jwksUri));
    const verified = await jwtVerify(token, jwks, {
      issuer: metadata.issuer,
      audience: metadata.clientId,
      algorithms: ["RS256", "RS384", "RS512", "ES256", "ES384", "ES512"],
    });
    return verified.payload as Record<string, unknown>;
  }

  async function begin(_request: Request, response: Response): Promise<void> {
    sweep();
    try {
      const metadata = await providerMetadata();
      const state = randomBytes(32).toString("base64url");
      const nonce = randomBytes(32).toString("base64url");
      const verifier = randomBytes(48).toString("base64url");
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      pending.set(state, { nonce, verifier, expiresAt: now() + PENDING_TTL_MS });
      const authorizationUrl = new URL(metadata.authorizationEndpoint);
      authorizationUrl.searchParams.set("response_type", "code");
      authorizationUrl.searchParams.set("client_id", config.clientId);
      authorizationUrl.searchParams.set("redirect_uri", config.redirectUri);
      authorizationUrl.searchParams.set("scope", "openid profile email");
      authorizationUrl.searchParams.set("state", state);
      authorizationUrl.searchParams.set("nonce", nonce);
      authorizationUrl.searchParams.set("code_challenge", challenge);
      authorizationUrl.searchParams.set("code_challenge_method", "S256");
      response.setHeader("Set-Cookie", cookieHeader(stateCookieName, state, { secure, maxAge: PENDING_TTL_MS / 1000 }));
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Referrer-Policy", "no-referrer");
      response.redirect(302, authorizationUrl.toString());
    } catch {
      response.status(503).type("text/plain").send("Dashboard authentication is temporarily unavailable.");
    }
  }

  async function callback(request: Request, response: Response): Promise<void> {
    sweep();
    const state = typeof request.query.state === "string" ? request.query.state : "";
    const code = typeof request.query.code === "string" ? request.query.code : "";
    const responseIssuer = typeof request.query.iss === "string" ? request.query.iss : null;
    const authorization = pending.get(state);
    const stateCookie = cookieValue(request.headers.cookie, stateCookieName);
    pending.delete(state);
    const clearStateCookie = cookieHeader(stateCookieName, "", { secure, maxAge: 0 });
    if (!authorization || authorization.expiresAt <= now() || !code || code.length > 4096
      || stateCookie !== state || (responseIssuer !== null && responseIssuer !== config.issuer)) {
      response.setHeader("Set-Cookie", clearStateCookie);
      response.status(400).type("text/plain").send("Invalid or expired dashboard authorization.");
      return;
    }

    try {
      const metadata = await providerMetadata();
      if (metadata.issuerParameterRequired && responseIssuer !== config.issuer) {
        throw new Error("Authorization response issuer is missing or invalid");
      }
      const formEncode = (value: string) => new URLSearchParams({ value }).toString().slice("value=".length);
      const credentials = Buffer.from(formEncode(config.clientId) + ":" + formEncode(config.clientSecret)).toString("base64");
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: config.redirectUri,
        code_verifier: authorization.verifier,
      });
      const tokenHeaders: Record<string, string> = {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      };
      if (metadata.tokenEndpointAuthMethod === "client_secret_basic") {
        tokenHeaders.authorization = "Basic " + credentials;
      } else {
        body.set("client_id", config.clientId);
        body.set("client_secret", config.clientSecret);
      }
      const tokenResponse = await fetcher(metadata.tokenEndpoint, {
        method: "POST",
        headers: tokenHeaders,
        body,
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
      });
      if (!tokenResponse.ok) throw new Error("Token exchange failed");
      const tokenPayload = await tokenResponse.json() as { id_token?: unknown };
      if (typeof tokenPayload.id_token !== "string" || tokenPayload.id_token.length > 32_768) throw new Error("ID token is missing");
      const claims = await verifyIdToken(tokenPayload.id_token, {
        issuer: config.issuer,
        jwksUri: metadata.jwksUri,
        clientId: config.clientId,
      });
      if (claims.nonce !== authorization.nonce) throw new Error("OIDC nonce validation failed");
      if (typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 512) throw new Error("OIDC subject is invalid");
      if (typeof claims.email !== "string" || claims.email.length > 320 || claims.email_verified !== true) {
        throw new Error("A verified email address is required");
      }
      if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp * 1000 <= now()) {
        throw new Error("ID token expiry is missing or invalid");
      }
      if (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== config.clientId) {
        throw new Error("OIDC authorized party validation failed");
      }
      const email = claims.email.toLowerCase();
      if (!config.allowedEmails.includes(email)) throw new Error("Identity is not authorized for the dashboard");
      const tokenExpiry = claims.exp * 1000;
      const expiresAt = Math.min(now() + config.sessionTtlSeconds * 1000, tokenExpiry);
      if (expiresAt <= now()) throw new Error("ID token has expired");
      const sessionId = randomBytes(32).toString("base64url");
      sessions.set(sessionId, { subject: claims.sub, email, expiresAt });
      while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value!);
      response.setHeader("Set-Cookie", [
        cookieHeader(cookieName, sessionId, { secure, maxAge: (expiresAt - now()) / 1000 }),
        clearStateCookie,
      ]);
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Referrer-Policy", "no-referrer");
      safeRedirect(response, "/dashboard");
    } catch {
      response.setHeader("Set-Cookie", clearStateCookie);
      response.status(403).type("text/plain").send("Dashboard sign-in was rejected.");
    }
  }

  function requireSession(options: { api?: boolean } = {}) {
    return (request: Request, response: Response, next: NextFunction): void => {
      sweep();
      const id = cookieValue(request.headers.cookie, cookieName);
      const session = id ? sessions.get(id) : undefined;
      if (!session || session.expiresAt <= now()) {
        if (id) sessions.delete(id);
        response.setHeader("Cache-Control", "no-store");
        if (options.api) response.status(401).json({ error: "unauthorized" });
        else safeRedirect(response, "/dashboard/auth/login");
        return;
      }
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Vary", "Cookie");
      next();
    };
  }

  function logout(request: Request, response: Response): void {
    if (request.method !== "POST") {
      response.setHeader("Allow", "POST");
      response.status(405).end();
      return;
    }
    const origin = request.header("origin");
    if (origin && origin !== redirectOrigin) {
      response.status(403).json({ error: "forbidden" });
      return;
    }
    const id = cookieValue(request.headers.cookie, cookieName);
    if (id) sessions.delete(id);
    response.setHeader("Set-Cookie", [
      cookieHeader(cookieName, "", { secure, maxAge: 0 }),
      cookieHeader(stateCookieName, "", { secure, maxAge: 0 }),
    ]);
    safeRedirect(response, "/dashboard/auth/login");
  }

  return { begin, callback, requireSession, logout };
}
