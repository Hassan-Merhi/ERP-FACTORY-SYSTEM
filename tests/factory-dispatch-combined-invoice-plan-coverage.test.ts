/**
 * The combined-invoice plan loader, called directly on a signed two-truck
 * loading inside one rolled-back transaction. Each tampered state (with the
 * protective triggers disabled only inside a savepoint) must surface as a
 * blocking reason or a refusal, never as a ready plan.
 */
import { describe, expect, it } from "vitest";

import { db } from "../server/db";
import {
  costText,
  loadCombinedInvoicePlanTx,
  moneyText,
  numberId,
} from "../server/routes/factory/customer-orders/loadCombinedInvoicePlanTx";
import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { dispatchBase, ledger, loadingWithBales, postedTrip } from "./helpers/dispatchFlowFixture";

const reason = "Supervisor reviewed every truck and its charges";
const reconBase = (orderId: number) => `${dispatchBase(orderId)}/order-reconciliation`;

async function signedOrder(w: FactoryWorld, beforeApproval?: (orderId: number) => Promise<void>) {
  const loading = await loadingWithBales(w, ["30.00", "20.00"]);
  await postedTrip(w, loading.orderId, [loading.bales[0].reference]);
  await postedTrip(w, loading.orderId, [loading.bales[1].reference]);
  if (beforeApproval) await beforeApproval(loading.orderId);
  const view = await w.agent.get(reconBase(loading.orderId));
  const approved = await w.agent
    .post(`${reconBase(loading.orderId)}/approve`)
    .send({ confirm: true, expectedFingerprint: view.body.fingerprint, reason });
  expect(approved.status).toBe(200);
  return loading;
}

const plan = (w: FactoryWorld, orderId: number) =>
  db.transaction((tx) =>
    loadCombinedInvoicePlanTx(tx, { companyId: w.companyId, orderId, userId: w.userId, username: w.username })
  );

/** Apply `tamper` with all triggers (and so foreign keys) off on `tables`, read the plan, then undo everything. */
async function tampered(w: FactoryWorld, orderId: number, tables: string[], tamper: () => Promise<unknown>) {
  await w.q(`SAVEPOINT tamper`);
  try {
    for (const table of tables) await w.q(`ALTER TABLE ${table} DISABLE TRIGGER ALL`);
    await tamper();
    for (const table of tables) await w.q(`ALTER TABLE ${table} ENABLE TRIGGER ALL`);
    return await plan(w, orderId).then(
      (loaded) => loaded.plan.blockingReasons.join(" | "),
      (error) => `refused:${error.code}`
    );
  } finally {
    await w.q(`ROLLBACK TO SAVEPOINT tamper`);
  }
}

describe("combined invoice plan helpers", () => {
  it("accepts canonical amounts, costs and IDs and refuses malformed ones", () => {
    expect(moneyText("12.5")).toBe("12.50");
    expect(moneyText(0)).toBe("0.00");
    for (const bad of ["-1", "01", "1.234", null, "abc"]) {
      expect(() => moneyText(bad)).toThrow(/invalid two-decimal amount/);
    }
    expect(costText("4.1234567").toFixed(7)).toBe("4.1234567");
    for (const bad of [null, "1.12345678", "-2"]) {
      expect(() => costText(bad)).toThrow(/invalid 7-decimal cost/);
    }
    expect(numberId("9")).toBe(9);
    for (const bad of [0, -3, "x", 1.5]) {
      expect(() => numberId(bad)).toThrow(/invalid record ID/);
    }
  });
});

