import { beforeAll, expect, it } from "vitest";

let assertServiceProfileDeployable: typeof import("./service-profiles.js").assertServiceProfileDeployable;
let getServiceProfile: typeof import("./service-profiles.js").getServiceProfile;
let listServiceProfiles: typeof import("./service-profiles.js").listServiceProfiles;

beforeAll(async () => {
  process.env.MCP_AUTH_TOKEN ??= "test-only-token-that-is-long-enough-for-vps-mcp";
  ({ assertServiceProfileDeployable, getServiceProfile, listServiceProfiles } = await import("./service-profiles.js"));
});

it("lists the Laravel profile as definition-only with a bounded resource plan", () => {
  const result = listServiceProfiles();
  expect(result.count).toBe(3);
  expect(result.profiles[0]).toMatchObject({
    id: "laravel-php",
    version: 1,
    readiness: "definition-only",
    runtime: { imageDigest: null, toolchain: { php: "8.4", composer: "2", node: "22" }, user: "non-root" },
    resources: { cpuMilli: 500, memoryMiB: 1024, pids: 128, diskMiB: 10240 },
    deployment: { migrations: "disabled", seeders: { enabled: false, allowlist: [] } },
  });
  expect(result.profiles[0]!.processes.workers).toEqual([]);
  expect(result.profiles[0]!.processes.scheduler).toEqual({ enabled: false, command: null });
});

it("preserves the original immutable candidate and adds the refreshed digest as version 3", () => {
  const original = getServiceProfile("laravel-php", 2);
  expect(original.runtime.imageDigest).toBe("ghcr.io/deputy-proxy/vps-mcp-laravel-php@sha256:07022280f3b8e1a1be9abed133870af82a85912d78e4300144b1a3e38933a9da");
  const profile = getServiceProfile("laravel-php", 3);
  expect(profile).toMatchObject({
    version: 3,
    readiness: "definition-only",
    runtime: {
      imageDigest: "ghcr.io/deputy-proxy/vps-mcp-laravel-php@sha256:10a7f5152d0bea6be3bde3ea3c6697154f20245128372833629a6d547e298b72",
      toolchain: { php: "8.4.28", composer: "2.9.2", node: "22.23.0" },
    },
    processes: { workers: [], scheduler: { enabled: false, command: null } },
  });
  expect(() => assertServiceProfileDeployable(profile)).toThrow("definition-only and cannot be provisioned");
});

it("documents and validates the intentional storage-then-logs nested mount", () => {
  const profile = getServiceProfile("laravel-php", 3);
  expect(profile.mounts.map(({ name, target }) => [name, target])).toEqual([
    ["storage", "/app/storage"],
    ["cache", "/app/bootstrap/cache"],
    ["logs", "/app/storage/logs"],
  ]);
  const invalid = structuredClone(profile);
  invalid.mounts[2]!.target = "/app/bootstrap/cache/logs";
  expect(() => assertServiceProfileDeployable(invalid)).toThrow("unsupported nested mount");
});

it("omits definition-only profiles when callers request deployable profiles only", () => {
  expect(listServiceProfiles({ includeDefinitionOnly: false })).toEqual({ count: 0, profiles: [] });
});

it("returns isolated profile copies so callers cannot mutate the catalog", () => {
  const profile = getServiceProfile("laravel-php");
  profile.runtime.toolchain.php = "8.3";
  expect(getServiceProfile("laravel-php").runtime.toolchain.php).toBe("8.4");
});

it("rejects unknown profile IDs and versions", () => {
  expect(() => getServiceProfile("unknown-profile")).toThrow("Unknown project environment profile");
  expect(() => getServiceProfile("laravel-php", 4)).toThrow("Unknown project environment profile");
});

it("fails closed until an immutable image digest is configured and the profile is deployable", () => {
  expect(() => assertServiceProfileDeployable(getServiceProfile("laravel-php"))).toThrow("definition-only and cannot be provisioned");
});

it("requires a full immutable registry image reference before a profile can be marked deployable", () => {
  const profile = getServiceProfile("laravel-php");
  profile.readiness = "deployable";
  profile.runtime.imageDigest = "ghcr.io/deputy-proxy/vps-mcp-laravel-php@sha256:" + "a".repeat(64);
  expect(() => assertServiceProfileDeployable(profile)).not.toThrow();
  profile.runtime.imageDigest = "sha256:" + "a".repeat(64);
  expect(() => assertServiceProfileDeployable(profile)).toThrow("definition-only and cannot be provisioned");
});
