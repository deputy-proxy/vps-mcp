import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const script = readFileSync(new URL("./provision-production-deploy-access.sh", import.meta.url), "utf8");

describe("production deployment access provisioning", () => {
  it("keeps the SSH directory and authorized keys readable by the deploy account", () => {
    expect(script).toContain("install -d -o vps-mcp-deploy -g vps-mcp-deploy -m 0700 /var/lib/vps-mcp-deploy/.ssh");
    expect(script).toContain("chown vps-mcp-deploy:vps-mcp-deploy /var/lib/vps-mcp-deploy/.ssh");
    expect(script).toContain('chown vps-mcp-deploy:vps-mcp-deploy "$authorized_keys"');
    expect(script).toContain('chmod 0600 "$authorized_keys"');
    expect(script).not.toContain('chown root:root "$authorized_keys"');
  });

  it("preserves only entries constrained to the deployment forced command", () => {
    expect(script).toContain("authorized_key_pattern='^restrict,command=\"/usr/local/libexec/vps-mcp/deploy-gateway\\.sh\" ssh-ed25519");
    expect(script).toContain('[[ "$existing_line" =~ $authorized_key_pattern ]]');
  });

  it("allows the fixed Node deployment command with its script argument", () => {
    expect(script).toContain("vps-mcp-deploy ALL=(root) NOPASSWD: /usr/bin/node /usr/local/libexec/vps-mcp/deploy-production.mjs");
    expect(script).not.toContain('deploy-production.mjs ""');
  });
});
