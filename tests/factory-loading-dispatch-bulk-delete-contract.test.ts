import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readModuleFamily } from "../scripts/lib/readModuleFamily.mjs";

function source(file: string): string {
  return readModuleFamily(join(process.cwd(), file));
}

const scanRoutes = source("server/routes/factory/customer-orders/loadingDispatchScanRoutes.ts");
const dispatchRoutes = source("server/routes/factory/customer-orders/loadingDispatchRoutes.ts").replace(
  /app\.post\(\s+/g,
  "app.post("
);
const scanner = source("client/src/pages/factory/FactoryLoadingDispatchScanner.tsx");
// The simplified trip screen lives in a dedicated child component while
// the cancel mutation remains in the extracted state module.
const dispatchScreen = [
  source("client/src/pages/factory/FactoryLoadingDispatch.tsx"),
  source("client/src/pages/factory/FactoryLoadingDispatchDetail.tsx"),
  source("client/src/pages/factory/useFactoryLoadingDispatchState.tsx"),
].join("\n");
const manifest = JSON.parse(source("config/route-manifest.json")) as { routes: string[] };

describe("Factory dispatch bulk scan removal", () => {
  it("exposes selected and all-actions with explicit confirmation and a reason", () => {
    expect(scanner).toContain("Select all filtered");
    expect(scanner).toContain("Delete selected");
    expect(scanner).toContain("Delete all");
    expect(scanner).toContain('scansUrl + "/bulk-remove"');
    expect(scanner).toContain("bulkReason.trim().length < 3");
    expect(scanner).toContain("including scans not currently visible or filtered");
  });

  it("removes exact active scans in one transaction, refuses stale selections, and writes audit evidence", () => {
    const handler = scanRoutes.slice(
      scanRoutes.indexOf('app.post("/api/factory/customer-orders/:id/loading-dispatches/:dispatchId/scans/bulk-remove')
    );
    expect(handler).toContain("canCorrect(role)");
    expect(handler).toContain("db.transaction(async (tx) =>");
    expect(handler).toContain("FOR UPDATE");
    expect(handler).toContain('trip.status !== "OPEN"');
    expect(handler).toContain("found.length !== ids.length");
    expect(handler).toContain("UPDATE factory_loading_dispatch_scans");
    expect(handler).toContain("removed_at = NOW()");
    expect(handler).toContain("BALE_SCANS_BULK_REMOVED");
    expect(handler).not.toMatch(/DELETE FROM factory_loading_dispatch_scans/);
  });
});

describe("Factory dispatch deletion", () => {
  it("exposes a confirmed Delete Dispatch control for an open authorized trip", () => {
    expect(dispatchScreen).toContain('data-testid="button-delete-dispatch"');
    expect(dispatchScreen).toContain('selectedTrip.status === "OPEN"');
    expect(dispatchScreen).toContain("canDeleteDispatch");
    expect(dispatchScreen).toContain('selectedUrl + "/cancel"');
    expect(dispatchScreen).toContain("deleteReason.trim().length < 3");
  });

  it("soft-cancels open or explicitly reopened trips while preserving signed closure and financial evidence", () => {
    const start = dispatchRoutes.indexOf(
      'app.post("/api/factory/customer-orders/:id/loading-dispatches/:dispatchId/cancel"'
    );
    const end = dispatchRoutes.indexOf("// Phase 1 create endpoint.", start);
    const handler = dispatchRoutes.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(handler).toContain('["admin", "owner", "developer"]');
    expect(handler).toContain("db.transaction(async (tx) =>");
    expect(handler).toContain('trip.status !== "OPEN"');
    expect(handler).toContain("factory_loading_dispatch_closure_history");
    expect(handler).toContain("AND reopened_at IS NULL LIMIT 1");
    expect(handler).toContain("if (activeClosures.length)");
    expect(handler).not.toContain("if (closed.length)");
    expect(handler).toContain("factory_dispatch_order_consolidations");
    expect(handler).toContain("reconciled_at IS NOT NULL AND status IN ('DRAFT', 'FINALIZED')");
    expect(handler).toContain("if (signed.length)");
    expect(handler).toContain("factory_dispatch_trip_financials");
    expect(handler).toContain("if (finances.length)");
    expect(handler).toContain("UPDATE factory_loading_dispatch_scans");
    expect(handler).toContain("UPDATE factory_loading_dispatch_expected_bales");
    expect(handler).toContain("status = 'CANCELLED'");
    expect(handler).toContain("DISPATCH_CANCELLED");
    expect(handler).not.toMatch(/DELETE FROM factory_loading_dispatches/);
    expect(handler).not.toMatch(/DELETE FROM factory_loading_dispatch_closure_history/);
    expect(handler).not.toMatch(/UPDATE factory_loading_dispatch_closure_history/);
    expect(handler).not.toMatch(/UPDATE customer_order_bales/);
    expect(handler).not.toMatch(/UPDATE factory_bales/);
  });

  it("keeps canceled trips out of active listings, comparisons, finances, and reports", () => {
    for (const file of [
      "server/routes/factory/customer-orders/loadingDispatchRoutes.ts",
      "server/routes/factory/customer-orders/loadingDispatchComparisonRoutes.ts",
      "server/routes/factory/customer-orders/loadingDispatchOrderOverviewData.ts",
      "server/routes/factory/customer-orders/loadingDispatchReportData.ts",
      "server/services/factory/dispatchTripFinancialGuards.ts",
    ]) {
      expect(source(file), file).toContain("status <> 'CANCELLED'");
    }
  });

  it("registers both routes in the production API inventory", () => {
    expect(manifest.routes).toContain(
      "POST /api/factory/customer-orders/:id/loading-dispatches/:dispatchId/scans/bulk-remove [requireAuth > <anonymous> > <anonymous>]"
    );
    expect(manifest.routes).toContain(
      "POST /api/factory/customer-orders/:id/loading-dispatches/:dispatchId/cancel [requireAuth > <anonymous> > <anonymous>]"
    );
  });
});
