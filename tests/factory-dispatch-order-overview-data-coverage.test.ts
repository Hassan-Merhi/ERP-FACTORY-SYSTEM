import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import {
  addCharge,
  closedTrip,
  createTrip,
  dispatchBase,
  finalizeTrip,
  financialPreview,
  ledger,
  loadingWithBales,
  postedTrip,
  scan,
} from "./helpers/dispatchFlowFixture";

const overviewUrl = (orderId: number) => `${dispatchBase(orderId)}/order-overview`;

async function overview(w: FactoryWorld, orderId: number) {
  const res = await w.agent.get(overviewUrl(orderId));
  expect(res.status, res.text).toBe(200);
  return res.body;
}

/** Posted trip with billable freight and an internal haulage expense. */
async function postedTripWithCharges(w: FactoryWorld, orderId: number, references: string[]) {
  const dispatchId = await closedTrip(w, orderId, references);
  const income = await ledger(w, "FRT", "Income");
  const expense = await ledger(w, "HAUL", "Expense");
  const payable = await ledger(w, "PAY", "Liability");
  for (const charge of [
    { name: "Freight", kind: "BILLABLE", amount: "20.00", ledgerAccountId: income },
    { name: "Haulage", kind: "INTERNAL", amount: "12.50", ledgerAccountId: expense, offsetLedgerAccountId: payable },
  ]) {
    expect((await addCharge(w, orderId, dispatchId, charge)).status).toBe(201);
  }
  const preview = await financialPreview(w, orderId, dispatchId);
  const res = await finalizeTrip(w, orderId, dispatchId, {
    confirm: true,
    sourceFingerprint: preview.source!.sourceFingerprint,
    chargeFingerprint: preview.chargeFingerprint,
  });
  expect(res.status).toBe(200);
  return { dispatchId, income };
}

async function consolidate(
  w: FactoryWorld,
  orderId: number,
  values: { status: "DRAFT" | "FINALIZED"; invoiceNumber?: string; finalInvoiceTotal?: string; postingId: string }
) {
  const finalized = values.status === "FINALIZED";
  const details = finalized
    ? {
        invoiceNumber: values.invoiceNumber,
        customerReceivableReposted: false,
        voucherIds: [901],
        includedPostingIds: [values.postingId],
        ...(values.finalInvoiceTotal ? { finalInvoiceTotal: values.finalInvoiceTotal } : {}),
      }
    : null;
  await w.q(
    `INSERT INTO factory_dispatch_order_consolidations
       (company_id, order_id, status, invoice_number, included_posting_ids, goods_subtotal, billable_charges_total,
        discount_total, customer_total, reconciled_at, reconciled_by_user_id, reconciliation_reason,
        reconciliation_fingerprint, reconciliation_snapshot, finalized_at, finalized_by_user_id, finalization_details)
     VALUES ($1, $2, $3, $4, $5::jsonb, 0, 0, 0, 0, NOW(), $6, 'Reconciled all truck postings',
             $7, '{}'::jsonb, $8, $9, $10::jsonb)`,
    [
      w.companyId,
      orderId,
      values.status,
      values.invoiceNumber ?? null,
      JSON.stringify([values.postingId]),
      w.userId,
      "a".repeat(64),
      finalized ? new Date().toISOString() : null,
      finalized ? w.userId : null,
      JSON.stringify(details ?? {}),
    ]
  );
}

