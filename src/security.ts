import { timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
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

export function extractGrantedScopes(payload: object): string[] {
  const claims = payload as Record<string, unknown>;
  return typeof claims.scope === "string"
    ? claims.scope.split(/\s+/).filter(Boolean)
    : Array.isArray(claims.scp)
      ? claims.scp.filter((scope): scope is string => typeof scope === "string")
      : [];
}

export function hasRequiredScopes(payload: object, requiredScopes: string[]): boolean {
  const grantedScopes = extractGrantedScopes(payload);
  return requiredScopes.every((scope) => grantedScopes.includes(scope));
}

export async function resolveJwksUrl(issuer: string | URL, explicitJwksUrl?: URL, fetcher: typeof fetch = fetch): Promise<URL> {
  if (explicitJwksUrl) return explicitJwksUrl;
  const issuerIdentifier = issuer.toString();
  const issuerUrl = new URL(issuerIdentifier);
  if (!issuerUrl.pathname.endsWith("/")) issuerUrl.pathname += "/";
  const discoveryUrl = new URL(".well-known/openid-configuration", issuerUrl);
  const response = await fetcher(discoveryUrl, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error("OIDC discovery returned HTTP " + response.status);
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
  const errorChallenge = reason ? 'error="' + reason + '", ' : "";
  const scopeChallenge = scopes.length ? ', scope="' + scopes.join(" ") + '"' : "";
  response.setHeader("WWW-Authenticate", metadataUrl
    ? "Bearer " + errorChallenge + 'resource_metadata="' + metadataUrl + '"' + scopeChallenge
    : "Bearer " + (reason ? 'error="' + reason + '"' : "") + scopeChallenge);
  response.status(401).json({ error: "Unauthorized" });
}

export function createOAuthAuthenticator(options: OAuthOptions, resolveKeys: JwksResolver) {
  return async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    const authorization = request.header("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(authorization);
    const supplied = match?.[1] ?? "";
    if (!supplied) {
      console.warn("OAuth authentication rejected", { reason: "missing_bearer_token", method: request.method, path: request.path });
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
        response.setHeader("WWW-Authenticate", 'Bearer error="insufficient_scope", scope="' + options.scopes.join(" ") + '"');
        response.status(403).json({ error: "Insufficient scope" });
        return;
      }

      const authInfo: AuthInfo = {
        token: supplied,
        clientId: typeof payload.client_id === "string"
          ? payload.client_id
          : typeof payload.azp === "string" ? payload.azp : "unknown",
        scopes: extractGrantedScopes(payload),
        ...(typeof payload.exp === "number" ? { expiresAt: payload.exp } : {}),
      };
      (request as Request & { auth?: AuthInfo }).auth = authInfo;
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

  // One server-level boundary protects every MCP request, including initialize,
  // tools/list and tools/call. There is no separate per-tool OAuth path.
  await createOAuthAuthenticator(oauthOptions, getJwks)(request, response, next);
}
