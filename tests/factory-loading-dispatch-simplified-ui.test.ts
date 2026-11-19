import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");
const page = read("client/src/pages/factory/FactoryLoadingDispatch.tsx");
const overview = read("client/src/pages/factory/FactoryLoadingDispatchOverview.tsx");
const state = read("client/src/pages/factory/useFactoryLoadingDispatchState.tsx");
const header = read("client/src/pages/factory/FactoryLoadingDispatchPageHeaderSection.tsx");

describe("Factory dispatch simplified management layout", () => {
  it("shows the simple overview on loading routes while retaining the existing scanner and financial trip workflow", () => {
    expect(page).toContain('dispatchId === null ? (');
    expect(page).toContain("<FactoryLoadingDispatchOverview state={state} />");
    expect(page).toContain("<FactoryLoadingDispatchScanner");
    expect(page).toContain("<FactoryLoadingDispatchLifecycle");
    expect(page).toContain("<FactoryLoadingDispatchFinance");
    expect(page).toContain("<FactoryLoadingDispatchPostingPanel");
    expect(page).toContain("<FactoryLoadingDispatchPoExport");
  });

  it("keeps counts sourced from actual loaded bales and recorded trip scans", () => {
    expect(state).toContain("const loadedQty = orderQuery.data?.bales?.length ?? 0");
    expect(state).toContain("trip.scannedBales");
    expect(state).toContain("const remainingQty = Math.max(0, loadedQty - verifiedQty)");
    expect(overview).toContain("Scanned on trips");
    expect(overview).toContain("Overall scan progress");
    expect(overview).toContain('aria-valuenow={completion}');
  });

  it("gives operators a compact table with the original navigation, status filter and create path", () => {
    expect(state).toContain('data-testid="dispatch-trips-table"');
    expect(state).toContain("visibleTrips.map((trip)");
    expect(state).toContain('setFilter("open")');
    expect(state).toContain('setFilter("closed")');
    expect(state).toContain('navigate(tripPath(orderId, trip.id))');
    expect(header).toContain('data-testid="button-new-dispatch"');
  });

  it("keeps financial tabs and their endpoints restricted to privileged users", () => {
    expect(overview).toContain('canViewFinancialDashboard && (');
    expect(overview).toContain('enabled: canViewFinancialDashboard && activeTab !== "trips"');
    expect(overview).toContain('enabled: canViewFinancialDashboard && activeTab === "invoice"');
    expect(overview).toContain('const activeTab: Tab = canViewFinancialDashboard ? tab : "trips"');
    expect(overview).toContain("FactoryDispatchOrderDashboard");
    expect(overview).toContain("advancedOpen && (");
  });

  it("routes final review to the existing comparison flow without posting financial transactions from the dashboard", () => {
    expect(overview).toContain('navigate(tripPath(orderId) + "/compare")');
    expect(overview).toContain("This button does not post an invoice");
    expect(header).toContain('data-testid="button-dispatch-reports"');
    expect(header).toContain('data-testid="button-compare-all-dispatches"');
  });
});
