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
  const profiles = PROFILES.filter((profile) => input.includeDefinitionOnly !== false || profile.readiness === "deployable");
  return { count: profiles.length, profiles: profiles.map(cloneProfile) };
}

export function getServiceProfile(profileId: string, version = 1): ServiceProfile {
  if (!/^[a-z][a-z0-9-]{1,63}$/.test(profileId)) throw new Error("Invalid project environment profile ID");
  if (!Number.isSafeInteger(version) || version < 1) throw new Error("Profile version must be a positive integer");
  const profile = PROFILES.find((item) => item.id === profileId && item.version === version);
  if (!profile) throw new Error(`Unknown project environment profile '${profileId}' version ${version}`);
  assertProfileMountLayout(profile);
  return cloneProfile(profile);
}

export function assertServiceProfileDeployable(profile: ServiceProfile): void {
  assertProfileMountLayout(profile);
  if (profile.readiness !== "deployable" || !profile.runtime.imageDigest || !/^[a-z0-9][a-z0-9._/:+-]{0,180}@sha256:[a-f0-9]{64}$/.test(profile.runtime.imageDigest)) {
    throw new Error(`Project environment profile '${profile.id}' version ${profile.version} is definition-only and cannot be provisioned`);
  }
}
