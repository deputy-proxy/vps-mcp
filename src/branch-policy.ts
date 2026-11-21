export const REQUIRED_BRANCHES = ["main", "development"] as const;
export const BRANCH_POLICY_RULESET_NAME = "VPS managed branch governance";
export const GITHUB_API_VERSION = "2022-11-28";
const API_ROOT = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 10_000;

type GitHubRule = { type?: string; parameters?: Record<string, unknown> };
type BranchRuleEvaluation = {
  branch: string;
  status: "compliant" | "non_compliant" | "unavailable" | "missing";
  compliant: boolean;
  rules: string[];
  checks: {
    pullRequestsRequired: boolean;
    approvalRequired: boolean;
    staleReviewsDismissed: boolean;
    requiredStatusChecks: string[];
    strictStatusChecks: boolean;
    deletionPrevented: boolean;
    forcePushPrevented: boolean;
  };
  missingRequirements: string[];
  detail?: string;
};

function headers(token?: string) {
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
    "User-Agent": "vps-mcp-branch-governance",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function repositoryPath(fullName: string): string {
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?)$/.exec(fullName);
  if (!match) throw new Error("Repository identity is invalid");
  return `/repos/${encodeURIComponent(match[1]!)}/${encodeURIComponent(match[2]!)}`;
}

