import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const DEFAULT_REPOSITORY = "/opt/vps-mcp";
const DEFAULT_LOCK = "/var/lib/vps-mcp/deploy-production.lock";
const DEFAULT_REMOTE = "https://github.com/deputy-proxy/vps-mcp.git";
const DEFAULT_HEALTH_URL = "http://127.0.0.1:3000/mcp";
const DEFAULT_SERVICE = "vps-mcp.service";
const SAFE_ENV = {
  PATH: "/usr/local/bin:/usr/bin:/bin",
  HOME: "/var/lib/vps-mcp",
  LANG: "C.UTF-8",
  LC_ALL: "C",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  NPM_CONFIG_UPDATE_NOTIFIER: "false",
};

export function isCommitSha(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}

function defaultRun(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: SAFE_ENV,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: options.timeoutMs ?? 10 * 60 * 1000,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
  };
}

export function createProductionDeployer({
  run = defaultRun,
  repository = DEFAULT_REPOSITORY,
  lockPath = DEFAULT_LOCK,
  remoteUrl = DEFAULT_REMOTE,
  healthUrl = DEFAULT_HEALTH_URL,
  serviceName = DEFAULT_SERVICE,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  healthAttempts = 15,
  healthIntervalMs = 2_000,
} = {}) {
  const git = (args, options = {}) => run("/usr/bin/git", ["-C", repository, ...args], options);
  const npm = (args) => run("/usr/bin/npm", args, { cwd: repository, timeoutMs: 10 * 60 * 1000 });
  const sudo = (args) => run("/usr/bin/sudo", ["-n", ...args]);
  const systemctl = (args) => run("/usr/bin/systemctl", args);

  function output(result) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }

  function requireSuccess(result, operation) {
    output(result);
    if (result.status !== 0) throw new Error(`${operation} failed (exit ${result.status})`);
    return result.stdout.trim();
  }

  async function waitForHealth() {
    for (let attempt = 1; attempt <= healthAttempts; attempt += 1) {
      const result = run("/usr/bin/curl", ["--silent", "--show-error", "--max-time", "8", "--output", "/dev/null", "--write-out", "%{http_code}", healthUrl]);
      if (result.status === 0 && result.stdout.trim() === "401") return;
      if (attempt < healthAttempts) await sleep(healthIntervalMs);
    }
    throw new Error(`MCP health check did not return the expected unauthenticated HTTP 401 from ${healthUrl}`);
  }

  async function rollback(previousSha) {
    console.error(`Deployment failed. Attempting rollback to ${previousSha}.`);
    try {
      requireSuccess(git(["reset", "--hard", previousSha]), "Git rollback");
      requireSuccess(npm(["ci"]), "Rollback dependency installation");
      requireSuccess(npm(["run", "build"]), "Rollback build");
      requireSuccess(sudo(["/usr/bin/systemctl", "restart", serviceName]), "Rollback service restart");
      requireSuccess(systemctl(["is-active", "--quiet", serviceName]), "Rollback service status");
      await waitForHealth();
      console.error(`Rollback completed successfully at ${previousSha}.`);
      return true;
    } catch (error) {
      console.error(`CRITICAL: rollback failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  async function deploy(expectedSha) {
    if (!isCommitSha(expectedSha)) throw new Error("Expected deployment commit must be a full 40-character lowercase Git SHA");
    let lockAcquired = false;
    let previousSha;
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      lockAcquired = true;
      writeFileSync(path.join(lockPath, "pid"), `${process.pid}\n`, { mode: 0o600 });

      const remote = requireSuccess(git(["config", "--get", "remote.origin.url"]), "Read origin URL");
      if (remote !== remoteUrl) throw new Error(`Unexpected origin URL; expected ${remoteUrl}`);
      const branch = requireSuccess(git(["branch", "--show-current"]), "Read checkout branch");
      if (branch !== "main") throw new Error(`Production checkout must be on main, not ${branch || "detached HEAD"}`);
      const dirty = requireSuccess(git(["status", "--porcelain", "--untracked-files=all"]), "Check production checkout");
      if (dirty) throw new Error("Production checkout is dirty; refusing to overwrite local changes");
      previousSha = requireSuccess(git(["rev-parse", "HEAD"]), "Read current production commit");

      requireSuccess(git(["fetch", "--prune", "origin", "main"], { timeoutMs: 120_000 }), "Fetch main");
      const remoteSha = requireSuccess(git(["rev-parse", "refs/remotes/origin/main"]), "Read origin/main");
      if (remoteSha !== expectedSha) {
        console.log(`Deployment superseded: workflow requested ${expectedSha}, current origin/main is ${remoteSha}. No files changed.`);
        return { status: "superseded", expectedSha, remoteSha };
      }
      const ancestry = git(["merge-base", "--is-ancestor", previousSha, expectedSha]);
      if (ancestry.status !== 0) throw new Error("Production update is not a fast-forward from the currently deployed commit");

      requireSuccess(git(["pull", "--ff-only", "origin", "main"], { timeoutMs: 120_000 }), "Fast-forward production checkout");
      try {
        const deployedSha = requireSuccess(git(["rev-parse", "HEAD"]), "Verify checked-out release");
        if (deployedSha !== expectedSha) throw new Error(`Checked-out commit ${deployedSha} does not match requested release ${expectedSha}`);
        requireSuccess(npm(["ci"]), "Install production dependencies");
        requireSuccess(npm(["run", "build"]), "Build production application");
        requireSuccess(sudo(["/usr/bin/systemctl", "restart", serviceName]), "Restart production service");
        requireSuccess(systemctl(["is-active", "--quiet", serviceName]), "Verify production service status");
        await waitForHealth();
      } catch (error) {
        const rolledBack = await rollback(previousSha);
        throw new Error(`${error instanceof Error ? error.message : String(error)}${rolledBack ? "; previous release restored" : "; rollback also failed, immediate operator intervention required"}`);
      }

      console.log(`Production deployment successful: ${expectedSha}`);
      return { status: "deployed", commit: expectedSha, previousCommit: previousSha };
    } finally {
      if (lockAcquired) rmSync(lockPath, { recursive: true, force: true });
    }
  }

  return { deploy };
}

async function main() {
  const input = readFileSync(0, "utf8");
  const expectedSha = input.trim();
  if (!isCommitSha(expectedSha) || input.trim().split(/\s+/).length !== 1) {
    throw new Error("Expected exactly one full Git commit SHA on standard input");
  }
  const result = await createProductionDeployer().deploy(expectedSha);
  if (result.status === "superseded") process.exitCode = 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch((error) => {
    console.error(`Production deployment failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
