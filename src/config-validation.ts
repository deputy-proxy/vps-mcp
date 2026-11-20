export function parseHttpsUrl(name: string, value: string | undefined, required = false): URL | undefined {
  if (!value) {
    if (required) throw new Error(`${name} is required`);
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid absolute URL`);
  }

  if (parsed.protocol !== "https:") throw new Error(`${name} must use HTTPS`);
  if (parsed.username || parsed.password) throw new Error(`${name} must not contain credentials`);
  return parsed;
}

export function parsePublicMcpUrl(value: string | undefined, required = false): URL | undefined {
  const parsed = parseHttpsUrl("MCP_PUBLIC_URL", value, required);
  if (!parsed) return undefined;
  if (parsed.pathname !== "/mcp" || parsed.search || parsed.hash) {
    throw new Error("MCP_PUBLIC_URL must be the canonical HTTPS MCP endpoint ending in /mcp, without query or fragment");
  }
  return parsed;
}

export function parseOAuthAudience(value: string | undefined, required = false): string {
  if (!value) {
    if (required) throw new Error("OAUTH_AUDIENCE is required");
    return "";
  }
  parseHttpsUrl("OAUTH_AUDIENCE", value, true);
  return value;
}

export function parseCorsOrigins(value: string | undefined): string[] {
  const entries = (value ?? "").split(",").map((origin) => origin.trim()).filter(Boolean);
  const origins = entries.map((origin) => {
    if (origin === "*" || origin.includes("*")) {
      throw new Error("MCP_CORS_ORIGINS must contain explicit origins; wildcards are not allowed");
    }
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error("MCP_CORS_ORIGINS entries must be valid absolute origins");
    }
    const isLocalHttp = parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
    if (parsed.protocol !== "https:" && !isLocalHttp) {
      throw new Error("MCP_CORS_ORIGINS entries must use HTTPS (localhost is allowed for development)");
    }
    if (parsed.origin !== origin || parsed.username || parsed.password) {
      throw new Error("MCP_CORS_ORIGINS entries must be exact origins without paths, query strings, fragments or credentials");
    }
    return parsed.origin;
  });
  return [...new Set(origins)];
}