describe("dispatch order overview data", () => {
  it("returns 404 for an order outside the company and physical progress for an open trip", async () => {
    await withFactoryWorld(async (w) => {
      const missing = await w.agent.get(overviewUrl(2_000_000_000));
      expect(missing.status).toBe(404);
      expect(missing.body.code).toBe("FACTORY_ORDER_NOT_FOUND");

      const { orderId, bales } = await loadingWithBales(w, ["100.00", "50.00", "25.00"]);
      const dispatchId = await createTrip(w, orderId);
      await scan(w, orderId, dispatchId, bales[0].reference);
      const body = await overview(w, orderId);
      expect(body.schemaReady).toBe(true);
      expect(body.order).toMatchObject({
        id: orderId,
        status: "LOADING",
        customerName: "Truck Customer",
        deleted: false,
      });
      expect(body.summary).toMatchObject({
        tripCount: 1,
        openTrips: 1,
        closedTrips: 0,
        originalLoadingBales: 3,
        scannedBales: 1,
        uniqueScannedBales: 1,
        unshippedBales: 2,
        unexpectedScannedBales: 0,
        goodsSubtotal: "0.00",
        tripCustomerTotal: "0.00",
        originalOrderCharges: "0.00",
        invoiceTotal: null,
        signed: false,
        finalized: false,
      });
      expect(body.trips).toEqual([
        expect.objectContaining({
          id: String(dispatchId),
          financialStatus: "UNPOSTED",
          scannedBales: 1,
          postingId: null,
        }),
      ]);
      expect(body.invoice).toBeNull();
    });
  });

  it("reports posted trip totals, trip and order charges, exported PO files and a signed draft invoice", async () => {
    await withFactoryWorld(async (w) => {
      const { orderId, bales } = await loadingWithBales(w, ["100.00", "50.00"]);
      const { dispatchId, income } = await postedTripWithCharges(w, orderId, [bales[0].reference]);
      const [financial] = await w.q(`SELECT id FROM factory_dispatch_trip_financials WHERE dispatch_id = $1`, [
        dispatchId,
      ]);
      await w.q(
        `INSERT INTO factory_dispatch_trip_exports
           (company_id, order_id, dispatch_id, financial_id, snapshot_revision, source_fingerprint, export_fingerprint,
            po_number, erp_container_number, supplier_code, exported_by_user_id, exported_at)
         VALUES ($1, $2, $3, $4, 1, 'src', 'exp', 'PO-77', 'CONT-9', 'SUP-1', $5, NOW())`,
        [w.companyId, orderId, dispatchId, financial.id, w.userId]
      );
      await w.q(
        `INSERT INTO customer_order_charges (order_id, name, amount, ledger_account_id) VALUES ($1, 'Documents', 15, $2)`,
        [orderId, income]
      );
      const [posting] = await w.q(
        `SELECT id FROM factory_dispatch_trip_postings WHERE dispatch_id = $1 AND kind = 'POST'`,
        [dispatchId]
      );
      await consolidate(w, orderId, { status: "DRAFT", postingId: String(posting.id) });

      const body = await overview(w, orderId);
      expect(body.summary).toMatchObject({
        closedTrips: 1,
        goodsSubtotal: "100.00",
        billableCharges: "20.00",
        discounts: "0.00",
        tripCustomerTotal: "120.00",
        originalOrderCharges: "15.00",
        internalExpenses: "12.50",
        generatedPoFiles: 1,
        signed: true,
        finalized: false,
        unshippedBales: 1,
      });
      expect(body.trips[0]).toMatchObject({
        financialStatus: "POSTED",
        postingId: String(posting.id),
        poNumber: "PO-77",
        erpContainerNumber: "CONT-9",
        supplierCode: "SUP-1",
        erpImportStatus: "NOT_TRACKED_MANUAL",
        customerTotal: "120.00",
      });
      expect(
        body.charges.map((c: { name: string; kind: string; status: string }) => [c.name, c.kind, c.status])
      ).toEqual([
        ["Freight", "BILLABLE", "POSTED"],
        ["Haulage", "INTERNAL", "POSTED"],
        ["Documents", "ORDER", "UNLINKED"],
      ]);
      expect(body.invoice).toMatchObject({
        status: "DRAFT",
        includedPostingIds: [String(posting.id)],
        finalizationVoucherIds: [],
      });
      expect(body.notices.join(" ")).toMatch(/does NOT confirm manual import/);
      expect(body.notices.join(" ")).toMatch(
        /signed, but the one combined customer invoice has not yet been finalized/
      );
    });
  });

  it("flags a finalized invoice whose identity or signed total does not reconcile", async () => {
    await withFactoryWorld(async (w) => {
      const { orderId, bales } = await loadingWithBales(w, ["100.00"]);
      const { dispatchId, posting } = await postedTrip(w, orderId, [bales[0].reference]);
      expect(posting.status).toBe("POSTED");
      const [row] = await w.q(
        `SELECT id FROM factory_dispatch_trip_postings WHERE dispatch_id = $1 AND kind = 'POST'`,
        [dispatchId]
      );
      await consolidate(w, orderId, {
        status: "FINALIZED",
        invoiceNumber: "INV-1",
        finalInvoiceTotal: "999.00",
        postingId: String(row.id),
      });
      const body = await overview(w, orderId);
      expect(body.summary).toMatchObject({ finalized: true, invoiceConsistent: false, invoiceTotal: "999.00" });
      expect(body.invoice).toMatchObject({
        status: "FINALIZED",
        invoiceNumber: "INV-1",
        finalizationVoucherIds: ["901"],
      });
      const notices = body.notices.join(" ");
      expect(notices).toMatch(/does not match the original order's invoice identity/);
      expect(notices).toMatch(/does not match currently reported posted trip totals/);
      expect(notices).toMatch(/must not debit that receivable twice/);
    });
  });

  it("flags a finalized invoice that lost its signed total", async () => {
    await withFactoryWorld(async (w) => {
      const { orderId, bales } = await loadingWithBales(w, ["100.00"]);
      const { dispatchId } = await postedTrip(w, orderId, [bales[0].reference]);
      const [row] = await w.q(
        `SELECT id FROM factory_dispatch_trip_postings WHERE dispatch_id = $1 AND kind = 'POST'`,
        [dispatchId]
      );
      await consolidate(w, orderId, { status: "FINALIZED", invoiceNumber: "INV-2", postingId: String(row.id) });
      const body = await overview(w, orderId);
      expect(body.summary.invoiceTotal).toBeNull();
      expect(body.notices.join(" ")).toMatch(/missing its signed total snapshot/);
    });
  });

  it("reports a finalized invoice that reconciles with the order and posted trips", async () => {
    await withFactoryWorld(async (w) => {
      const { orderId, bales } = await loadingWithBales(w, ["100.00"]);
      const { dispatchId } = await postedTrip(w, orderId, [bales[0].reference]);
      const [row] = await w.q(
        `SELECT id FROM factory_dispatch_trip_postings WHERE dispatch_id = $1 AND kind = 'POST'`,
        [dispatchId]
      );
      await w.q(`UPDATE customer_orders SET status = 'FINALIZED', invoice_number = 'INV-3' WHERE id = $1`, [orderId]);
      await consolidate(w, orderId, {
        status: "FINALIZED",
        invoiceNumber: "INV-3",
        finalInvoiceTotal: "100.00",
        postingId: String(row.id),
      });
      const body = await overview(w, orderId);
      expect(body.summary).toMatchObject({
        invoiceConsistent: true,
        invoiceTotal: "100.00",
        tripCustomerTotal: "100.00",
      });
      expect(body.notices.join(" ")).not.toMatch(/does not match/);
    });
  });

  it("is limited to Admin, Owner and Developer", async () => {
    await withFactoryWorld(async (w) => {
      const { orderId } = await loadingWithBales(w, ["10.00"]);
      const manager = await w.agentFor("Manager");
      expect((await manager.get(overviewUrl(orderId))).status).toBe(403);
    });
  });
});
