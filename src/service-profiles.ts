import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";

export type ServiceProfileReadiness = "definition-only" | "deployable";
export type ServiceProfileResourceVector = { cpuMilli: number; memoryMiB: number; pids: number; diskMiB: number };
export type ServiceProfile = {
  id: string;
  version: number;
  displayName: string;
  family: string;
  readiness: ServiceProfileReadiness;
  runtime: { imageDigest: string | null; toolchain: Record<string, string>; user: "non-root" };
  processes: {
    web: { command: string[]; port: number; protocol: "tcp" };
    workers: Array<{ name: string; command: string[]; replicas: number }>;
    scheduler: { enabled: boolean; command: string[] | null };
  };
  healthChecks: Array<{ name: string; type: "tcp" | "http" | "process"; target: string; intervalSeconds: number; timeoutSeconds: number }>;
  mounts: Array<{ name: string; source: "project-storage" | "project-cache" | "project-logs"; target: string; readOnly: boolean }>;
  dependencies: Array<{ name: "mysql" | "redis"; version: string; required: boolean; isolation: "project-instance" | "project-credentials-and-namespace" }>;
  resources: ServiceProfileResourceVector;
  restartPolicy: "always" | "unless-stopped";
  deployment: {
    buildCommands: string[][];
    migrationCommand: string[];
    migrations: "disabled" | "development-database-only";
    seeders: { enabled: boolean; allowlist: string[] };
  };
  backup: { includes: string[]; restoreRequiresIdentityMatch: true };
};

const PROFILES: ServiceProfile[] = [
  {
    id: "laravel-php",
    version: 1,
    displayName: "Laravel / PHP 8.4",
    family: "php",
    readiness: "definition-only",
    runtime: { imageDigest: null, toolchain: { php: "8.4", composer: "2", node: "22" }, user: "non-root" },
    processes: {
      web: { command: ["php-fpm", "--nodaemonize"], port: 9000, protocol: "tcp" },
      workers: [],
      scheduler: { enabled: false, command: null },
    },
    healthChecks: [
      { name: "php-fpm", type: "tcp", target: "127.0.0.1:9000", intervalSeconds: 15, timeoutSeconds: 3 },
    ],
    mounts: [
      { name: "storage", source: "project-storage", target: "/app/storage", readOnly: false },
      { name: "cache", source: "project-cache", target: "/app/bootstrap/cache", readOnly: false },
      { name: "logs", source: "project-logs", target: "/app/storage/logs", readOnly: false },
    ],
    dependencies: [
      { name: "mysql", version: "8", required: true, isolation: "project-instance" },
      { name: "redis", version: "7", required: false, isolation: "project-credentials-and-namespace" },
    ],
    resources: { cpuMilli: 500, memoryMiB: 1024, pids: 128, diskMiB: 10240 },
    restartPolicy: "unless-stopped",
    deployment: {
      buildCommands: [
        ["composer", "install", "--no-interaction", "--prefer-dist", "--no-dev"],
        ["npm", "ci"],
        ["npm", "run", "build"],
      ],
      migrationCommand: ["php", "artisan", "migrate", "--force"],
      migrations: "disabled",
      seeders: { enabled: false, allowlist: [] },
    },
    backup: { includes: ["project-database", "project-storage"], restoreRequiresIdentityMatch: true },
  },
  {
    id: "laravel-php",
    version: 2,
    displayName: "Laravel / PHP 8.4 (candidate)",
    family: "php",
    readiness: "definition-only",
    runtime: {
      imageDigest: "ghcr.io/deputy-proxy/vps-mcp-laravel-php@sha256:07022280f3b8e1a1be9abed133870af82a85912d78e4300144b1a3e38933a9da",
      toolchain: { php: "8.4.28", composer: "2.9.2", node: "22.23.0" },
      user: "non-root",
    },
    processes: {
      web: { command: ["php-fpm", "--nodaemonize"], port: 9000, protocol: "tcp" },
      workers: [],
      scheduler: { enabled: false, command: null },
    },
    healthChecks: [
      { name: "php-fpm", type: "tcp", target: "127.0.0.1:9000", intervalSeconds: 15, timeoutSeconds: 3 },
    ],
    mounts: [
      { name: "storage", source: "project-storage", target: "/app/storage", readOnly: false },
      { name: "cache", source: "project-cache", target: "/app/bootstrap/cache", readOnly: false },
      { name: "logs", source: "project-logs", target: "/app/storage/logs", readOnly: false },
    ],
    dependencies: [
      { name: "mysql", version: "8", required: true, isolation: "project-instance" },
      { name: "redis", version: "7", required: false, isolation: "project-credentials-and-namespace" },
    ],
    resources: { cpuMilli: 500, memoryMiB: 1024, pids: 128, diskMiB: 10240 },
    restartPolicy: "unless-stopped",
    deployment: {
      buildCommands: [
        ["composer", "install", "--no-interaction", "--prefer-dist", "--no-dev"],
        ["npm", "ci"],
        ["npm", "run", "build"],
      ],
      migrationCommand: ["php", "artisan", "migrate", "--force"],
      migrations: "disabled",
      seeders: { enabled: false, allowlist: [] },
    },
    backup: { includes: ["project-database", "project-storage"], restoreRequiresIdentityMatch: true },
  },
 ];

