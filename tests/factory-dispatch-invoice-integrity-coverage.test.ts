/**
 * Phase 10 read-only dispatch invoice integrity audit
 * (server/services/factory/dispatchInvoiceIntegrity.ts), driven through the
 * real dispatch workflow inside one rolled-back transaction per test.
 *
 * Pinned: an unknown loading is refused, an unfinalized loading only reports
 * INFO, a clean combined invoice passes every check, and each damaged piece of
 * evidence turns its check into a BLOCK without the audit writing anything.
 */
import { describe, expect, it } from "vitest";

import { db } from "../server/db";
import { auditFactoryDispatchInvoiceTx } from "../server/services/factory/dispatchInvoiceIntegrity";
import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { dispatchBase, ledger, loadingWithBales, postedTrip } from "./helpers/dispatchFlowFixture";

const reason = "Supervisor reviewed every truck and its charges";
const reconBase = (orderId: number) => `${dispatchBase(orderId)}/order-reconciliation`;

const audit = (w: FactoryWorld, orderId: number) =>
  db.transaction((tx) => auditFactoryDispatchInvoiceTx(tx, w.companyId, orderId));

const states = (report: Awaited<ReturnType<typeof audit>>) =>
  Object.fromEntries(report.checks.map((c) => [c.code, c.state]));

async function signedOrder(w: FactoryWorld, setup?: (orderId: number) => Promise<void>) {
  const loading = await loadingWithBales(w, ["30.00", "20.00"]);
  await postedTrip(w, loading.orderId, [loading.bales[0].reference]);
  await postedTrip(w, loading.orderId, [loading.bales[1].reference]);
  if (setup) await setup(loading.orderId);
  const view = await w.agent.get(reconBase(loading.orderId));
  expect(view.body.ready).toBe(true);
  const approved = await w.agent
    .post(`${reconBase(loading.orderId)}/approve`)
    .send({ confirm: true, expectedFingerprint: view.body.fingerprint, reason });
  expect(approved.status).toBe(200);
  return { ...loading, fingerprint: view.body.fingerprint as string };
}

async function finalizedOrder(w: FactoryWorld, withCutover: boolean) {
  const income = await ledger(w, "FRT", "Income");
  const order = await signedOrder(w, async (orderId) => {
    await w.q(
      `INSERT INTO customer_order_charges (order_id, name, charge_type, amount, ledger_account_id) VALUES ($1, 'Port fee', 'OTHER', 7.50, $2)`,
      [orderId, income]
    );
  });
  if (withCutover) {
    await w.q(
      `INSERT INTO gl_inventory_cutovers (company_id, effective_from, status, opening_plan) VALUES ($1, '2000-01-01', 'ACTIVE', '{}')`,
      [w.companyId]
    );
  }
  const res = await w.agent.post(`${dispatchBase(order.orderId)}/combined-invoice/finalize`).send({
    confirm: true,
    confirmNoDuplicateReceivable: true,
    confirmTripChargesReviewed: true,
    expectedFingerprint: order.fingerprint,
    reason,
  });
  expect(res.status).toBe(200);
  return order;
}

/** Bypass the immutable-invoice guards for this rolled-back transaction only. */
const unguarded = (w: FactoryWorld) => w.q(`SET LOCAL session_replication_role = replica`);

const voucherCount = async (w: FactoryWorld) =>
  Number((await w.q(`SELECT COUNT(*)::int AS n FROM vouchers WHERE company_id = $1`, [w.companyId]))[0].n);

