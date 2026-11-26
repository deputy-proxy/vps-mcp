import { describe, expect, it } from "vitest";
import { DASHBOARD_HTML } from "./dashboard-html.js";

describe("dashboard header", () => {
  it("uses the CR8OR SVG brand mark and keeps the compact document title", () => {
    expect(DASHBOARD_HTML).toContain("<title>cr8or.sndbx</title>");
    expect(DASHBOARD_HTML).toContain('<img class="brand-logo" src="/dashboard/assets/cr8or-logo.svg" alt="CR8OR" width="65" height="18">');
    expect(DASHBOARD_HTML).not.toContain("INFRASTRUCTURE / OBSERVABILITY");
    expect(DASHBOARD_HTML).not.toContain("Host capacity and managed task workloads");
  });

  it("renders accessible icon controls and dropdowns for warnings, refresh and sign out", () => {
    expect(DASHBOARD_HTML).toContain('aria-label="Partial data"');
    expect(DASHBOARD_HTML).toContain('aria-label="Data warnings"');
    expect(DASHBOARD_HTML).toContain('id="data-status-list"');
    expect(DASHBOARD_HTML).toContain('id="refresh-button"');
    expect(DASHBOARD_HTML).toContain('aria-label="User menu"');
    expect(DASHBOARD_HTML).toContain('action="/dashboard/auth/logout"');
    expect(DASHBOARD_HTML).toContain(">Sign out</button>");
  });
});


describe("dashboard host utilization meters", () => {
  it("renders accessible progress bars for CPU, memory and filesystem utilization", () => {
    expect(DASHBOARD_HTML).toContain('role="progressbar" aria-label="CPU utilization"');
    expect(DASHBOARD_HTML).toContain('role="progressbar" aria-label="Memory used"');
    expect(DASHBOARD_HTML).toContain('role="progressbar" aria-label="Data filesystem"');
  });
});
