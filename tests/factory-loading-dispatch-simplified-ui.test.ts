import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");
const page = read("client/src/pages/factory/FactoryLoadingDispatch.tsx");
const overview = read("client/src/pages/factory/FactoryLoadingDispatchOverview.tsx");
const detail = read("client/src/pages/factory/FactoryLoadingDispatchDetail.tsx");
const state = read("client/src/pages/factory/useFactoryLoadingDispatchState.tsx");
const header = read("client/src/pages/factory/FactoryLoadingDispatchPageHeaderSection.tsx");
const scanner = read("client/src/pages/factory/FactoryLoadingDispatchScanner.tsx");
const scannerTable = read("client/src/pages/factory/FactoryLoadingDispatchScannerCardSection.tsx");
const lifecycle = read("client/src/pages/factory/FactoryLoadingDispatchLifecycle.tsx");
const lifecycleActions = read("client/src/pages/factory/FactoryLoadingDispatchLifecycleDispatchLifecycle.tsx");

describe("Factory dispatch simplified management layout", () => {
  it("separates the overview and the single-trip screen without losing the existing scanner or accounting", () => {
    expect(page).toContain('dispatchId === null ? (');
    expect(page).toContain("<FactoryLoadingDispatchOverview state={state} />");
    expect(page).toContain("<FactoryLoadingDispatchDetail state={state} />");
    expect(detail).toContain("<FactoryLoadingDispatchScanner");
    expect(detail).toContain("<FactoryLoadingDispatchLifecycle");
    expect(detail).toContain("<FactoryLoadingDispatchFinance");
    expect(detail).toContain("<FactoryLoadingDispatchPostingPanel");
    expect(detail).not.toContain("FactoryLoadingDispatchPoExport");
  });

  it("keeps loading counts based on source bales and actual per-trip scans", () => {
    expect(state).toContain("const loadedQty = orderQuery.data?.bales?.length ?? 0");
    expect(state).toContain("trip.scannedBales");
    expect(state).toContain("const remainingQty = Math.max(0, loadedQty - verifiedQty)");
    expect(overview).toContain("Scanned on trips");
    expect(detail).toContain("Scanned on trip");
    expect(detail).toContain("Overall scan progress");
    expect(detail).toContain("selectedTrip.scannedBales ?? tripInList?.scannedBales");
    expect(detail).toContain("aria-valuenow={completion}");
  });

  it("shows a compact trip table and uses existing actions", () => {
    expect(state).toContain('data-testid="dispatch-trips-table"');
    expect(state).toContain("visibleTrips.map((trip)");
    expect(state).toContain('setFilter("open")');
    expect(state).toContain('setFilter("closed")');
    expect(state).toContain('navigate(tripPath(orderId, trip.id))');
    expect(header).toContain('data-testid="button-new-dispatch"');
    expect(header).toContain('button-dispatch-back');
    expect(detail).toContain('data-testid="button-edit-dispatch"');
    expect(detail).toContain('data-testid="button-delete-dispatch"');
  });

  it("renders inline scanning and a smaller verified-bale table while retaining correction controls", () => {
    expect(detail).toContain("embedded");
    expect(scanner).toContain("embedded={embedded}");
    expect(scannerTable).toContain('data-testid="button-delete-all-dispatch-scans"');
    expect(scannerTable).toContain('data-testid="button-remove-dispatch-scan-"');
    expect(scannerTable).toContain("!embedded &&");
    expect(detail).toContain('data-testid="button-refresh-trip-detail"');
  });

  it("keeps End Dispatch behind the existing review and confirmation dialog", () => {
    expect(detail).toContain("compact");
    expect(lifecycle).toContain("compact={props.compact}");
    expect(lifecycleActions).toContain('data-testid="button-end-dispatch"');
    expect(lifecycleActions).toContain("setCloseOpen(true)");
    expect(lifecycle).toContain('data-testid="button-confirm-end-dispatch"');
    expect(lifecycle).toContain("canConfirmEnd");
    expect(detail).toContain('navigate(tripPath(orderId) + "/compare")');
  });

  it("keeps financial panels permission-gated and collapsible, without an ERP PO Excel panel", () => {
    expect(overview).toContain("canViewFinancialDashboard");
    expect(detail).toContain("canViewFinancialDashboard");
    expect(detail).toContain("advancedOpen && (");
    expect(detail).toContain('data-testid="dispatch-toggle-trip-options"');
    expect(detail).not.toContain("ERP PO Excel export");
    expect(detail).not.toContain("FactoryLoadingDispatchPoExport");
    expect(overview).toContain("FactoryDispatchOrderDashboard");
  });
});