// Profile versions are immutable contracts. The newer published image is a
// separate candidate version rather than an in-place rewrite of version 2.
const laravelPhpV3 = structuredClone(PROFILES[1]!);
laravelPhpV3.version = 3;
laravelPhpV3.displayName = "Laravel / PHP 8.4 (candidate, image refresh)";
laravelPhpV3.runtime.imageDigest = "ghcr.io/deputy-proxy/vps-mcp-laravel-php@sha256:10a7f5152d0bea6be3bde3ea3c6697154f20245128372833629a6d547e298b72";
PROFILES.push(laravelPhpV3);

const lifecycleRoot = path.join(config.dataDir, "service-profiles");
const lifecycleFile = path.join(lifecycleRoot, "lifecycle.json");

type ProfileLifecycle = { schemaVersion: 1; promotions: Array<{ profileId: string; version: number; imageDigest: string; approvedAt: string; approvalReference: string }> };
function readLifecycle(): ProfileLifecycle {
  try {
    const parsed = JSON.parse(fs.readFileSync(lifecycleFile, "utf8")) as ProfileLifecycle;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.promotions)) throw new Error("Corrupt service profile lifecycle registry");
    for (const item of parsed.promotions) {
      if (!item || typeof item.profileId !== "string" || !Number.isSafeInteger(item.version) || item.version < 1
        || typeof item.imageDigest !== "string" || !/^[a-z0-9][a-z0-9._/:+-]{0,180}@sha256:[a-f0-9]{64}$/.test(item.imageDigest)
        || typeof item.approvedAt !== "string" || typeof item.approvalReference !== "string") throw new Error("Corrupt service profile lifecycle entry");
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1, promotions: [] };
    throw error;
  }
}
function applyLifecycle(profile: ServiceProfile): ServiceProfile {
  const promotion = readLifecycle().promotions.find((item) => item.profileId === profile.id && item.version === profile.version);
  if (!promotion) return profile;
  if (profile.runtime.imageDigest !== promotion.imageDigest) throw new Error("Approved service profile digest no longer matches its immutable definition");
  profile.readiness = "deployable";
  return profile;
}

