import { timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { config } from "./config.js";

type OAuthOptions = {
  issuer: URL;
  audience: string;
  scopes: string[];
  jwksUrl?: URL;
};

type DiscoveryDocument = {
  issuer?: unknown;
  jwks_uri?: unknown;
};

export function hasRequiredScopes(
  payload: { scope?: unknown; scp?: unknown },
  requiredScopes: string[],
): boolean {
  const grantedScopes = typeof payload.scope === "string"
    ? payload.scope.split(/\s+/).filter(Boolean)
    : Array.isArray(payload.scp)
      ? payload.scp.filter((scope): scope is string => typeof scope === "string")
      : [];
  return requiredScopes.every((scope) => grantedScopes.includes(scope));
}

export async function resolveJwksUrl(
  issuer: URL,
  explicitJwksUrl?: URL,
  fetcher: typeof fetch = fetch,
): Promise<URL> {
  if (explicitJwksUrl) return explicitJwksUrl;

  const issuerUrl = new URL(issuer.toString());
  if (!issuerUrl.pathname.endsWith("/")) issuerUrl.pathname += "/";
  const discoveryUrl = new URL(".well-known/openid-configuration", issuerUrl);
  const response = await fetcher(discoveryUrl, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`OIDC discovery returned HTTP ${response.status}`);

  const document = await response.json() as DiscoveryDocument;
  if (document.issuer !== issuer.toString()) {
    throw new Error("OIDC discovery issuer does not exactly match OAUTH_ISSUER_URL");
  }
  if (typeof document.jwks_uri !== "string") {
    throw new Error("OIDC discovery document is missing jwks_uri");
  }

  const jwksUrl = new URL(document.jwks_uri);
  if (jwksUrl.protocol !== "https:") throw new Error("OIDC jwks_uri must use HTTPS");
  return jwksUrl;
}

const oauthOptions: OAuthOptions | undefined = config.authMode === "oauth"
  ? {
      issuer: config.oauthIssuerUrl!,
      audience: config.oauthAudience,
      scopes: config.oauthScopes,
      ...(config.oauthJwksUrl ? { jwksUrl: config.oauthJwksUrl } : {}),
    }
  : undefined;

let jwksPromise: ReturnType<typeof createRemoteJWKSet> | undefined;
let jwksInitialization: Promise<ReturnType<typeof createRemoteJWKSet>> | undefined;

async function getJwks(): Promise<ReturnType<typeof createRemoteJWKSet>> {
  if (!oauthOptions) throw new Error("OAuth is not configured");
  if (jwksPromise) return jwksPromise;
  jwksInitialization ??= resolveJwksUrl(oauthOptions.issuer, oauthOptions.jwksUrl)
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

function unauthorized(response: Response, reason = "invalid_token"): void {
  const metadataUrl = config.publicUrl
    ? new URL("/.well-known/oauth-protected-resource/mcp", config.publicUrl).toString()
    : undefined;
  response.setHeader(
    "WWW-Authenticate",
    metadataUrl
      ? `Bearer error="${reason}", resource_metadata="${metadataUrl}"`
      : `Bearer error="${reason}"`,
  );
  response.status(401).json({ error: "Unauthorized" });
}

export async function authenticate(request: Request, response: Response, next: NextFunction): Promise<void> {
  if (config.authMode === "none") {
    next();
    return;
  }

  const authorization = request.header("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  const supplied = match?.[1] ?? "";

  if (config.authMode === "token") {
    const expectedBuffer = Buffer.from(config.authToken);
    const suppliedBuffer = Buffer.from(supplied);
    const valid = suppliedBuffer.length === expectedBuffer.length
      && timingSafeEqual(suppliedBuffer, expectedBuffer);
    if (!valid) {
      unauthorized(response);
      return;
    }
    next();
    return;
  }

  if (!supplied || !oauthOptions) {
    unauthorized(response);
    return;
  }

  let keySet: ReturnType<typeof createRemoteJWKSet>;
  try {
    keySet = await getJwks();
  } catch (error) {
    console.error("OAuth discovery unavailable", error);
    response.status(503).json({ error: "OAuth authorization service unavailable" });
    return;
  }

  try {
    const { payload } = await jwtVerify(supplied, keySet, {
      issuer: oauthOptions.issuer.toString(),
      audience: oauthOptions.audience,
      algorithms: ["RS256", "RS384", "RS512", "ES256", "ES384", "ES512"],
    });

    if (!hasRequiredScopes(payload, oauthOptions.scopes)) {
      response.setHeader("WWW-Authenticate", `Bearer error="insufficient_scope", scope="${oauthOptions.scopes.join(" ")}"`);
      response.status(403).json({ error: "Insufficient scope" });
      return;
    }
    next();
  } catch {
    unauthorized(response);
  }
}
