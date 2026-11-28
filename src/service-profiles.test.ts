import { beforeAll, expect, it } from "vitest";

let assertServiceProfileDeployable: typeof import("./service-profiles.js").assertServiceProfileDeployable;
let assertServiceProfileRepositoryAllowed: typeof import("./service-profiles.js").assertServiceProfileRepositoryAllowed;
let getServiceProfile: typeof import("./service-profiles.js").getServiceProfile;
let listServiceProfiles: typeof import("./service-profiles.js").listServiceProfiles;
let serviceProfileReservationResources: typeof import("./service-profiles.js").serviceProfileReservationResources;

beforeAll(async () => {
  process.env.MCP_AUTH_TOKEN ??= "test-only-token-that-is-long-enough-for-vps-mcp";
  ({ assertServiceProfileDeployable, assertServiceProfileRepositoryAllowed, getServiceProfile, listServiceProfiles, serviceProfileReservationResources } = await import("./service-profiles.js"));
});

it("lists the Laravel profile as definition-only with a bounded resource plan", () => {
  const result = listServiceProfiles();
  expect(result.count).toBe(5);
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

it("exposes only the repository-restricted PHP-FPM acceptance profile as deployable", () => {
  const result = listServiceProfiles({ includeDefinitionOnly: false });
  expect(result.count).toBe(1);
  expect(result.profiles[0]).toMatchObject({
    id: "project-service-acceptance",
    version: 1,
    readiness: "deployable",
    acceptanceRepositoryId: "deputy-proxy-toti-invatam-org-44fadec4d6",
    runtime: { imageDigest: "ghcr.io/deputy-proxy/vps-mcp-laravel-php@sha256:10a7f5152d0bea6be3bde3ea3c6697154f20245128372833629a6d547e298b72", user: "non-root" },
    dependencies: [],
    resources: { cpuMilli: 500, memoryMiB: 1024, pids: 128, diskMiB: 10240 },
    deployment: { migrations: "disabled", migrationCommand: [], buildCommands: [], seeders: { enabled: false, allowlist: [] } },
  });
  expect(() => assertServiceProfileDeployable(result.profiles[0]!)).not.toThrow();
  expect(() => assertServiceProfileRepositoryAllowed(result.profiles[0]!, "deputy-proxy-vps-mcp-01d9433d21")).toThrow("restricted to its disposable acceptance repository");
  expect(() => assertServiceProfileRepositoryAllowed(result.profiles[0]!, "deputy-proxy-toti-invatam-org-44fadec4d6")).not.toThrow();
});

it("returns isolated profile copies so callers cannot mutate the catalog", () => {
  const profile = getServiceProfile("laravel-php");
  profile.runtime.toolchain.php = "8.3";
  expect(getServiceProfile("laravel-php").runtime.toolchain.php).toBe("8.4");
});

it("pins the approved MySQL 8.4 and Redis 8 images in a new immutable definition-only profile", () => {
  const profile = getServiceProfile("laravel-php", 4);
  expect(profile).toMatchObject({ version: 4, readiness: "definition-only", runtime: { imageDigest: null } });
  expect(profile.restartPolicy).toBe("no");
  expect(serviceProfileReservationResources(profile, ["mysql"])).toEqual({ cpuMilli: 1000, memoryMiB: 1792, pids: 256, diskMiB: 20480 });
  expect(serviceProfileReservationResources(profile, ["mysql", "redis"])).toEqual({ cpuMilli: 1200, memoryMiB: 2048, pids: 320, diskMiB: 21504 });
  expect(profile.dependencies).toEqual([
    { name: "mysql", version: "8.4.13", required: true, imageDigest: "dhi.io/mysql@sha256:37115bb21c603311e755d91efaea55beb2eaa3971452687c7098620d9e199fe0", resources: { cpuMilli: 500, memoryMiB: 768, pids: 128, diskMiB: 10240 }, credentialMode: "mounted-secret-file", isolation: "project-private-network-and-instance", restartPolicy: "no" },
    { name: "redis", version: "8.10.3", required: false, imageDigest: "dhi.io/redis@sha256:98143a1ca80a66cd13fe819322c92c23d900c275fe63f7c15d74287a8e7b2a61", resources: { cpuMilli: 200, memoryMiB: 256, pids: 64, diskMiB: 1024 }, credentialMode: "mounted-secret-file", isolation: "project-private-network-and-instance", restartPolicy: "no" },
  ]);
  expect(serviceProfileReservationResources(profile)).toEqual({ cpuMilli: 1200, memoryMiB: 2048, pids: 320, diskMiB: 21504 });
  expect(() => assertServiceProfileDeployable(profile)).toThrow("definition-only and cannot be provisioned");
});

it("rejects unknown profile IDs and versions", () => {
  expect(() => getServiceProfile("unknown-profile")).toThrow("Unknown project environment profile");
  expect(() => getServiceProfile("laravel-php", 5)).toThrow("Unknown project environment profile");
});

it("fails closed until an immutable image digest is configured and the profile is deployable", () => {
  expect(() => assertServiceProfileDeployable(getServiceProfile("laravel-php"))).toThrow("definition-only and cannot be provisioned");
});

it("requires a full immutable registry image reference before a profile can be marked deployable", () => {
  const profile = getServiceProfile("laravel-php");
  profile.readiness = "deployable";
  profile.runtime.imageDigest = "ghcr.io/deputy-proxy/vps-mcp-laravel-php@sha256:" + "a".repeat(64);
  expect(() => assertServiceProfileDeployable(profile)).toThrow("dependency 'mysql' must pin an immutable image digest");
  profile.dependencies[0]!.imageDigest = "docker.io/library/mysql@sha256:" + "b".repeat(64);
  expect(() => assertServiceProfileDeployable(profile)).toThrow("dependency 'redis' must pin an immutable image digest");
  profile.dependencies[1]!.imageDigest = "docker.io/library/redis@sha256:" + "c".repeat(64);
  expect(() => assertServiceProfileDeployable(profile)).not.toThrow();
  profile.runtime.imageDigest = "sha256:" + "a".repeat(64);
  expect(() => assertServiceProfileDeployable(profile)).toThrow("definition-only and cannot be provisioned");
});


it("keeps dependency images unpinned and the profile definition-only until reviewed immutable digests exist", () => {
  const profile = getServiceProfile("laravel-php", 3);
  expect(profile.dependencies).toEqual([
    { name: "mysql", version: "8", required: true, imageDigest: null, resources: { cpuMilli: 500, memoryMiB: 768, pids: 128, diskMiB: 10240 }, credentialMode: "mounted-secret-file", isolation: "project-private-network-and-instance" },
    { name: "redis", version: "7", required: false, imageDigest: null, resources: { cpuMilli: 200, memoryMiB: 256, pids: 64, diskMiB: 1024 }, credentialMode: "mounted-secret-file", isolation: "project-private-network-and-instance" },
  ]);
  const candidate = structuredClone(profile);
  candidate.readiness = "deployable";
  expect(() => assertServiceProfileDeployable(candidate)).toThrow("dependency 'mysql' must pin an immutable image digest");
});

it("computes an aggregate reservation that includes every declared dependency", () => {
  const profile = getServiceProfile("laravel-php", 3);
  expect(serviceProfileReservationResources(profile)).toEqual({
    cpuMilli: 1200, memoryMiB: 2048, pids: 320, diskMiB: 21504,
  });
  expect(profile.resources).toEqual({ cpuMilli: 500, memoryMiB: 1024, pids: 128, diskMiB: 10240 });
});
