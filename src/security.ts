import { timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { JWTVerifyGetKey } from "jose";
import { config } from "./config.js";

export type OAuthOptions = {
  issuer: string;
  audience: string;
  scopes: string[];
  publicUrl?: URL;
};

type DiscoveryDocument = { issuer?: unknown; jwks_uri?: unknown };
type JwksResolver = () => Promise<JWTVerifyGetKey>;

export function hasRequiredScopes(payload: object, requiredScopes: string[]): boolean {
  const claims = payload as Record<string, unknown>;
  const grantedScopes = typeof claims.scope === "string"
    ? claims.scope.split(/\s+/).filter(Boolean)
    : Array.isArray(claims.scp)
      ? claims.scp.filter((scope): scope is string => typeof scope === "string")
      : [];
  return requiredScopes.every((scope) => grantedScopes.includes(scope));
}

export async function resolveJwksUrl(issuer: string | URL, explicitJwksUrl?: URL, fetcher: typeof fetch = fetch): Promise<URL> {
  if (explicitJwksUrl) return explicitJwksUrl;
  const issuerIdentifier = issuer.toString();
  const issuerUrl = new URL(issuerIdentifier);
  if (!issuerUrl.pathname.endsWith("/")) issuerUrl.pathname += "/";
  const discoveryUrl = new URL(".well-known/openid-configuration", issuerUrl);
  const response = await fetcher(discoveryUrl, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`OIDC discovery returned HTTP ${response.status}`);
  const document = await response.json() as DiscoveryDocument;
  if (document.issuer !== issuerIdentifier) throw new Error("OIDC discovery issuer does not exactly match OAUTH_ISSUER_URL");
  if (typeof document.jwks_uri !== "string") throw new Error("OIDC discovery document is missing jwks_uri");
  const jwksUrl = new URL(document.jwks_uri);
  if (jwksUrl.protocol !== "https:") throw new Error("OIDC jwks_uri must use HTTPS");
  return jwksUrl;
}

function unauthorized(response: Response, reason: string | undefined, publicUrl?: URL, scopes: string[] = []): void {
  const metadataUrl = publicUrl
    ? new URL("/.well-known/oauth-protected-resource/mcp", publicUrl).toString()
    : undefined;
  const errorChallenge = reason ? `error="${reason}", ` : "";
  const scopeChallenge = scopes.length ? `, scope="${scopes.join(" ")}"` : "";
  response.setHeader("WWW-Authenticate", metadataUrl
    ? `Bearer ${errorChallenge}resource_metadata="${metadataUrl}"${scopeChallenge}`
    : `Bearer ${reason ? `error="${reason}"` : ""}${scopeChallenge}`);
  response.status(401).json({ error: "Unauthorized" });
}

export function createOAuthAuthenticator(options: OAuthOptions, resolveKeys: JwksResolver) {
  return async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    const authorization = request.header("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(authorization);
    const supplied = match?.[1] ?? "";
    if (!supplied) {
      console.warn("OAuth authentication rejected", { reason: "missing_bearer_token", method: request.method, path: request.path });
      // A missing credential is a discovery challenge, not a failed token.
      // Use the minimal challenge format documented for ChatGPT MCP clients.
      unauthorized(response, undefined, options.publicUrl, options.scopes);
      return;
    }

    let keySet: JWTVerifyGetKey;
    try {
      keySet = await resolveKeys();
    } catch (error) {
      console.error("OAuth discovery unavailable", error);
      response.status(503).json({ error: "OAuth authorization service unavailable" });
      return;
    }

    try {
      const { payload } = await jwtVerify(supplied, keySet, {
        issuer: options.issuer,
        audience: options.audience,
        algorithms: ["RS256", "RS384", "RS512", "ES256", "ES384", "ES512"],
      });
      if (!hasRequiredScopes(payload, options.scopes)) {
        response.setHeader("WWW-Authenticate", `Bearer error="insufficient_scope", scope="${options.scopes.join(" ")}"`);
        response.status(403).json({ error: "Insufficient scope" });
        return;
      }
      next();
    } catch (error) {
      const reason = error instanceof Error ? error.name : "unknown_verification_error";
      console.warn("OAuth authentication rejected", { reason, method: request.method, path: request.path });
      unauthorized(response, "invalid_token", options.publicUrl, options.scopes);
    }
  };
}

const oauthOptions: OAuthOptions | undefined = config.authMode === "oauth"
  ? {
      issuer: config.oauthIssuer!,
      audience: config.oauthAudience,
      scopes: config.oauthScopes,
      publicUrl: config.publicUrl!,
    }
  : undefined;

let jwksPromise: ReturnType<typeof createRemoteJWKSet> | undefined;
let jwksInitialization: Promise<ReturnType<typeof createRemoteJWKSet>> | undefined;

async function getJwks(): Promise<ReturnType<typeof createRemoteJWKSet>> {
  if (!oauthOptions) throw new Error("OAuth is not configured");
  if (jwksPromise) return jwksPromise;
  jwksInitialization ??= resolveJwksUrl(oauthOptions.issuer, config.oauthJwksUrl)
    .then((url) => {
      jwksPromise = createRemoteJWKSet(url);
      return jwksPromise;
    })
    .catch((error: unknown) => {
      jwksInitialization = undefined;
      throw error;
    });
  return jwksInitialization;
}

/**
 * Validates an optional bearer token for per-tool OAuth authorization.
 * MCP initialization and tools/list stay public; every protected tool calls
 * this function before performing its operation.
 */
export async function verifyOAuthAccessToken(authorizationHeader?: string): Promise<boolean> {
  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader ?? "");
  const supplied = match?.[1] ?? "";
  if (!supplied || !oauthOptions) {
    if (!supplied) console.warn("OAuth tool authorization required", { reason: "missing_bearer_token" });
    return false;
  }

  try {
    const keySet = await getJwks();
    const { payload } = await jwtVerify(supplied, keySet, {
      issuer: oauthOptions.issuer,
      audience: oauthOptions.audience,
      algorithms: ["RS256", "RS384", "RS512", "ES256", "ES384", "ES512"],
    });
    if (!hasRequiredScopes(payload, oauthOptions.scopes)) {
      console.warn("OAuth tool authorization rejected", { reason: "insufficient_scope" });
      return false;
    }
    return true;
  } catch (error) {
    const reason = error instanceof Error ? error.name : "unknown_verification_error";
    console.warn("OAuth tool authorization rejected", { reason });
    return false;
  }
}

export async function authenticate(request: Request, response: Response, next: NextFunction): Promise<void> {
  if (config.authMode === "none") { next(); return; }

  const authorization = request.header("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  const supplied = match?.[1] ?? "";

  if (config.authMode === "token") {
    const expectedBuffer = Buffer.from(config.authToken);
    const suppliedBuffer = Buffer.from(supplied);
    const valid = suppliedBuffer.length === expectedBuffer.length && timingSafeEqual(suppliedBuffer, expectedBuffer);
    if (!valid) {
      response.setHeader("WWW-Authenticate", 'Bearer error="invalid_token"');
      response.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
    return;
  }

  if (!oauthOptions) {
    response.status(503).json({ error: "OAuth authorization service unavailable" });
    return;
  }
  await createOAuthAuthenticator(oauthOptions, getJwks)(request, response, next);
}