async function githubRequest<T>(path: string, token?: string, init: RequestInit = {}): Promise<{ status: number; data?: T }> {
  let response: Response;
  try {
    response = await fetch(`${API_ROOT}${path}`, {
      ...init,
      headers: { ...headers(token), ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const name = error instanceof Error && error.name === "TimeoutError" ? "timed out" : "unreachable";
    throw new Error(`GitHub API is ${name}`);
  }
  if (!response.ok) return { status: response.status };
  if (response.status === 204) return { status: response.status };
  return { status: response.status, data: await response.json() as T };
}

export function evaluateBranchRules(branch: string, rules: GitHubRule[], requiredStatusChecks: string[]): BranchRuleEvaluation {
  const byType = new Map<string, GitHubRule[]>();
  for (const rule of rules) {
    const type = rule.type ?? "unknown";
    byType.set(type, [...(byType.get(type) ?? []), rule]);
  }
  const pullRequest = byType.get("pull_request")?.some((rule) => {
    const parameters = rule.parameters ?? {};
    return Number(parameters.required_approving_review_count ?? 0) >= 1
      && parameters.dismiss_stale_reviews_on_push === true;
  }) ?? false;
  const pullRequestRule = byType.get("pull_request")?.find((rule) => {
    const parameters = rule.parameters ?? {};
    return Number(parameters.required_approving_review_count ?? 0) >= 1
      && parameters.dismiss_stale_reviews_on_push === true;
  });
  const pullRequestParameters = pullRequestRule?.parameters ?? {};
  const requiredChecks = (byType.get("required_status_checks") ?? []).flatMap((rule) => {
    const parameters = rule.parameters ?? {};
    const checks = parameters.required_status_checks;
    return Array.isArray(checks) ? checks.flatMap((item) => {
      if (typeof item === "string") return [item];
      if (item && typeof item === "object" && "context" in item && typeof item.context === "string") return [item.context];
      return [];
    }) : [];
  });
  const strictRequiredChecks = (byType.get("required_status_checks") ?? []).filter((rule) => rule.parameters?.strict_required_status_checks_policy === true).flatMap((rule) => {
    const checks = rule.parameters?.required_status_checks;
    return Array.isArray(checks) ? checks.flatMap((item) => {
      if (typeof item === "string") return [item];
      if (item && typeof item === "object" && "context" in item && typeof item.context === "string") return [item.context];
      return [];
    }) : [];
  });
  const checks = {
    pullRequestsRequired: byType.has("pull_request"),
    approvalRequired: pullRequest,
    staleReviewsDismissed: pullRequestParameters.dismiss_stale_reviews_on_push === true,
    requiredStatusChecks: [...new Set(requiredChecks)],
    strictStatusChecks: requiredStatusChecks.every((check) => strictRequiredChecks.includes(check)),
    deletionPrevented: byType.has("deletion"),
    forcePushPrevented: byType.has("non_fast_forward"),
  };
  const missingRequirements: string[] = [];
  if (!checks.pullRequestsRequired) missingRequirements.push("pull requests required");
  if (!checks.approvalRequired) missingRequirements.push("at least one approval and stale-review dismissal required");
  if (!checks.strictStatusChecks) missingRequirements.push("strict required status checks");
  if (requiredStatusChecks.some((check) => !checks.requiredStatusChecks.includes(check))) {
    missingRequirements.push(`required status checks: ${requiredStatusChecks.filter((check) => !checks.requiredStatusChecks.includes(check)).join(", ")}`);
  }
  if (!checks.deletionPrevented) missingRequirements.push("branch deletion prevention");
  if (!checks.forcePushPrevented) missingRequirements.push("force-push prevention");
  return {
    branch,
    status: missingRequirements.length === 0 ? "compliant" : "non_compliant",
    compliant: missingRequirements.length === 0,
    rules: [...byType.keys()].sort(),
    checks,
    missingRequirements,
  };
}

export async function inspectBranchPolicy(input: {
  fullName: string;
  branches: string[];
  requiredStatusChecks: string[];
  token?: string;
}) {
  const base = repositoryPath(input.fullName);
  const branchResults: BranchRuleEvaluation[] = [];
  for (const branch of REQUIRED_BRANCHES) {
    if (!input.branches.includes(branch)) {
      branchResults.push({
        branch,
        status: "missing",
        compliant: false,
        rules: [],
        checks: { pullRequestsRequired: false, approvalRequired: false, staleReviewsDismissed: false, requiredStatusChecks: [], strictStatusChecks: false, deletionPrevented: false, forcePushPrevented: false },
        missingRequirements: ["branch does not exist"],
        detail: "No branch was created or changed. Create it only after verifying the source history and obtaining approval.",
      });
      continue;
    }
    try {
      const response = await githubRequest<GitHubRule[]>(`${base}/rules/branches/${encodeURIComponent(branch)}`, input.token);
      if (response.status !== 200 || !Array.isArray(response.data)) {
        branchResults.push({
          branch,
          status: "unavailable",
          compliant: false,
          rules: [],
          checks: { pullRequestsRequired: false, approvalRequired: false, staleReviewsDismissed: false, requiredStatusChecks: [], strictStatusChecks: false, deletionPrevented: false, forcePushPrevented: false },
          missingRequirements: [],
          detail: `GitHub ruleset inspection unavailable (HTTP ${response.status}). For private repositories, configure a token with Metadata: read.`,
        });
        continue;
      }
      branchResults.push(evaluateBranchRules(branch, response.data, input.requiredStatusChecks));
    } catch (error) {
      branchResults.push({
        branch,
        status: "unavailable",
        compliant: false,
        rules: [],
        checks: { pullRequestsRequired: false, approvalRequired: false, staleReviewsDismissed: false, requiredStatusChecks: [], strictStatusChecks: false, deletionPrevented: false, forcePushPrevented: false },
        missingRequirements: [],
        detail: error instanceof Error ? error.message : "GitHub ruleset inspection failed",
      });
    }
  }
  const compliant = branchResults.every((branch) => branch.compliant);
  const unavailable = branchResults.some((branch) => branch.status === "unavailable");
  return {
    status: compliant ? "compliant" as const : unavailable ? "unavailable" as const : "non_compliant" as const,
    compliant,
    expectedRulesetName: BRANCH_POLICY_RULESET_NAME,
    requiredBranches: [...REQUIRED_BRANCHES],
    requiredStatusChecks: [...input.requiredStatusChecks],
    branches: branchResults,
  };
}

export function validateTaskBranchCreation(input: { branchName: string; baseBranch: string }): { valid: boolean; reason?: string } {
  const branchName = input.branchName.trim();
  if (!branchName || branchName === "main" || branchName === "development") {
    return { valid: false, reason: "Task branches must use a new branch name and cannot reuse a protected long-lived branch." };
  }
  if (input.baseBranch !== "development") {
    return { valid: false, reason: "Task and feature branches must be created from development." };
  }
  return { valid: true };
}

export function buildBranchGovernanceRuleset(requiredStatusChecks: string[]) {
  if (requiredStatusChecks.length === 0 || requiredStatusChecks.some((check) => !check.trim() || check.length > 200)) {
    throw new Error("At least one valid required status check must be configured");
  }
  return {
    name: BRANCH_POLICY_RULESET_NAME,
    target: "branch",
    enforcement: "active",
    bypass_actors: [],
    conditions: { ref_name: { include: REQUIRED_BRANCHES.map((branch) => `refs/heads/${branch}`), exclude: [] } },
    rules: [
      { type: "deletion" },
      { type: "non_fast_forward" },
      { type: "pull_request", parameters: {
        allowed_merge_methods: ["squash", "merge", "rebase"],
        dismiss_stale_reviews_on_push: true,
        require_code_owner_review: false,
        require_last_push_approval: false,
        required_approving_review_count: 1,
        required_review_thread_resolution: true,
      } },
      { type: "required_status_checks", parameters: {
        strict_required_status_checks_policy: true,
        required_status_checks: [...new Set(requiredStatusChecks)].map((context) => ({ context })),
      } },
    ],
  };
}

export async function applyBranchPolicy(input: {
  fullName: string;
  branches: string[];
  requiredStatusChecks: string[];
  token?: string;
  confirm: boolean;
}) {
  const missingBranches = REQUIRED_BRANCHES.filter((branch) => !input.branches.includes(branch));
  const ruleset = buildBranchGovernanceRuleset(input.requiredStatusChecks);
  if (missingBranches.length) return {
    applied: false,
    dryRun: !input.confirm,
    missingBranches,
    ruleset,
    remediation: "No branches were created or changed. Verify the intended source history and obtain explicit approval before creating a missing required branch.",
  };
  const current = await inspectBranchPolicy(input);
  if (current.compliant) return { applied: false, alreadyCompliant: true, policy: current };
  if (!input.confirm) return { applied: false, dryRun: true, policy: current, ruleset };
  if (!input.token) throw new Error("REPOSITORY_GITHUB_TOKEN is required to apply branch governance; it needs Administration: write permission for the target repository");

  const base = repositoryPath(input.fullName);
  const listed = await githubRequest<Array<{ id: number; name: string; source_type?: string }>>(`${base}/rulesets?includes_parents=true&targets=branch`, input.token);
  if (listed.status !== 200 || !Array.isArray(listed.data)) throw new Error(`Could not inspect existing GitHub rulesets before applying policy (HTTP ${listed.status})`);
  const existing = listed.data.find((item) => item.name === BRANCH_POLICY_RULESET_NAME);
  if (existing) {
    throw new Error(`A ruleset named '${BRANCH_POLICY_RULESET_NAME}' already exists (id ${existing.id}, source ${existing.source_type ?? "unknown"}) but the required policy is not compliant. It was not overwritten; review it manually.`);
  }
  const created = await githubRequest<{ id?: number; name?: string }>(`${base}/rulesets`, input.token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ruleset),
  });
  if (created.status !== 201 || !created.data) throw new Error(`GitHub rejected branch ruleset creation (HTTP ${created.status}); no repository branches were changed`);
  const verified = await inspectBranchPolicy(input);
  return { applied: true, rulesetId: created.data.id, rulesetName: created.data.name ?? BRANCH_POLICY_RULESET_NAME, policy: verified };
}