describe("dispatch invoice integrity audit", () => {
  it("refuses an order from another company or an unknown id", async () => {
    await withFactoryWorld(async (w) => {
      await expect(audit(w, 2_000_000_000)).rejects.toThrow("LOADING_NOT_FOUND");
      const { orderId } = await loadingWithBales(w, ["10.00"]);
      await expect(db.transaction((tx) => auditFactoryDispatchInvoiceTx(tx, w.companyId + 1, orderId))).rejects.toThrow(
        "LOADING_NOT_FOUND"
      );
    });
  });

  it("reports an unsigned, unfinalized loading as INFO only", async () => {
    await withFactoryWorld(async (w) => {
      const loading = await loadingWithBales(w, ["30.00"]);
      await postedTrip(w, loading.orderId, [loading.bales[0].reference]);
      const before = await voucherCount(w);
      const report = await audit(w, loading.orderId);
      expect(report).toMatchObject({ finalized: false, signedReconciliation: false, expectedInvoiceTotal: null });
      expect(states(report)).toMatchObject({ NOT_FINALIZED: "INFO", NO_DUPLICATE_LEGACY_INVOICE: "PASS" });
      expect(states(report).SIGNED_BALES_UNIQUE).toBe("PASS");
      expect(await voucherCount(w)).toBe(before);
    });
  });

  it("blocks a legacy full-invoice journal on a signed order", async () => {
    await withFactoryWorld(async (w) => {
      const { orderId } = await signedOrder(w);
      await w.q(
        `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount)
         VALUES ($1, $2, 'Journal', '2026-06-01', 0)`,
        [w.companyId, `INV-GL-${w.companyId}-${orderId}`]
      );
      const report = await audit(w, orderId);
      expect(report.signedReconciliation).toBe(true);
      expect(report.passed).toBe(false);
      const legacy = report.checks.find((c) => c.code === "NO_DUPLICATE_LEGACY_INVOICE");
      expect(legacy).toMatchObject({ state: "BLOCK", observed: "0 cache rows, 1 journals" });
    });
  });

  it("passes every check on a clean finalized invoice with a cost journal", async () => {
    await withFactoryWorld(async (w) => {
      const { orderId } = await finalizedOrder(w, true);
      const before = await voucherCount(w);
      const report = await audit(w, orderId);
      const blocked = report.checks.filter((c) => c.state === "BLOCK");
      expect(blocked).toEqual([]);
      expect(report).toMatchObject({ finalized: true, signedReconciliation: true, passed: true });
      expect(report.expectedInvoiceTotal).toBe("57.50");
      expect(states(report)).toMatchObject({
        ONE_FINAL_INVOICE_IDENTITY: "PASS",
        FINAL_INVOICE_TOTAL: "PASS",
        NO_SECOND_TRIP_CUSTOMER_DEBIT: "PASS",
        FINAL_INVOICE_TRIP_STATES: "PASS",
        SIGNED_BALES_SOLD_ONCE: "PASS",
        GOODS_CLEARING_TO_SALES: "PASS",
        INVENTORY_COGS_JOURNAL: "PASS",
        ORIGINAL_ORDER_CHARGES_LINKED: "PASS",
        FINAL_VOUCHERS_ACTIVE: "PASS",
      });
      expect(await voucherCount(w)).toBe(before);

      const route = await w.agent.get(`${dispatchBase(orderId)}/release-readiness`);
      expect(route.status).toBe(200);
      expect(route.body).toMatchObject({ orderId, readOnly: true });
    });
  });

  it("passes without a cost journal when no perpetual cutover is active", async () => {
    await withFactoryWorld(async (w) => {
      const { orderId } = await finalizedOrder(w, false);
      const report = await audit(w, orderId);
      const cogs = report.checks.find((c) => c.code === "INVENTORY_COGS_JOURNAL");
      expect(cogs).toMatchObject({ state: "PASS", expected: "No cost journal" });
    });
  });

  it("blocks every final-invoice check once the evidence is damaged", async () => {
    await withFactoryWorld(async (w) => {
      const { orderId, bales } = await finalizedOrder(w, true);
      await unguarded(w);
      await w.q(`UPDATE customer_orders SET invoice_number = 'INV-OTHER', grand_total = 1 WHERE id = $1`, [orderId]);
      await w.q(
        `UPDATE factory_dispatch_order_consolidations
            SET finalization_details = finalization_details
              || jsonb_build_object('shippedBales', 99, 'voucherIds', jsonb_build_array('abc'))
          WHERE order_id = $1`,
        [orderId]
      );
      await w.q(`UPDATE factory_bales SET status = 'IN_STOCK' WHERE id = $1`, [bales[0].baleId]);
      await w.q(
        `UPDATE factory_dispatch_trip_financials SET status = 'POSTED'
          WHERE id = (SELECT MIN(id) FROM factory_dispatch_trip_financials WHERE order_id = $1)`,
        [orderId]
      );
      await w.q(`UPDATE vouchers SET deleted_at = NOW() WHERE company_id = $1 AND voucher_number IN ($2, $3)`, [
        w.companyId,
        `FDINV-${w.companyId}-${orderId}-CLEARING`,
        `FDINV-${w.companyId}-${orderId}-COGS`,
      ]);
      await w.q(`UPDATE customer_order_charges SET voucher_id = NULL WHERE order_id = $1 AND amount > 0`, [orderId]);

      const report = await audit(w, orderId);
      expect(report.passed).toBe(false);
      expect(states(report)).toMatchObject({
        ONE_FINAL_INVOICE_IDENTITY: "BLOCK",
        FINAL_INVOICE_TOTAL: "BLOCK",
        // A table CHECK keeps customerReceivableReposted = false on every finalized row.
        NO_SECOND_TRIP_CUSTOMER_DEBIT: "PASS",
        FINAL_INVOICE_TRIP_STATES: "BLOCK",
        SIGNED_BALES_SOLD_ONCE: "BLOCK",
        GOODS_CLEARING_TO_SALES: "BLOCK",
        INVENTORY_COGS_JOURNAL: "BLOCK",
        ORIGINAL_ORDER_CHARGES_LINKED: "BLOCK",
        FINAL_VOUCHERS_ACTIVE: "BLOCK",
      });
    });
  });

  it("blocks a final voucher list that names a deleted voucher twice", async () => {
    await withFactoryWorld(async (w) => {
      const { orderId } = await finalizedOrder(w, false);
      await unguarded(w);
      await w.q(
        `UPDATE factory_dispatch_order_consolidations
            SET finalization_details = (finalization_details - 'voucherIds')
              || jsonb_build_object('voucherIds', jsonb_build_array('1', '1'))
          WHERE order_id = $1`,
        [orderId]
      );
      const report = await audit(w, orderId);
      expect(report.checks.find((c) => c.code === "FINAL_VOUCHERS_ACTIVE")).toMatchObject({
        state: "BLOCK",
        expected: "2",
        observed: "0",
      });
    });
  });
});
