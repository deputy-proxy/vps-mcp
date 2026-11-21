# AuthKit scopes and VPS authorization

## AuthKit scopes currently advertised

The configured AuthKit authorization-server metadata advertises the standard OpenID Connect scopes:

- `openid`
- `profile`
- `email`
- `offline_access`

For MCP clients registered through Client ID Metadata Document (CIMD) or Dynamic Client Registration (DCR), WorkOS documents these standard scopes as the default. They provide identity information and, when `offline_access` is requested, refresh-token access. They are not permissions to run VPS commands or read/write files.

WorkOS does not allow scopes to be assigned individually to CIMD/DCR-registered clients. Additional permission scopes require an environment-wide default configured with WorkOS support. Therefore this deployment must not invent a required scope such as `mcp` or `vps:admin`.

## Resource authorization

The resource indicator is:

```text
https://194.163.133.147/mcp
```

AuthKit puts the requested resource indicator in the access token's `aud` claim. The server validates the token signature, exact issuer, audience and expiry. With `OAUTH_REQUIRED_SCOPES=`, it does not require an additional scope claim. This is the intended configuration for the current AuthKit CIMD/DCR setup.

Keep the AuthKit resource indicator, `MCP_PUBLIC_URL`, and `OAUTH_AUDIENCE` identical. The resource indicator must be configured in WorkOS; otherwise AuthKit may issue its environment client ID as `aud`, and this server will correctly reject the token.

## Important authorization boundary

The current server applies one authentication boundary to every MCP request. It does not map users, organizations, roles or scopes to individual tools. Any user who completes AuthKit authorization and receives a token for this resource can access the complete tool set, including shell execution and filesystem writes, within the operating-system and configured-root restrictions of the service account.

The standard OIDC scopes do not change that permission level. Do not treat `openid`, `profile`, `email` or `offline_access` as administrative authorization scopes.

If access must differ by user or organization, implement a separate authorization layer based on verified token identity and an authoritative role/permission source. Do not merely add an arbitrary string to `OAUTH_REQUIRED_SCOPES`.
