import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";

function sectionHasContent(body, headingPattern) {
  const lines = String(body ?? "").split(/\r?\n/);
  let collecting = false;
  const content = [];
  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      if (collecting) break;
      collecting = headingPattern.test(line);
      continue;
    }
    if (collecting) content.push(line);
  }
  return collecting && content.join("\n").trim().length > 0;
}

export function validatePullRequest(event) {
  const head = event?.pull_request?.head?.ref;
  const base = event?.pull_request?.base?.ref;
  const body = event?.pull_request?.body ?? "";
  if (typeof head !== "string" || typeof base !== "string") return { valid: false, reason: "Pull request event is missing head/base branch metadata." };
  if (head === "main" || (head === "development" && base !== "main")) return { valid: false, reason: "Protected long-lived branches cannot be pull-request heads for task changes, except development for a governed release to main." };
  if (base === "development") return { valid: true, kind: "feature" };
  if (base !== "main") return { valid: false, reason: "Pull requests must target development, except governed releases and documented hotfixes targeting main." };
  if (head === "development") {
    return sectionHasContent(body, /^##\s+(release summary|release notes|summary)\s*$/i)
      ? { valid: true, kind: "release" }
      : { valid: false, reason: "A development-to-main release PR must include a non-empty 'Release summary', 'Release notes' or 'Summary' section." };
  }
  if (head.startsWith("hotfix/")) {
    return sectionHasContent(body, /^##\s+development reconciliation\s*$/i)
      ? { valid: true, kind: "hotfix" }
      : { valid: false, reason: "A production hotfix PR must include a non-empty 'Development reconciliation' section describing the immediate follow-up to development." };
  }
  return { valid: false, reason: "Production PRs must promote development to main. Only documented hotfix/* branches are an exception." };
}

function branchList(value) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string");
  return typeof value === "string" ? [value] : [];
}

function hasBranchGuard(expression, branch) {
  const value = String(expression ?? "");
  return new RegExp(`(?:github\\.ref\\s*==\\s*['\"]refs/heads/${branch}['\"]|github\\.ref_name\\s*==\\s*['\"]${branch}['\"]|refs/heads/${branch})`).test(value);
}

export function validateWorkflows(workflows) {
  const errors = [];
  const qualityWorkflow = workflows.find(({ document }) => document?.jobs?.quality);
  if (!qualityWorkflow) errors.push("A stable CI job named 'quality' is required for branch protection checks.");
  else {
    const on = qualityWorkflow.document.on ?? qualityWorkflow.document["on"] ?? {};
    const pushBranches = branchList(on.push?.branches);
    const pullRequestBranches = branchList(on.pull_request?.branches);
    for (const branch of ["main", "development"]) {
      if (!pushBranches.includes(branch)) errors.push(`${qualityWorkflow.file}: CI must run on pushes to ${branch}.`);
      if (!pullRequestBranches.includes(branch)) errors.push(`${qualityWorkflow.file}: CI must run on pull requests targeting ${branch}.`);
    }
  }

  for (const { file, document } of workflows) {
    const on = document?.on ?? document?.["on"] ?? {};
    const pushBranches = branchList(on.push?.branches);
    for (const [jobId, job] of Object.entries(document?.jobs ?? {})) {
      const environment = typeof job?.environment === "string" ? job.environment : job?.environment?.name;
      const looksLikeDeployment = /deploy/i.test(jobId) || /deploy/i.test(String(job?.name ?? ""));
      if (looksLikeDeployment && typeof environment !== "string") {
        errors.push(`${file}:${jobId}: deployment jobs must declare a production or development environment so deployment secrets are environment-scoped.`);
        continue;
      }
      if (typeof environment !== "string") continue;
      const target = environment.toLowerCase();
      if (target !== "production" && target !== "development") {
        if (looksLikeDeployment) errors.push(`${file}:${jobId}: deployment jobs must use the production or development environment.`);
        continue;
      }
      const expected = target === "production" ? "main" : "development";
      const forbidden = target === "production" ? "development" : "main";
      if (pushBranches.length !== 1 || pushBranches[0] !== expected) errors.push(`${file}:${jobId}: ${target} deployment push trigger must be restricted to ${expected} only.`);
      if (pushBranches.includes(forbidden)) errors.push(`${file}:${jobId}: ${target} deployment must not be triggered by pushes to ${forbidden}.`);
      if (!hasBranchGuard(job.if, expected)) errors.push(`${file}:${jobId}: ${target} deployment requires a job-level ref guard for ${expected}.`);
    }
  }
  return { valid: errors.length === 0, errors };
}

export function loadWorkflows(directory = ".github/workflows") {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter((name) => /\.ya?ml$/i.test(name)).sort().map((name) => {
    const file = path.join(directory, name);
    return { file, document: parse(fs.readFileSync(file, "utf8")) ?? {} };
  });
}

function main() {
  const workflowResult = validateWorkflows(loadWorkflows());
  const errors = [...workflowResult.errors];
  if (process.env.GITHUB_EVENT_NAME === "pull_request") {
    let event;
    try { event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")); }
    catch { errors.push("Unable to read the GitHub pull_request event payload."); }
    if (event) {
      const result = validatePullRequest(event);
      if (!result.valid) errors.push(result.reason);
      else console.log(`Pull request direction accepted: ${result.kind}`);
    }
  }
  if (errors.length) {
    for (const error of errors) console.error(`FAIL: ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log("Branch governance workflow checks passed.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) main();
