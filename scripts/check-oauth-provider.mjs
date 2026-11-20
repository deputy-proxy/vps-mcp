#!/usr/bin/env node
const input = process.argv[2];
const scope = process.argv[3] ?? "mcp";
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
  if (!issuer.pathname.endsWith("/")) issuer.pathname += "/";
  const metadata = await json(new URL(".well-known/openid-configuration", issuer), "OIDC discovery");
  const failures = [];
  const warnings = [];
  const check = (ok, message) => { if (!ok) failures.push(message); };
  check(metadata.issuer === issuer.toString(), "Discovery issuer does not exactly match configured issuer");
  for (const key of ["authorization_endpoint", "token_endpoint", "jwks_uri"]) {
    try { check(typeof metadata[key] === "string", key + " is missing"); if (metadata[key]) https(metadata[key], key); }
    catch (error) { failures.push(error.message); }
  }
  check(metadata.response_types_supported?.includes("code"), "Authorization Code response type is not advertised");
  check(metadata.code_challenge_methods_supported?.includes("S256"), "PKCE S256 is not advertised");
  const methods = metadata.token_endpoint_auth_methods_supported ?? [];
  const cimd = metadata.client_id_metadata_document_supported === true;
  const dcr = typeof metadata.registration_endpoint === "string";
  check(cimd || dcr, "Neither CIMD nor DCR is advertised");
  if (cimd) check(methods.some((x) => ["none", "private_key_jwt"].includes(x)), "CIMD has no ChatGPT-compatible token auth method (none/private_key_jwt)");
  else if (dcr) {
    check(methods.some((x) => ["none", "client_secret_post", "client_secret_basic", "private_key_jwt"].includes(x)), "No supported token endpoint auth method is advertised");
    warnings.push("DCR fallback only; verify ChatGPT registration behavior in the actual connector flow.");
  }
  if (metadata.authorization_response_iss_parameter_supported !== true) warnings.push("RFC 9207 issuer identification is not advertised; callback-specific CIMD/redirect settings may be required.");
  if (dcr) { try { https(metadata.registration_endpoint, "registration_endpoint"); } catch (error) { failures.push(error.message); } }
  if (metadata.jwks_uri) {
    try { const jwks = await json(metadata.jwks_uri, "JWKS"); check(Array.isArray(jwks.keys) && jwks.keys.length > 0, "JWKS contains no keys"); }
    catch (error) { failures.push("JWKS check failed: " + error.message); }
  }
  console.log("Issuer:", issuer.toString());
  console.log("CIMD:", cimd, "| DCR:", dcr, "| token auth methods:", methods.join(", ") || "not advertised");
  console.log("Required resource scope to verify after token issuance:", scope);
  warnings.forEach((x) => console.warn("WARNING:", x));
  failures.forEach((x) => console.error("FAIL:", x));
  if (failures.length) process.exitCode = 1;
  else console.log("Discovery preflight passed. Resource indicator/audience and token scopes still require an interactive authorization test.");
} catch (error) {
  console.error("OAuth provider check failed:", error.message);
  process.exitCode = 1;
}
