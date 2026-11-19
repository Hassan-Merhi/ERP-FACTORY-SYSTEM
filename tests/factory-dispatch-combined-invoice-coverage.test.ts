/**
 * Phase 8 combined invoice for a signed multi-truck loading, driven through
 * the real dispatch workflow in one rolled-back transaction per test.
 *
 * Pinned: the one invoice moves posted goods from clearing to sales without a
 * second receivable, posts unposted original charges exactly once, marks only
 * the shipped bales SOLD, replays idempotently, and refuses every unsafe state
 * before writing anything.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { closeBooks, dispatchBase, ledger, loadingWithBales, postedTrip } from "./helpers/dispatchFlowFixture";

const reason = "Supervisor reviewed every truck and its charges";
const invoiceBase = (orderId: number) => `${dispatchBase(orderId)}/combined-invoice`;
const reconBase = (orderId: number) => `${dispatchBase(orderId)}/order-reconciliation`;

/** Two posted trucks covering every loaded bale, signed by the supervisor. */
async function signedOrder(w: FactoryWorld, setup?: (orderId: number, customerId: number) => Promise<void>) {
  const loading = await loadingWithBales(w, ["30.00", "20.00"]);
  await postedTrip(w, loading.orderId, [loading.bales[0].reference]);
  await postedTrip(w, loading.orderId, [loading.bales[1].reference]);
  if (setup) await setup(loading.orderId, loading.customerId);
  const view = await w.agent.get(reconBase(loading.orderId));
  expect(view.body.ready).toBe(true);
  const approved = await w.agent
    .post(`${reconBase(loading.orderId)}/approve`)
    .send({ confirm: true, expectedFingerprint: view.body.fingerprint, reason });
  expect(approved.status).toBe(200);
  return { ...loading, fingerprint: view.body.fingerprint as string };
}

const finalizeBody = (fingerprint: string) => ({
  confirm: true,
  confirmNoDuplicateReceivable: true,
  confirmTripChargesReviewed: true,
  expectedFingerprint: fingerprint,
  reason,
});

const finalize = (w: FactoryWorld, orderId: number, body: unknown, agent = w.agent) =>
  agent.post(`${invoiceBase(orderId)}/finalize`).send(body as object);

const invoiceVouchers = (w: FactoryWorld) =>
  w.q(
    `SELECT voucher_number FROM vouchers WHERE company_id = $1 AND voucher_number LIKE 'FD%' AND voucher_number NOT LIKE 'FDTR-%' ORDER BY id`,
    [w.companyId]
  );

