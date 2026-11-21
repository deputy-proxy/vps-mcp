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

  it("requires deployment workflows to be branch-scoped and guarded", () => {
    const production = {
      file: ".github/workflows/deploy-production.yml",
      document: {
        on: { push: { branches: ["main"] } },
        jobs: { deploy: { environment: "production", if: "github.ref == 'refs/heads/main'" } },
      },
    };
    const development = {
      file: ".github/workflows/deploy-development.yml",
      document: {
        on: { push: { branches: ["development"] } },
        jobs: { deploy: { environment: "development", if: "github.ref_name == 'development'" } },
      },
    };
    expect(validateWorkflows([ci, production, development])).toMatchObject({ valid: true, errors: [] });
    const unsafe = { ...production, document: { ...production.document, on: { push: { branches: ["main", "development"] } }, jobs: { deploy: { environment: "production", if: "always()" } } } };
    expect(validateWorkflows([ci, unsafe]).valid).toBe(false);
    const missingEnvironment = { ...production, document: { ...production.document, jobs: { deploy: { "runs-on": "ubuntu-latest" } } } };
    expect(validateWorkflows([ci, missingEnvironment]).valid).toBe(false);
  });

  it("allows feature PRs only into development", () => {
    expect(validatePullRequest({ pull_request: { head: { ref: "feat/41" }, base: { ref: "development" } } })).toMatchObject({ valid: true, kind: "feature" });
    expect(validatePullRequest({ pull_request: { head: { ref: "feat/41" }, base: { ref: "main" } } }).valid).toBe(false);
  });

  it("requires release notes for development-to-main promotion", () => {
    expect(validatePullRequest({ pull_request: { head: { ref: "development" }, base: { ref: "main" }, body: "## Release summary\n\nPromotes tested changes." } })).toMatchObject({ valid: true, kind: "release" });
    expect(validatePullRequest({ pull_request: { head: { ref: "development" }, base: { ref: "main" }, body: "## Release summary\n\n## Tests\nPassed." } }).valid).toBe(false);
  });

  it("requires a development reconciliation plan for production hotfixes", () => {
    expect(validatePullRequest({ pull_request: { head: { ref: "hotfix/auth" }, base: { ref: "main" }, body: "## Development reconciliation\n\nMerge this fix back immediately." } })).toMatchObject({ valid: true, kind: "hotfix" });
    expect(validatePullRequest({ pull_request: { head: { ref: "hotfix/auth" }, base: { ref: "main" }, body: "No reconciliation." } }).valid).toBe(false);
  });
});