describe("combined invoice plan", () => {
  it("is ready for a signed order and refuses an unsigned one", async () => {
    await withFactoryWorld(async (w) => {
      const { orderId } = await signedOrder(w, async (unsigned) => {
        await expect(plan(w, unsigned)).rejects.toMatchObject({ code: "COMBINED_INVOICE_RECONCILIATION_REQUIRED" });
      });
      const loaded = await plan(w, orderId);
      expect(loaded.plan).toMatchObject({
        ready: true,
        blockingReasons: [],
        tripCount: 2,
        goodsSubtotal: "50.00",
        finalInvoiceTotal: "50.00",
        physicalBales: 2,
        totalCost: "8.00",
        postCOGS: false,
      });
      expect(loaded.bales).toHaveLength(2);
    });
  });

  it("reports every drift between the signed consolidation and live evidence", async () => {
    await withFactoryWorld(async (w) => {
      const { orderId, bales } = await signedOrder(w);
      const consolidation = ["factory_dispatch_order_consolidations"];
      const set = (column: string, value: unknown) => () =>
        w.q(`UPDATE factory_dispatch_order_consolidations SET ${column} = $1 WHERE order_id = $2`, [value, orderId]);

      expect(await tampered(w, orderId, consolidation, set("reconciliation_fingerprint", "f".repeat(64)))).toMatch(
        /fingerprint no longer matches/
      );
      expect(await tampered(w, orderId, consolidation, set("included_posting_ids", '["999999"]'))).toMatch(
        /posting IDs no longer match/
      );
      expect(
        await tampered(w, orderId, consolidation, () =>
          w.q(
            `UPDATE factory_dispatch_order_consolidations
                SET goods_subtotal = goods_subtotal + 1, customer_total = customer_total + 1 WHERE order_id = $1`,
            [orderId]
          )
        )
      ).toMatch(/Signed goods changed.*Signed customer total changed/);
      expect(
        await tampered(w, orderId, consolidation, () =>
          w.q(`DELETE FROM factory_dispatch_order_consolidations WHERE order_id = $1`, [orderId])
        )
      ).toBe("refused:COMBINED_INVOICE_RECONCILIATION_REQUIRED");
      expect(
        await tampered(w, orderId, ["customer_orders"], () =>
          w.q(`UPDATE customer_orders SET invoice_number = 'INV-OLD' WHERE id = $1`, [orderId])
        )
      ).toMatch(/already invoiced/);
      expect(
        await tampered(w, orderId, ["factory_dispatch_trip_financial_bales"], () =>
          w.q(`UPDATE factory_dispatch_trip_financial_bales SET bale_id = $1 WHERE bale_id = $2`, [
            bales[0].baleId,
            bales[1].baleId,
          ])
        )
      ).toMatch(/same physical bale/);
      expect(
        await tampered(w, orderId, ["factory_dispatch_trip_financial_bales"], () =>
          w.q(`UPDATE factory_dispatch_trip_financial_bales SET line_total = 1 WHERE bale_id = $1`, [bales[0].baleId])
        )
      ).toMatch(/Frozen bale prices/);
    });
  });

  it("reports missing, sold and unpriced physical bales", async () => {
    await withFactoryWorld(async (w) => {
      const { orderId, bales } = await signedOrder(w);
      const other = await w.one(
        `INSERT INTO companies (code, name, company_type) VALUES ($1::varchar, $1::text, 'factory') RETURNING id`,
        [`${w.tag}O`]
      );
      const bale =
        (sql: string, ...params: unknown[]) =>
        () =>
          w.q(sql, [bales[0].baleId, ...params]);
      expect(
        await tampered(
          w,
          orderId,
          ["factory_bales"],
          bale(`UPDATE factory_bales SET company_id = $2 WHERE id = $1`, other)
        )
      ).toMatch(/missing from this Factory company/);
      expect(
        await tampered(w, orderId, ["factory_bales"], bale(`UPDATE factory_bales SET total_cost = -1 WHERE id = $1`))
      ).toMatch(/invalid or missing 7-decimal inventory cost/);
      expect(
        await tampered(w, orderId, ["factory_bales"], bale(`UPDATE factory_bales SET status = 'DELETED' WHERE id = $1`))
      ).toMatch(/already sold or deleted/);
    });
  });

  it("verifies original order charges before the final invoice", async () => {
    await withFactoryWorld(async (w) => {
      const { orderId, customerId } = await signedOrder(w);
      const income = await ledger(w, "INC", "Income");
      const expense = await ledger(w, "EXP", "Expense");
      const charge =
        (amount: string, account: number | null, voucher: number | null = null) =>
        () =>
          w.one(
            `INSERT INTO customer_order_charges (order_id, name, amount, ledger_account_id, voucher_id)
           VALUES ($1, 'Port fee', $2, $3, $4) RETURNING id`,
            [orderId, amount, account, voucher]
          );
      const charges = ["customer_order_charges"];
      expect(await tampered(w, orderId, charges, charge("5.00", null))).toBe(
        "refused:COMBINED_INVOICE_CHARGE_ACCOUNT_REQUIRED"
      );
      expect(await tampered(w, orderId, charges, charge("5.00", expense))).toBe(
        "refused:COMBINED_INVOICE_CHARGE_ACCOUNT_INVALID"
      );
      // A charge added after sign-off changes the live all-truck fingerprint.
      expect(await tampered(w, orderId, charges, charge("5.00", income))).toMatch(/fingerprint no longer matches/);

      const voucher = await w.one(
        `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount)
         VALUES ($1, $2, 'Journal', '2026-06-01', 3) RETURNING id`,
        [w.companyId, `${w.tag}PRE`]
      );
      await w.q(
        `INSERT INTO voucher_entries (voucher_id, ledger_account_id, customer_id, debit_amount, credit_amount)
         VALUES ($1, $2, $3, 3, 0), ($1, $2, NULL, 0, 3)`,
        [voucher, income, customerId]
      );
      expect(await tampered(w, orderId, charges, charge("5.00", income, voucher))).toBe(
        "refused:COMBINED_INVOICE_CHARGE_ALREADY_POSTED_DIFFERENT"
      );
      expect(
        await tampered(w, orderId, charges, async () => {
          const id = await charge("5.00", income)();
          await w.q(
            `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount)
             VALUES ($1, $2, 'Journal', '2026-06-01', 5)`,
            [w.companyId, `CHARGE-PRE-${orderId}-${id}`]
          );
        })
      ).toBe("refused:COMBINED_INVOICE_PRECHARGE_REVIEW");
      // A zero-amount charge needs no account: it is listed, not refused.
      expect(await tampered(w, orderId, charges, charge("0", null))).not.toMatch(/^refused:/);
    });
  });
});
