import { expect, it } from "vitest";
import { assertServiceProfileDeployable, getServiceProfile, listServiceProfiles } from "./service-profiles.js";

it("lists the Laravel profile as definition-only with a bounded resource plan", () => {
  const result = listServiceProfiles();
  expect(result.count).toBe(1);
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
  expect(() => getServiceProfile("laravel-php", 2)).toThrow("Unknown project environment profile");
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
