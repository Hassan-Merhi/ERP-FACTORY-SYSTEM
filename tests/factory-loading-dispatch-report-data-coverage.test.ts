/**
 * loadFactoryDispatchReport
 * (server/routes/factory/customer-orders/loadingDispatchReportData.ts) against
 * a loading driven through the real truck-dispatch HTTP workflow
 * (dispatchFlowFixture), one rolled-back factory company per test. Refusals
 * first: unknown or other-company loadings, unknown trips, a closure without a
 * trip, unknown closures and incomplete closure snapshots. Then the live
 * report, the frozen closure report and older closures without saved truck
 * metadata or manifest, and a reopened closure.
 */
import { describe, expect, it } from "vitest";

import {
  DispatchReportError,
  loadFactoryDispatchReport,
} from "../server/routes/factory/customer-orders/loadingDispatchReportData";
import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { closedTrip, createTrip, loadingWithBales, scan } from "./helpers/dispatchFlowFixture";

async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e
  );
  expect(error).toBeInstanceOf(DispatchReportError);
  const typed = error as DispatchReportError;
  return { status: typed.httpStatus, code: typed.code };
}

/**
 * Older closures predate saved truck metadata and manifests. The signed
 * closure row is append-only by trigger, so the test rewrites it with triggers
 * off for this one statement, inside the rolled-back transaction.
 */
async function rewriteClosure(w: FactoryWorld, dispatchId: number, sqlSet: "legacy" | "broken" | "reopened") {
  await w.q(`SET LOCAL session_replication_role = replica`);
  if (sqlSet === "legacy") {
    await w.q(
      `UPDATE factory_loading_dispatch_closure_history SET truck_snapshot = NULL, manifest_snapshot = NULL WHERE dispatch_id = $1`,
      [dispatchId]
    );
  } else if (sqlSet === "broken") {
    await w.q(
      `UPDATE factory_loading_dispatch_closure_history SET comparison_snapshot = '{"summary":null}'::jsonb WHERE dispatch_id = $1`,
      [dispatchId]
    );
  } else {
    await w.q(
      `UPDATE factory_loading_dispatch_closure_history
          SET reopened_at = now(), reopened_by_username = 'supervisor', reopen_reason = 'Recount'
        WHERE dispatch_id = $1`,
      [dispatchId]
    );
  }
  await w.q(`SET LOCAL session_replication_role = origin`);
}

describe("dispatch report refusals", () => {
  it("refuses unknown loadings, trips and closures", () =>
    withFactoryWorld(async (w) => {
      const { orderId, bales } = await loadingWithBales(w, ["10.00"]);
      const dispatchId = await closedTrip(w, orderId, [bales[0].reference]);
      const companyId = w.companyId;
      expect(await refusal(loadFactoryDispatchReport({ companyId, orderId: 2147483000 }))).toEqual({
        status: 404,
        code: "LOADING_NOT_FOUND",
      });
      expect(await refusal(loadFactoryDispatchReport({ companyId: companyId + 100000, orderId }))).toMatchObject({
        status: 404,
        code: "LOADING_NOT_FOUND",
      });
      expect(await refusal(loadFactoryDispatchReport({ companyId, orderId, dispatchId: 2147483000 }))).toMatchObject({
        status: 404,
        code: "DISPATCH_NOT_FOUND",
      });
      expect(await refusal(loadFactoryDispatchReport({ companyId, orderId, closureId: 1 }))).toEqual({
        status: 400,
        code: "CLOSURE_REQUIRES_TRIP",
      });
      expect(
        await refusal(loadFactoryDispatchReport({ companyId, orderId, dispatchId, closureId: 2147483000 }))
      ).toEqual({ status: 404, code: "CLOSURE_NOT_FOUND" });
    }));

  it("refuses a closure whose saved comparison is incomplete", () =>
    withFactoryWorld(async (w) => {
      const { orderId, bales } = await loadingWithBales(w, ["10.00"]);
      const dispatchId = await closedTrip(w, orderId, [bales[0].reference]);
      await rewriteClosure(w, dispatchId, "broken");
      expect(await refusal(loadFactoryDispatchReport({ companyId: w.companyId, orderId, dispatchId }))).toEqual({
        status: 409,
        code: "CLOSURE_SNAPSHOT_UNAVAILABLE",
      });
    }));
});

