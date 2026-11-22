import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createDevelopmentDeployer, isCommitSha, SAFE_DEPLOYMENT_ENV } from "./deploy-development.mjs";

const previousSha = "1".repeat(40);
const releaseSha = "2".repeat(40);
const remoteUrl = "https://github.com/deputy-proxy/vps-mcp.git";
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(overrides = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "vps-mcp-deploy-test-"));
  temporaryDirectories.push(directory);
  const repository = path.join(directory, "repo");
  mkdirSync(repository);
  mkdirSync(path.join(repository, "node_modules"));
  mkdirSync(path.join(repository, "dist"));
  const state = { currentSha: previousSha, remoteSha: releaseSha, origin: remoteUrl, dirty: "", branch: "development", buildFailures: 0, healthStatus: "401", healthFailures: 0, ancestryFailure: false, calls: [] };
  const run = vi.fn((command, args) => {
    state.calls.push([command, ...args]);
    const gitArgs = command.endsWith("git") ? args.slice(args.indexOf("-C") + 2) : [];
    if (command.endsWith("git")) {
      if (gitArgs[0] === "config") return { status: 0, stdout: state.origin };
      if (gitArgs[0] === "branch") return { status: 0, stdout: state.branch };
      if (gitArgs[0] === "status") return { status: 0, stdout: state.dirty };
      if (gitArgs[0] === "rev-parse" && gitArgs[1] === "HEAD") return { status: 0, stdout: state.currentSha };
      if (gitArgs[0] === "fetch") return { status: 0, stdout: "" };
      if (gitArgs[0] === "rev-parse" && gitArgs[1] === "refs/remotes/origin/development") return { status: 0, stdout: state.remoteSha };
      if (gitArgs[0] === "merge-base") return { status: state.ancestryFailure ? 1 : 0, stdout: "" };
      if (gitArgs[0] === "pull") { state.currentSha = releaseSha; return { status: 0, stdout: "Fast-forward" }; }
      if (gitArgs[0] === "reset") { state.currentSha = gitArgs[2]; return { status: 0, stdout: "HEAD is now at previous" }; }
    }
    const npmIndex = args.indexOf("/usr/bin/npm");
    if (command.endsWith("runuser") && npmIndex >= 0 && args[npmIndex + 1] === "run" && state.buildFailures > 0) {
      state.buildFailures -= 1;
      return { status: 1, stdout: "", stderr: "synthetic build failure" };
    }
    if (command.endsWith("curl")) {
      if (state.healthFailures > 0) { state.healthFailures -= 1; return { status: 0, stdout: "503" }; }
      return { status: 0, stdout: state.healthStatus };
    }
    return { status: 0, stdout: "" };
  });
  return {
    state,
    run,
    repository,
    deployer: createDevelopmentDeployer({
      run,
      repository,
      lockPath: path.join(directory, "deploy.lock"),
      sleep: async () => {},
      healthAttempts: 1,
      ...overrides,
    }),
  };
}

