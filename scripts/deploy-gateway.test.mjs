import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const gateway = path.join(directory, "deploy-gateway.sh");

function invoke(originalCommand) {
  return spawnSync("/bin/sh", [gateway], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", SSH_ORIGINAL_COMMAND: originalCommand },
  });
}

describe("forced SSH deployment gateway", () => {
  it("rejects arbitrary commands", () => {
    const result = invoke("id");
    expect(result.status).toBe(64);
    expect(result.stderr).toMatch(/Rejected SSH command/);
  });

  it("rejects command injection and malformed commit identifiers", () => {
    for (const command of [
      `deploy ${"a".repeat(40)}; id`,
      `deploy ${"a".repeat(39)}`,
      `deploy ${"A".repeat(40)}`,
      `deploy ${"a".repeat(40)} extra`,
    ]) {
      const result = invoke(command);
      expect(result.status).toBe(64);
      expect(result.stderr).toMatch(/Rejected deployment commit identifier/);
    }
  });
});
