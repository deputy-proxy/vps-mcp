import { describe, expect, it } from "vitest";
import { validatePullRequest, validateWorkflows } from "./check-branch-policy.mjs";

const ci = {
  file: ".github/workflows/ci.yml",
  document: {
    on: { push: { branches: ["main", "development", "feat/**"] }, pull_request: { branches: ["main", "development"] } },
    jobs: { quality: { "runs-on": "ubuntu-latest" } },
  },
};

describe("branch governance workflow validation", () => {
  it("requires CI on both long-lived branches", () => {
    expect(validateWorkflows([ci])).toMatchObject({ valid: true, errors: [] });
    expect(validateWorkflows([{ ...ci, document: { ...ci.document, on: { push: { branches: ["main"] }, pull_request: { branches: ["development"] } } } }]).valid).toBe(false);
  });

  it("requires same-workflow deployments to be quality-gated and branch-guarded", () => {
    const production = {
      file: ".github/workflows/ci.yml",
      document: {
        ...ci.document,
        jobs: {
          ...ci.document.jobs,
          "deploy-production": {
            needs: ["quality"],
            environment: "production",
            if: "github.event_name == 'push' && github.ref == 'refs/heads/main' && vars.VPS_PRODUCTION_DEPLOY_ENABLED == 'true'",
            concurrency: { group: "production", "cancel-in-progress": false },
          },
        },
      },
    };
    expect(validateWorkflows([production])).toMatchObject({ valid: true, errors: [] });
    const crossEnvironment = {
      ...production,
      document: {
        ...production.document,
        jobs: {
          ...production.document.jobs,
          "deploy-production": {
            ...production.document.jobs["deploy-production"],
            if: "github.event_name == 'push' && (github.ref == 'refs/heads/main' || github.ref == 'refs/heads/development') && vars.VPS_PRODUCTION_DEPLOY_ENABLED == 'true'",
          },
        },
      },
    };
    expect(validateWorkflows([crossEnvironment]).valid).toBe(false);
    const missingQualityGate = {
      ...production,
      document: {
        ...production.document,
        jobs: {
          ...production.document.jobs,
          "deploy-production": { environment: "production", if: "github.event_name == 'push' && github.ref == 'refs/heads/main' && vars.VPS_PRODUCTION_DEPLOY_ENABLED == 'true'", concurrency: { group: "production", "cancel-in-progress": false } },
        },
      },
    };
    expect(validateWorkflows([missingQualityGate]).valid).toBe(false);
  });

  it("requires deployment workflows to be branch-scoped and guarded", () => {
    const production = {
      file: ".github/workflows/deploy-production.yml",
      document: {
        on: { push: { branches: ["main"] } },
        jobs: { deploy: { environment: "production", if: "github.event_name == 'push' && github.ref == 'refs/heads/main' && vars.VPS_PRODUCTION_DEPLOY_ENABLED == 'true'", concurrency: { group: "production", "cancel-in-progress": false } } },
      },
    };
    const development = {
      file: ".github/workflows/deploy-development.yml",
      document: {
        on: { push: { branches: ["development"] } },
        jobs: { deploy: { environment: "development", if: "github.event_name == 'push' && github.ref_name == 'development'", concurrency: { group: "development", "cancel-in-progress": false } } },
      },
    };
    expect(validateWorkflows([ci, production, development])).toMatchObject({ valid: true, errors: [] });
    const unsafe = { ...production, document: { ...production.document, on: { push: { branches: ["main", "development"] } }, jobs: { deploy: { environment: "production", if: "always()", concurrency: { group: "production", "cancel-in-progress": false } } } } };
    expect(validateWorkflows([ci, unsafe]).valid).toBe(false);
    const missingEnvironment = { ...production, document: { ...production.document, jobs: { deploy: { "runs-on": "ubuntu-latest", concurrency: { group: "production", "cancel-in-progress": false } } } } };
    expect(validateWorkflows([ci, missingEnvironment]).valid).toBe(false);
  });

  it("allows feature PRs only into development", () => {
    expect(validatePullRequest({ pull_request: { head: { ref: "feat/41" }, base: { ref: "development" } } })).toMatchObject({ valid: true, kind: "feature" });
    expect(validatePullRequest({ pull_request: { head: { ref: "feat/41" }, base: { ref: "main" } } }).valid).toBe(false);
  });

  it("requires an explicit reconciliation plan for main history returning to development", () => {
    expect(validatePullRequest({
      pull_request: {
        head: { ref: "reconcile/main-into-development" },
        base: { ref: "development" },
        body: "## Main reconciliation\n\nBring the production merge history back into development.",
      },
    })).toMatchObject({ valid: true, kind: "reconciliation" });
    expect(validatePullRequest({
      pull_request: {
        head: { ref: "reconcile/main-into-development" },
        base: { ref: "development" },
        body: "No reconciliation notes.",
      },
    }).valid).toBe(false);
    expect(validatePullRequest({
      pull_request: {
        head: { ref: "reconcile/main-into-development" },
        base: { ref: "main" },
        body: "## Main reconciliation\n\nWrong direction.",
      },
    }).valid).toBe(false);
  });

  it("requires release notes for development-to-main promotion", () => {
    expect(validatePullRequest({ pull_request: { head: { ref: "development" }, base: { ref: "main" }, body: "## Release summary\n\nPromotes tested changes." } })).toMatchObject({ valid: true, kind: "release" });
    expect(validatePullRequest({ pull_request: { head: { ref: "development" }, base: { ref: "main" }, body: "## Release summary\n\n## Tests\nPassed." } }).valid).toBe(false);
  });

  it("requires a development reconciliation plan for production hotfixes", () => {
    expect(validatePullRequest({ pull_request: { head: { ref: "hotfix/auth" }, base: { ref: "main" }, body: "## Development reconciliation\n\nMerge this fix back immediately." } })).toMatchObject({ valid: true, kind: "hotfix" });
    expect(validatePullRequest({ pull_request: { head: { ref: "hotfix/auth" }, base: { ref: "main" }, body: "No reconciliation." } }).valid).toBe(false);
  });

  it("allows documented maintenance fixes into main with a development reconciliation plan", () => {
    expect(validatePullRequest({ pull_request: { head: { ref: "fix/issue-36-workspace-acl" }, base: { ref: "main" }, body: "## Development reconciliation\n\nCarry this maintenance change into development after acceptance." } })).toMatchObject({ valid: true, kind: "maintenance" });
    expect(validatePullRequest({ pull_request: { head: { ref: "fix/issue-36-workspace-acl" }, base: { ref: "main" }, body: "Maintenance change." } }).valid).toBe(false);
    expect(validatePullRequest({ pull_request: { head: { ref: "feat/feature" }, base: { ref: "main" }, body: "## Development reconciliation\n\nCarry forward." } }).valid).toBe(false);
  });
});
