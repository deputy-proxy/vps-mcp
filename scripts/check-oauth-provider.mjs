#!/usr/bin/env node
const input = process.argv[2];
const requiredScope = process.argv[3] ?? "";
if (!input) {
  console.error("Usage: npm run check:oauth -- <issuer-url> [required-scope]");
  process.exit(2);
}
const https = (value, label) => {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error(label + " must use HTTPS");
  return url;
};
const json = async (url, label) => {
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000), redirect: "error" });
  if (!response.ok) throw new Error(label + " returned HTTP " + response.status);
  if (!(response.headers.get("content-type") ?? "").includes("json")) throw new Error(label + " did not return JSON");
  return response.json();
};
try {
  const issuer = https(input, "Issuer");
  if (issuer.search || issuer.hash || issuer.username || issuer.password) throw new Error("Issuer URL cannot contain credentials, query or fragment");

  // OIDC discovery and OAuth authorization-server metadata are distinct documents.
  const origin = issuer.origin;
  const oidc = await json(new URL("/.well-known/openid-configuration", origin), "OIDC discovery");
  const oauth = await json(new URL("/.well-known/oauth-authorization-server", origin), "OAuth authorization-server metadata");
  const failures = [];
  const warnings = [];
  const check = (ok, message) => { if (!ok) failures.push(message); };
  const configuredIssuer = input.replace(/\/$/, "");
  check(typeof oidc.issuer === "string" && oidc.issuer.replace(/\/$/, "") === configuredIssuer, "OIDC discovery issuer does not match configured issuer");
  check(typeof oauth.issuer === "string" && oauth.issuer.replace(/\/$/, "") === configuredIssuer, "OAuth authorization-server issuer does not match configured issuer");

  for (const [metadata, label] of [[oidc, "OIDC"], [oauth, "OAuth"]]) {
    for (const key of ["authorization_endpoint", "token_endpoint", "jwks_uri"]) {
      try {
        check(typeof metadata[key] === "string", label + " " + key + " is missing");
        if (metadata[key]) https(metadata[key], label + " " + key);
      } catch (error) { failures.push(error.message); }
    }
    check(metadata.response_types_supported?.includes("code"), label + " Authorization Code response type is not advertised");
    check(metadata.code_challenge_methods_supported?.includes("S256"), label + " PKCE S256 is not advertised");
  }

  const methods = oauth.token_endpoint_auth_methods_supported ?? oidc.token_endpoint_auth_methods_supported ?? [];
  const cimd = oauth.client_id_metadata_document_supported === true;
  const dcr = typeof oauth.registration_endpoint === "string";
  check(cimd || dcr, "Neither CIMD nor DCR is advertised in OAuth authorization-server metadata");
  if (cimd) check(methods.some((x) => ["none", "private_key_jwt"].includes(x)), "CIMD has no ChatGPT-compatible token auth method (none/private_key_jwt)");
  else if (dcr) {
    check(methods.some((x) => ["none", "client_secret_post", "client_secret_basic", "private_key_jwt"].includes(x)), "No supported token endpoint auth method is advertised");
    warnings.push("DCR fallback only; verify ChatGPT registration behavior in the actual connector flow.");
  }
  if (oauth.authorization_response_iss_parameter_supported !== true) warnings.push("RFC 9207 issuer identification is not advertised.");
  if (dcr) {
    try { https(oauth.registration_endpoint, "registration_endpoint"); }
    catch (error) { failures.push(error.message); }
  }

  try {
    const jwks = await json(oidc.jwks_uri, "JWKS");
    check(Array.isArray(jwks.keys) && jwks.keys.length > 0, "JWKS contains no keys");
  } catch (error) { failures.push("JWKS check failed: " + error.message); }

  const advertisedScopes = Array.isArray(oauth.scopes_supported)
    ? oauth.scopes_supported.filter((scope) => typeof scope === "string")
    : [];
  console.log("Issuer:", oidc.issuer ?? input);
  console.log("CIMD:", cimd, "| DCR:", dcr, "| token auth methods:", methods.join(", ") || "not advertised");
  console.log("Authorization-server scopes:", advertisedScopes.join(", ") || "not advertised");
  console.log("Required resource scopes:", requiredScope || "none (AuthKit resource indicator is enforced through aud)");
  if (requiredScope && advertisedScopes.length && !advertisedScopes.includes(requiredScope)) {
    warnings.push("The requested required scope is not in scopes_supported. For CIMD/DCR clients, WorkOS requires environment-wide default scopes for additional permissions.");
  }
  warnings.forEach((x) => console.warn("WARNING:", x));
  failures.forEach((x) => console.error("FAIL:", x));
  if (failures.length) process.exitCode = 1;
  else console.log("Discovery preflight passed. Resource indicator/audience and issued token claims still require an interactive authorization test.");
} catch (error) {
  console.error("OAuth provider check failed:", error.message);
  process.exitCode = 1;
}