describe("development deployment runner", () => {
  it("uses an explicit environment allowlist with Git and npm credential discovery disabled", () => {
    expect(SAFE_DEPLOYMENT_ENV).toMatchObject({
      HOME: "/var/lib/vps-mcp-development",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      NPM_CONFIG_USERCONFIG: "/dev/null",
    });
    expect(Object.keys(SAFE_DEPLOYMENT_ENV).some((key) => /TOKEN|SECRET|PASSWORD|SSH_AUTH|API_KEY/i.test(key))).toBe(false);
  });

  it("accepts only full lowercase commit identifiers", () => {
    expect(isCommitSha(releaseSha)).toBe(true);
    expect(isCommitSha("2".repeat(39))).toBe(false);
    expect(isCommitSha("G".repeat(40))).toBe(false);
  });

  it("deploys only the exact current development commit after clean, fast-forward checks", async () => {
    const { deployer, state, run, repository } = fixture();
    await expect(deployer.deploy(releaseSha)).resolves.toMatchObject({ status: "deployed", commit: releaseSha, previousCommit: previousSha });
    expect(state.currentSha).toBe(releaseSha);
    const npmCalls = run.mock.calls.filter(([command, args]) => command.endsWith("runuser") && args.includes("/usr/bin/npm"));
    expect(npmCalls.some(([, args]) => args[0] === "-u" && args[1] === "vps-mcp-development" && args[args.indexOf("/usr/bin/npm") + 1] === "ci")).toBe(true);
    expect(npmCalls.some(([, args]) => args[args.indexOf("/usr/bin/npm") + 1] === "run")).toBe(true);
    const gitCalls = run.mock.calls.filter(([command]) => command.endsWith("git"));
    expect(gitCalls.length).toBeGreaterThan(0);
    expect(gitCalls.every(([, args]) => args.includes(`safe.directory=${path.resolve(repository)}`))).toBe(true);
    expect(run.mock.calls.filter(([command]) => command.endsWith("chown")).length).toBe(2);
    expect(run.mock.calls.some(([command, args]) => command.endsWith("systemctl") && args[0] === "is-active")).toBe(true);
  });

  it("skips a stale workflow SHA without changing the checkout", async () => {
    const { deployer, state, run } = fixture();
    state.remoteSha = "3".repeat(40);
    await expect(deployer.deploy(releaseSha)).resolves.toMatchObject({ status: "superseded" });
    expect(state.currentSha).toBe(previousSha);
    expect(run.mock.calls.some(([command, args]) => command.endsWith("git") && args.includes("pull"))).toBe(false);
  });

  it("refuses dirty, non-development or non-canonical development checkouts", async () => {
    const dirty = fixture();
    dirty.state.dirty = " M src/index.ts";
    await expect(dirty.deployer.deploy(releaseSha)).rejects.toThrow(/dirty/);
    expect(dirty.state.currentSha).toBe(previousSha);

    const wrongBranch = fixture();
    wrongBranch.state.branch = "main";
    await expect(wrongBranch.deployer.deploy(releaseSha)).rejects.toThrow(/must be on development/);

    const wrongOrigin = fixture();
    wrongOrigin.state.origin = "https://example.com/other.git";
    await expect(wrongOrigin.deployer.deploy(releaseSha)).rejects.toThrow(/Unexpected origin URL/);
  });

  it("refuses non-fast-forward development history", async () => {
    const { deployer, state } = fixture();
    state.ancestryFailure = true;
    await expect(deployer.deploy(releaseSha)).rejects.toThrow(/not a fast-forward/);
    expect(state.currentSha).toBe(previousSha);
  });

  it("restores the previous commit when the new release build fails", async () => {
    const { deployer, state } = fixture();
    state.buildFailures = 1;
    await expect(deployer.deploy(releaseSha)).rejects.toThrow(/previous release restored/);
    expect(state.currentSha).toBe(previousSha);
  });

  it("restores the previous commit when the post-restart health check fails", async () => {
    const { deployer, state } = fixture();
    state.healthFailures = 1;
    await expect(deployer.deploy(releaseSha)).rejects.toThrow(/previous release restored/);
    expect(state.currentSha).toBe(previousSha);
  });


  it("fast-forwards a real temporary development checkout to the exact remote development SHA", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "vps-mcp-deploy-git-integration-"));
    temporaryDirectories.push(directory);
    const remote = path.join(directory, "remote.git");
    const seed = path.join(directory, "seed");
    const development = path.join(directory, "development");
    const git = (cwd, args) => {
      const result = spawnSync("/usr/bin/git", args, { cwd, encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: directory } });
      if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
      return result.stdout.trim();
    };
    git(directory, ["init", "--bare", "--initial-branch=development", remote]);
    git(directory, ["clone", remote, seed]);
    git(seed, ["config", "user.name", "Deployment test"]);
    git(seed, ["config", "user.email", "deployment-test@example.invalid"]);
    writeFileSync(path.join(seed, "version.txt"), "one\n");
    git(seed, ["add", "version.txt"]);
    git(seed, ["commit", "-m", "initial"]);
    git(seed, ["push", "-u", "origin", "development"]);
    git(directory, ["clone", remote, development]);
    const oldSha = git(development, ["rev-parse", "HEAD"]);
    writeFileSync(path.join(seed, "version.txt"), "two\n");
    git(seed, ["add", "version.txt"]);
    git(seed, ["commit", "-m", "release"]);
    git(seed, ["push", "origin", "development"]);
    const newSha = git(seed, ["rev-parse", "HEAD"]);
    const gitInvocations = [];
    const run = (command, args, options = {}) => {
      if (command === "/usr/bin/git") {
        gitInvocations.push(args);
        const result = spawnSync(command, args, { cwd: options.cwd, encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: directory }, timeout: options.timeoutMs ?? 120_000 });
        return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
      }
      if (command === "/usr/bin/curl") return { status: 0, stdout: "401", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    };
    const deployer = createDevelopmentDeployer({ run, repository: development, lockPath: path.join(directory, "deploy.lock"), remoteUrl: remote, sleep: async () => {}, healthAttempts: 1 });
    await expect(deployer.deploy(newSha)).resolves.toMatchObject({ status: "deployed", commit: newSha, previousCommit: oldSha });
    expect(git(development, ["rev-parse", "HEAD"])).toBe(newSha);
    expect(git(development, ["show", "HEAD:version.txt"])).toBe("two");
    expect(gitInvocations.length).toBeGreaterThan(0);
    expect(gitInvocations.every((args) =>
      args[0] === "-c" &&
      args[1] === "credential.helper=" &&
      args.includes(`safe.directory=${development}`),
    )).toBe(true);
  });

  it("refuses symlinked build directories before fetching or changing the checkout", async () => {
    const { deployer, state, repository } = fixture();
    rmSync(path.join(repository, "node_modules"), { recursive: true, force: true });
    symlinkSync("/tmp", path.join(repository, "node_modules"));
    await expect(deployer.deploy(releaseSha)).rejects.toThrow(/symlink build path/);
    expect(state.currentSha).toBe(previousSha);
    expect(state.calls.some(([, ...args]) => args.includes("fetch"))).toBe(false);
  });

  it("refuses a concurrent deployment lock", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "vps-mcp-deploy-lock-test-"));
    temporaryDirectories.push(directory);
    const lockPath = path.join(directory, "deploy.lock");
    mkdirSync(lockPath);
    const { deployer } = fixture({ lockPath });
    await expect(deployer.deploy(releaseSha)).rejects.toThrow();
  });
});