describe("dispatch reports", () => {
  it("builds a live loading-wide and live trip report", () =>
    withFactoryWorld(async (w) => {
      const { orderId, bales } = await loadingWithBales(w, ["10.00", "10.00"]);
      const dispatchId = await createTrip(w, orderId);
      await scan(w, orderId, dispatchId, bales[0].reference);
      const all = await loadFactoryDispatchReport({ companyId: w.companyId, orderId });
      expect(all).toMatchObject({ source: "LIVE", trip: null, closure: null, manifestAvailable: true });
      expect(all.loading).toMatchObject({
        orderId,
        companyName: w.tag,
        customerName: "Truck Customer",
        status: "LOADING",
      });
      expect(all.notices).toEqual([
        "Live verification report; its counts may change until the truck dispatch is ended.",
      ]);
      const trip = await loadFactoryDispatchReport({ companyId: w.companyId, orderId, dispatchId });
      expect(trip.trip).toMatchObject({ id: String(dispatchId), status: "OPEN", closedAt: null });
      expect(trip.scans.map((s) => s.baleReference)).toEqual([bales[0].reference]);
      expect(trip.audit.length).toBeGreaterThan(0);
      expect(trip.auditTruncated).toBe(false);
    }));

  it("builds the frozen closure report from the saved truck, loading and manifest", () =>
    withFactoryWorld(async (w) => {
      const { orderId, bales } = await loadingWithBales(w, ["10.00", "10.00"]);
      const dispatchId = await closedTrip(w, orderId, [bales[0].reference]);
      // Later edits to the loading do not leak into the signed report.
      await w.q(`UPDATE customer_orders SET container_number = 'EDITED-LATER' WHERE id = $1`, [orderId]);
      const report = await loadFactoryDispatchReport({ companyId: w.companyId, orderId, dispatchId });
      expect(report.source).toBe("CLOSURE");
      expect(report.closure).toMatchObject({ revision: 1, reopenedAt: null });
      expect(report.trip).toMatchObject({ status: "CLOSED", dispatchNumber: 1 });
      expect(report.loading.containerNumber).not.toBe("EDITED-LATER");
      expect(report.manifestAvailable).toBe(true);
      expect(report.scans.map((s) => [s.baleReference, s.dispatchId])).toEqual([
        [bales[0].reference, String(dispatchId)],
      ]);
      expect(report.notices).toEqual([]);
      const byId = await loadFactoryDispatchReport({
        companyId: w.companyId,
        orderId,
        dispatchId,
        closureId: Number(report.closure!.id),
      });
      expect(byId.closure!.id).toBe(report.closure!.id);
    }));

  it("discloses an older closure without saved truck metadata or manifest", () =>
    withFactoryWorld(async (w) => {
      const { orderId, bales } = await loadingWithBales(w, ["10.00"]);
      const dispatchId = await closedTrip(w, orderId, [bales[0].reference]);
      await w.q(`UPDATE customer_orders SET container_number = 'LIVE-NOW' WHERE id = $1`, [orderId]);
      await rewriteClosure(w, dispatchId, "legacy");
      const report = await loadFactoryDispatchReport({ companyId: w.companyId, orderId, dispatchId });
      expect(report.manifestAvailable).toBe(false);
      expect(report.scans).toEqual([]);
      expect(report.trip).toMatchObject({ status: "CLOSED", closedByUsername: report.closure!.closedByUsername });
      expect(report.loading.containerNumber).toBe("LIVE-NOW");
      expect(report.notices).toEqual([
        "This closure predates saved truck metadata. Current truck details may have changed.",
        "Bale-level historical manifest was not saved for this earlier closure. Its historical item comparison remains available.",
      ]);
    }));

  it("marks a closure that was later reopened", () =>
    withFactoryWorld(async (w) => {
      const { orderId, bales } = await loadingWithBales(w, ["10.00"]);
      const dispatchId = await closedTrip(w, orderId, [bales[0].reference]);
      await rewriteClosure(w, dispatchId, "reopened");
      const report = await loadFactoryDispatchReport({ companyId: w.companyId, orderId, dispatchId });
      expect(report.closure).toMatchObject({ reopenedByUsername: "supervisor", reopenReason: "Recount" });
      expect(report.notices).toContain(
        "Historical closure was later reopened. This report represents the earlier signed revision."
      );
    }));
});