describe("combined dispatch invoice", () => {
  it("finalizes one invoice, consolidates the trips, sells the bales and replays idempotently", async () => {
    await withFactoryWorld(async (w) => {
      const income = await ledger(w, "FRT", "Income");
      const { orderId, bales, fingerprint } = await signedOrder(w, async (order) => {
        await w.q(
          `INSERT INTO customer_order_charges (order_id, name, charge_type, amount, ledger_account_id) VALUES ($1, 'Port fee', 'OTHER', 7.50, $2)`,
          [order, income]
        );
        await w.q(`INSERT INTO customer_order_charges (order_id, name, amount) VALUES ($1, 'Waived', 0)`, [order]);
      });
      await w.q(
        `INSERT INTO gl_inventory_cutovers (company_id, effective_from, status, opening_plan) VALUES ($1, '2000-01-01', 'ACTIVE', '{}')`,
        [w.companyId]
      );
      const preview = await w.agent.get(`${invoiceBase(orderId)}/preview`);
      expect(preview.status).toBe(200);
      expect(preview.body).toMatchObject({ finalized: false, ready: true, fingerprint });

      const res = await finalize(w, orderId, finalizeBody(fingerprint));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ goodsSubtotal: "50.00", tripCount: 2, replayed: false });
      expect(res.body.invoiceNumber).toMatch(/^INV-\d{6}$/);
      const [portFee] = await w.q(`SELECT id FROM customer_order_charges WHERE order_id = $1 AND amount > 0`, [
        orderId,
      ]);
      const numbers = (await invoiceVouchers(w)).map((v) => v.voucher_number);
      expect(numbers.sort()).toEqual(
        [
          `FDINV-${w.companyId}-${orderId}-CLEARING`,
          `FDINV-${w.companyId}-${orderId}-COGS`,
          `FDOC-${w.companyId}-${orderId}-${portFee.id}`,
        ].sort()
      );
      const [order] = await w.q(
        `SELECT status, invoice_number, grand_total::text AS total FROM customer_orders WHERE id = $1`,
        [orderId]
      );
      expect(order).toMatchObject({ status: "FINALIZED", invoice_number: res.body.invoiceNumber });
      const sold = await w.q(`SELECT status FROM factory_bales WHERE id = ANY($1)`, [bales.map((b) => b.baleId)]);
      expect(sold.every((b) => b.status === "SOLD")).toBe(true);
      const trips = await w.q(`SELECT status FROM factory_dispatch_trip_financials WHERE order_id = $1`, [orderId]);
      expect(trips.every((t) => t.status === "CONSOLIDATED")).toBe(true);
      const lines = await w.q(
        `SELECT article_code, qty, total_price::text AS total FROM customer_order_lines WHERE order_id = $1 ORDER BY total`,
        [orderId]
      );
      expect(lines).toEqual([
        { article_code: "ART-A", qty: 1, total: "20.00" },
        { article_code: "ART-A", qty: 1, total: "30.00" },
      ]);
      const [charge] = await w.q(`SELECT voucher_id FROM customer_order_charges WHERE order_id = $1 AND amount > 0`, [
        orderId,
      ]);
      expect(charge.voucher_id).not.toBeNull();

      const replay = await finalize(w, orderId, finalizeBody(fingerprint));
      expect(replay.status).toBe(200);
      expect(replay.body).toMatchObject({ replayed: true, invoiceNumber: res.body.invoiceNumber, tripCount: 2 });
      const finalPreview = await w.agent.get(`${invoiceBase(orderId)}/preview`);
      expect(finalPreview.body).toMatchObject({ finalized: true, orderConsistent: true });
      const recon = await w.agent.get(reconBase(orderId));
      expect(recon.body).toMatchObject({ approvalCurrent: true, blockingReasons: [], fingerprint });
      const conflict = await finalize(w, orderId, finalizeBody("1".repeat(64)));
      expect(conflict.status).toBe(409);
      expect(conflict.body.code).toBe("COMBINED_INVOICE_REPLAY_CONFLICT");
    });
  });

  it("keeps an already posted original charge voucher and groups equal bales on a proforma loading", async () => {
    await withFactoryWorld(async (w) => {
      const income = await ledger(w, "PORT", "Income");
      const loading = await loadingWithBales(w, ["25.00", "25.00"]);
      const proformaId = await w.one(
        `INSERT INTO customer_proformas (company_id, customer_id, name, is_active) VALUES ($1, $2, 'PF', true) RETURNING id`,
        [w.companyId, loading.customerId]
      );
      await w.q(`UPDATE customer_orders SET proforma_id_used = $1 WHERE id = $2`, [proformaId, loading.orderId]);
      await postedTrip(
        w,
        loading.orderId,
        loading.bales.map((b) => b.reference)
      );
      // A pre-invoice charge voucher already debited the customer once.
      const [receivable] = await w.q(`SELECT ledger_account_id FROM voucher_entries WHERE customer_id = $1 LIMIT 1`, [
        loading.customerId,
      ]);
      const voucherId = await w.one(
        `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount)
         VALUES ($1, $2, 'Journal', '2026-06-01', 6) RETURNING id`,
        [w.companyId, `${w.tag}PRE`]
      );
      await w.q(
        `INSERT INTO voucher_entries (voucher_id, ledger_account_id, customer_id, debit_amount, credit_amount)
         VALUES ($1, $2, $3, 6, 0), ($1, $4, NULL, 0, 6)`,
        [voucherId, receivable.ledger_account_id, loading.customerId, income]
      );
      await w.q(
        `INSERT INTO customer_order_charges (order_id, name, amount, ledger_account_id, voucher_id) VALUES ($1, 'Port fee', 6, $2, $3)`,
        [loading.orderId, income, voucherId]
      );
      const view = await w.agent.get(reconBase(loading.orderId));
      await w.agent
        .post(`${reconBase(loading.orderId)}/approve`)
        .send({ confirm: true, expectedFingerprint: view.body.fingerprint, reason });
      const res = await finalize(w, loading.orderId, finalizeBody(view.body.fingerprint));
      expect(res.status).toBe(200);
      expect(res.body.voucherIds).toContain(voucherId);
      expect(res.body.tripCount).toBe(1);
      // Without an inventory cut-over no COGS voucher is posted.
      const numbers = (await invoiceVouchers(w)).map((v) => v.voucher_number);
      expect(numbers).toEqual([`FDINV-${w.companyId}-${loading.orderId}-CLEARING`]);
      const lines = await w.q(`SELECT qty, total_price::text AS total FROM customer_order_lines WHERE order_id = $1`, [
        loading.orderId,
      ]);
      expect(lines).toEqual([{ qty: 2, total: "50.00" }]);
    });
  });

  it("refuses missing confirmations, non-supervisors, unsigned or stale orders", async () => {
    await withFactoryWorld(async (w) => {
      const loading = await loadingWithBales(w, ["30.00"]);
      await postedTrip(w, loading.orderId, [loading.bales[0].reference]);
      const fp = (await w.agent.get(reconBase(loading.orderId))).body.fingerprint;
      for (const bad of [
        [],
        { ...finalizeBody(fp), confirmNoDuplicateReceivable: false },
        { ...finalizeBody(fp), reason: "short" },
      ]) {
        const res = await finalize(w, loading.orderId, bad);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe("COMBINED_INVOICE_CONFIRMATION_REQUIRED");
      }
      const manager = await w.agentFor("Manager");
      const denied = await finalize(w, loading.orderId, finalizeBody(fp), manager);
      expect(denied.status).toBe(403);
      expect(denied.body.code).toBe("COMBINED_INVOICE_SUPERVISOR_ONLY");
      const unsigned = await finalize(w, loading.orderId, finalizeBody(fp));
      expect(unsigned.status).toBe(409);
      expect(unsigned.body.code).toBe("COMBINED_INVOICE_RECONCILIATION_CHANGED");
      expect(
        (await w.agent.get(`/api/factory/customer-orders/x/loading-dispatches/combined-invoice/preview`)).status
      ).toBe(400);
      const missing = await finalize(w, 999999999, finalizeBody(fp));
      expect(missing.status).toBe(404);
      expect(await invoiceVouchers(w)).toHaveLength(0);
    });
  });

  it("refuses a loading already billed elsewhere, sold bales and a closed period", async () => {
    await withFactoryWorld(async (w) => {
      const { orderId, customerId, bales, fingerprint } = await signedOrder(w);
      const body = finalizeBody(fingerprint);
      await w.q(`SAVEPOINT billed`);
      await w.q(
        `INSERT INTO customer_balances (company_id, customer_id, transaction_type, reference_type, reference_id, amount, balance, transaction_date)
         VALUES ($1, $2, 'SALE', 'INVOICE', $3, 50, 50, '2026-06-02')`,
        [w.companyId, customerId, orderId]
      );
      expect((await finalize(w, orderId, body)).body.code).toBe("COMBINED_INVOICE_ALREADY_BILLED");
      await w.q(`ROLLBACK TO SAVEPOINT billed`);

      await w.q(`SAVEPOINT sold`);
      await w.q(`UPDATE factory_bales SET status = 'SOLD' WHERE id = $1`, [bales[0].baleId]);
      const sold = await finalize(w, orderId, body);
      expect(sold.body.code).toBe("COMBINED_INVOICE_BLOCKED");
      expect(sold.body.message).toMatch(/already sold or deleted/);
      await w.q(`ROLLBACK TO SAVEPOINT sold`);

      await closeBooks(w, "2100-12-31");
      const closed = await finalize(w, orderId, body);
      expect(closed.status).toBe(409);
      expect(closed.body.code).toBe("ACCOUNTING_PERIOD_CLOSED");
      const [order] = await w.q(`SELECT status, invoice_number FROM customer_orders WHERE id = $1`, [orderId]);
      expect(order).toEqual({ status: "LOADING", invoice_number: null });
      expect(await invoiceVouchers(w)).toHaveLength(0);
    });
  });

  it("refuses an inactive order, a duplicate original charge voucher and a missing safeguard", async () => {
    await withFactoryWorld(async (w) => {
      const { orderId, fingerprint } = await signedOrder(w);
      await w.q(`SAVEPOINT guard`);
      await w.q(`ALTER TABLE vouchers DISABLE TRIGGER factory_dispatch_final_voucher_guard`);
      const guard = await finalize(w, orderId, finalizeBody(fingerprint));
      expect(guard.status).toBe(503);
      expect(guard.body.missing).toContain("trigger:factory_dispatch_final_voucher_guard");
      const preview = await w.agent.get(`${invoiceBase(orderId)}/preview`);
      expect(preview.status).toBe(503);
      await w.q(`ROLLBACK TO SAVEPOINT guard`);

      await w.q(`SAVEPOINT deleted`);
      await w.q(`ALTER TABLE customer_orders DISABLE TRIGGER USER`);
      await w.q(`UPDATE customer_orders SET deleted_at = now() WHERE id = $1`, [orderId]);
      await w.q(`ALTER TABLE customer_orders ENABLE TRIGGER USER`);
      const inactive = await finalize(w, orderId, finalizeBody(fingerprint));
      expect(inactive.body.code).toBe("COMBINED_INVOICE_ORDER_INACTIVE");
      await w.q(`ROLLBACK TO SAVEPOINT deleted`);

      const stale = await finalize(w, orderId, finalizeBody("2".repeat(64)));
      expect(stale.body.code).toBe("COMBINED_INVOICE_RECONCILIATION_CHANGED");
      expect(await invoiceVouchers(w)).toHaveLength(0);
    });
  });
});
