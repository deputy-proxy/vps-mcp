import { timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { config } from "./config.js";

const jwks = config.authMode === "oauth"
  ? createRemoteJWKSet(config.oauthJwksUrl ?? new URL(".well-known/jwks.json", config.oauthIssuerUrl!))
  : undefined;

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

  if (!supplied || !jwks) {
    unauthorized(response, "invalid_token");
    return;
  }

  try {
    const { payload } = await jwtVerify(supplied, jwks, {
      issuer: config.oauthIssuerUrl!.toString().replace(/\/$/, ""),
      audience: config.oauthAudience,
      algorithms: ["RS256", "RS384", "RS512", "ES256", "ES384", "ES512"],
    });

    const grantedScopes = typeof payload.scope === "string"
      ? payload.scope.split(/\s+/)
      : Array.isArray(payload.scp)
        ? payload.scp.filter((scope): scope is string => typeof scope === "string")
        : [];

    if (!config.oauthScopes.every((scope) => grantedScopes.includes(scope))) {
      response.setHeader("WWW-Authenticate", `Bearer error="insufficient_scope", scope="${config.oauthScopes.join(" ")}"`);
      response.status(403).json({ error: "Insufficient scope" });
      return;
    }

    next();
  } catch {
    unauthorized(response, "invalid_token");
  }
}
