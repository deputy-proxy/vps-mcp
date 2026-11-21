import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyBranchPolicy,
  buildBranchGovernanceRuleset,
  evaluateBranchRules,
  inspectBranchPolicy,
  validateTaskBranchCreation,
} from "./branch-policy.js";

const requiredRules = [
  { type: "deletion" },
  { type: "non_fast_forward" },
  { type: "pull_request", parameters: { required_approving_review_count: 1, dismiss_stale_reviews_on_push: true } },
  { type: "required_status_checks", parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: "quality" }] } },
];

afterEach(() => vi.unstubAllGlobals());

describe("branch governance policy", () => {
  it("accepts only the required branch rules and CI context", () => {
    expect(evaluateBranchRules("main", requiredRules, ["quality"])).toMatchObject({ status: "compliant", compliant: true, missingRequirements: [] });
    expect(evaluateBranchRules("development", [{ type: "pull_request" }], ["quality"])).toMatchObject({
      status: "non_compliant",
      compliant: false,
      missingRequirements: expect.arrayContaining(["strict required status checks", "branch deletion prevention", "force-push prevention"]),
    });
    const nonStrict = requiredRules.map((rule) => rule.type === "required_status_checks" ? { ...rule, parameters: { ...rule.parameters, strict_required_status_checks_policy: false } } : rule);
    expect(evaluateBranchRules("main", nonStrict, ["quality"]).compliant).toBe(false);
  });


  it("requires task branches to originate from development and use a non-protected name", () => {
    expect(validateTaskBranchCreation({ branchName: "feat/example", baseBranch: "development" })).toMatchObject({ valid: true });
    expect(validateTaskBranchCreation({ branchName: "feat/example", baseBranch: "main" }).valid).toBe(false);
    expect(validateTaskBranchCreation({ branchName: "main", baseBranch: "development" }).valid).toBe(false);
    expect(validateTaskBranchCreation({ branchName: "development", baseBranch: "development" }).valid).toBe(false);
    for (const branchName of ["feat//bad", "feat/../bad", "feat/name.lock", "feat/has space", "feat\\bad", "-bad", "feat/@{bad}", "@", " feat/trimmed", "feat/trailing "]) {
      expect(validateTaskBranchCreation({ branchName, baseBranch: "development" })).toMatchObject({ valid: false });
    }
  });

  it("builds a ruleset for both protected branches with no bypass actors", () => {
    expect(buildBranchGovernanceRuleset(["quality"])).toMatchObject({
      name: "VPS managed branch governance",
      target: "branch",
      enforcement: "active",
      bypass_actors: [],
      conditions: { ref_name: { include: ["refs/heads/main", "refs/heads/development"], exclude: [] } },
      rules: expect.arrayContaining([
        { type: "deletion" },
        { type: "non_fast_forward" },
        { type: "required_status_checks", parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: "quality" }] } },
      ]),
    });
  });

  it("reports unavailable GitHub ruleset access without treating it as protection", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "forbidden" }), { status: 403 })));
    const result = await inspectBranchPolicy({ fullName: "acme/demo", branches: ["main", "development"], requiredStatusChecks: ["quality"] });
    expect(result).toMatchObject({ status: "unavailable", compliant: false });
    expect(result.branches.every((branch) => branch.status === "unavailable")).toBe(true);
  });

  it("reports missing branches and never creates them", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await applyBranchPolicy({ fullName: "acme/demo", branches: ["main"], requiredStatusChecks: ["quality"], confirm: true });
    expect(result).toMatchObject({ applied: false, missingBranches: ["development"] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("creates the ruleset only after explicit confirmation and verifies it", async () => {
    let created = false;
    let submitted: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.includes("/rules/branches/")) return new Response(JSON.stringify(created ? requiredRules : []), { status: 200 });
      if (url.includes("/rulesets?") && method === "GET") return new Response("[]", { status: 200 });
      if (url.endsWith("/rulesets") && method === "POST") {
        submitted = JSON.parse(String(init?.body)) as Record<string, unknown>;
        created = true;
        return new Response(JSON.stringify({ id: 42, name: "VPS managed branch governance" }), { status: 201 });
      }
      return new Response("{}", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await applyBranchPolicy({ fullName: "acme/demo", branches: ["main", "development"], requiredStatusChecks: ["quality"], token: "test-token", confirm: true });
    expect(result).toMatchObject({ applied: true, rulesetId: 42, policy: { status: "compliant", compliant: true } });
    expect(submitted).toMatchObject({ enforcement: "active", bypass_actors: [], conditions: { ref_name: { include: ["refs/heads/main", "refs/heads/development"] } } });
    expect(fetchMock.mock.calls.some((call) => new Headers(call[1]?.headers).get("authorization") === "Bearer test-token")).toBe(true);
  });

  it("does not create another ruleset when effective branch rules are already compliant", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(requiredRules), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await applyBranchPolicy({ fullName: "acme/demo", branches: ["main", "development"], requiredStatusChecks: ["quality"], confirm: true });
    expect(result).toMatchObject({ applied: false, alreadyCompliant: true, policy: { compliant: true } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("requires an admin token before applying a non-compliant policy", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", { status: 200 })));
    await expect(applyBranchPolicy({ fullName: "acme/demo", branches: ["main", "development"], requiredStatusChecks: ["quality"], confirm: true })).rejects.toThrow("REPOSITORY_GITHUB_TOKEN is required");
  });
});