export function promoteServiceProfile(input: { profileId: string; version: number; imageDigest: string; approvalReference: string }) {
  if (!config.serviceProfilePromotionEnabled) throw new Error("Service profile promotion is disabled by server configuration");
  if (!/^[a-z][a-z0-9-]{1,63}$/.test(input.profileId)) throw new Error("Invalid service profile ID");
  if (!Number.isSafeInteger(input.version) || input.version < 1) throw new Error("Profile version must be a positive integer");
  if (input.approvalReference.trim().length < 8 || input.approvalReference.length > 500) throw new Error("An approval reference of 8 to 500 characters is required");
  const profile = getServiceProfile(input.profileId, input.version);
  if (!profile.runtime.imageDigest || profile.runtime.imageDigest !== input.imageDigest) throw new Error("Promotion digest must exactly match the profile's immutable image digest");
  profile.readiness = "deployable";
  assertServiceProfileDeployable(profile);
  const registry = readLifecycle();
  const existing = registry.promotions.find((item) => item.profileId === input.profileId && item.version === input.version);
  if (existing) {
    if (existing.imageDigest !== input.imageDigest) throw new Error("A profile version cannot be promoted to a different image digest");
    return { promoted: false, alreadyPromoted: true, profile, approval: existing };
  }
  const approval = { profileId: input.profileId, version: input.version, imageDigest: input.imageDigest, approvedAt: new Date().toISOString(), approvalReference: input.approvalReference.trim() };
  registry.promotions.push(approval);
  fs.mkdirSync(lifecycleRoot, { recursive: true, mode: 0o700 });
  const temporary = `${lifecycleFile}.${randomUUID()}.tmp`;
  const descriptor = fs.openSync(temporary, "wx", 0o600);
  try { fs.writeFileSync(descriptor, JSON.stringify(registry, null, 2) + "\n"); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, lifecycleFile);
  fs.chmodSync(lifecycleFile, 0o600);
  return { promoted: true, profile, approval };
}

function assertProfileMountLayout(profile: ServiceProfile): void {
  const names = new Set<string>();
  const targets = new Set<string>();
  for (const mount of profile.mounts) {
    if (names.has(mount.name)) throw new Error("Service profile mount names must be unique");
    if (targets.has(mount.target)) throw new Error("Service profile mount targets must be unique");
    if (!mount.target.startsWith("/") || mount.target.includes("//") || mount.target.split("/").includes("..")) {
      throw new Error("Service profile mount targets must be canonical absolute paths");
    }
    names.add(mount.name);
    targets.add(mount.target);
  }
  for (let index = 0; index < profile.mounts.length; index += 1) {
    const mount = profile.mounts[index]!;
    const parent = profile.mounts.find((candidate) =>
      candidate.target !== mount.target && mount.target.startsWith(candidate.target.replace(/\/$/, "") + "/"));
    if (!parent) continue;
    const intentionalLaravelLogsMount = parent.name === "storage" && mount.name === "logs"
      && parent.target === "/app/storage" && mount.target === "/app/storage/logs"
      && profile.mounts.indexOf(parent) < index;
    if (!intentionalLaravelLogsMount) throw new Error("Service profile contains an unsupported nested mount");
  }
}

function cloneProfile(profile: ServiceProfile): ServiceProfile {
  return structuredClone(profile);
}

export function listServiceProfiles(input: { includeDefinitionOnly?: boolean } = {}) {
  const profiles = PROFILES.map((item) => applyLifecycle(cloneProfile(item))).filter((profile) => input.includeDefinitionOnly !== false || profile.readiness === "deployable");
  return { count: profiles.length, profiles };
}

export function getServiceProfile(profileId: string, version = 1): ServiceProfile {
  if (!/^[a-z][a-z0-9-]{1,63}$/.test(profileId)) throw new Error("Invalid project environment profile ID");
  if (!Number.isSafeInteger(version) || version < 1) throw new Error("Profile version must be a positive integer");
  const profile = PROFILES.find((item) => item.id === profileId && item.version === version);
  if (!profile) throw new Error(`Unknown project environment profile '${profileId}' version ${version}`);
  const resolved = applyLifecycle(cloneProfile(profile));
  assertProfileMountLayout(resolved);
  return resolved;
}

export function assertServiceProfileDeployable(profile: ServiceProfile): void {
  assertProfileMountLayout(profile);
  if (profile.readiness !== "deployable" || !profile.runtime.imageDigest || !/^[a-z0-9][a-z0-9._/:+-]{0,180}@sha256:[a-f0-9]{64}$/.test(profile.runtime.imageDigest)) {
    throw new Error(`Project environment profile '${profile.id}' version ${profile.version} is definition-only and cannot be provisioned`);
  }
}
