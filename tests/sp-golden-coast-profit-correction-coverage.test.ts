/**
 * Golden Coast developer profit corrections and the retired legacy profit
 * split (spGoldenCoastPhase11MonthlyCloseRoutes.ts) through the real HTTP app
 * in one rolled-back transaction per test. Pins the Developer-only guard, the
 * supplier-partner and Golden Coast scope, request validation, the missing
 * account refusal, the closed-month lock, the suspense account created for a
 * non-zero correction and the correction history - nothing is written on
 * refusal.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const URL = "/api/sp/golden-coast/profit-correction";
const MONTH = "2026-04";

async function account(w: FactoryWorld, code: string, type: string, subType: string) {
  return w.one(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type, sub_type) VALUES ($1, $2::varchar, $2::text, $3, $4)
     RETURNING id`,
    [w.companyId, `${w.tag}${code}`, type, subType]
  );
}

/** Supplier-partner company; Golden Coast capital roles; then the Phase 11 P&L roles. */
async function configure(w: FactoryWorld, opts: { goldenCoast?: boolean; pnl?: boolean } = {}) {
  await w.q(`UPDATE companies SET company_type = 'supplier_partner' WHERE id = $1`, [w.companyId]);
  if (opts.goldenCoast !== false) {
    await account(w, "PCAP", "Equity", "gc_partner_capital");
    await account(w, "OCAP", "Equity", "gc_owner_capital");
  }
  if (opts.pnl !== false) {
    await account(w, "SAL", "Income", "sp_sales");
    await account(w, "COG", "Expense", "sp_cogs");
    await account(w, "PPD", "Equity", "gc_profit_pending_distribution");
    // One April sale (revenue 300, cost 100) gives the month closeable activity.
    const itemId = await w.one(
      `INSERT INTO stock_items (company_id, code, name, uom) VALUES ($1, $2, 'Bales', 'kg') RETURNING id`,
      [w.companyId, `${w.tag}SI`]
    );
    const voucherId = await w.one(
      `INSERT INTO vouchers (company_id, voucher_type, voucher_number, voucher_date, total_amount)
       VALUES ($1, 'Sales', $2, '2026-04-10', 300) RETURNING id`,
      [w.companyId, `${w.tag}S1`]
    );
    await w.q(
      `INSERT INTO sales_items (voucher_id, stock_item_id, quantity, selling_price, cost_price, total_sales, total_cost, profit)
       VALUES ($1, $2, 1, 300, 100, 300, 100, 200)`,
      [voucherId, itemId]
    );
  }
}

const corrections = (w: FactoryWorld) =>
  w.q(
    `SELECT target_net_profit::text AS target, reason FROM sp_profit_manual_corrections WHERE company_id = $1 ORDER BY id`,
    [w.companyId]
  );

const body = (extra: Record<string, unknown> = {}) => ({
  periodMonth: MONTH,
  targetNetProfit: "150.50",
  reason: "Agreed with partner",
  confirmation: "ADJUST SP PROFIT",
  ...extra,
});

/** Developer identity is fixed at login, so sign in a Developer and route the world's requests through it. */
async function asDeveloper(w: FactoryWorld) {
  w.agent = await w.agentFor("Developer");
}

let keySeq = 0;
/** POST through the SP sensitive-action gate (exact confirmation, reason, fresh idempotency key). */
const post = (w: FactoryWorld, path: string, payload: object) =>
  w.agent.post(path).set("Idempotency-Key", `${w.tag}-pc-${++keySeq}`).send(payload);
const correct = (w: FactoryWorld, extra: Record<string, unknown> = {}) => post(w, URL, body(extra));
const legacySplit = (w: FactoryWorld) =>
  post(w, "/api/sp/profit-splits", {
    periodMonth: MONTH,
    confirmation: "FINALIZE SP PROFIT SPLIT",
    reason: "Monthly split close",
  });

describe("Golden Coast profit correction guards", () => {
  it("is Developer-only and requires a Golden Coast supplier-partner company", async () => {
    await withFactoryWorld(async (w) => {
      expect((await w.agent.get(URL).query({ periodMonth: MONTH })).body.message).toBe(
        "Not a supplier_partner company"
      );
      await configure(w, { goldenCoast: false, pnl: false });
      const denied = await w.agent.get(URL).query({ periodMonth: MONTH });
      expect(denied.status).toBe(403);
      expect(denied.body.code).toBe("SP_DEVELOPER_ONLY");
      expect((await correct(w)).body.code).toBe("SP_DEVELOPER_ONLY");

      await asDeveloper(w);
      const notGc = await w.agent.get(URL).query({ periodMonth: MONTH });
      expect(notGc.status).toBe(409);
      expect(notGc.body.message).toContain("Golden Coast only");
      const notGcWrite = await correct(w);
      expect(notGcWrite.status).toBe(409);
      expect(await corrections(w)).toEqual([]);
    });
  });

  it("validates the month, target and reason and refuses missing P&L accounts", async () => {
    await withFactoryWorld(async (w) => {
      await asDeveloper(w);
      await configure(w, { pnl: false });
      expect((await w.agent.get(URL).query({ periodMonth: "2026-13" })).status).toBe(400);
      expect((await w.agent.get(URL)).status).toBe(400);
      for (const bad of [
        body({ periodMonth: "April" }),
        body({ periodMonth: undefined }),
        body({ targetNetProfit: undefined }),
        body({ targetNetProfit: "1.234" }),
        body({ targetNetProfit: "abc" }),
        body({ reason: "x".repeat(501) }),
      ]) {
        expect((await post(w, URL, bad)).status, JSON.stringify(bad)).toBe(400);
      }
      const read = await w.agent.get(URL).query({ periodMonth: MONTH });
      expect(read.status).toBe(409);
      expect(read.body.code).toBe("GC_PHASE11_ACCOUNT_INVALID");
      const write = await correct(w);
      expect(write.status).toBe(409);
      expect(write.body.code).toBe("GC_PHASE11_ACCOUNT_INVALID");
      expect(await corrections(w)).toEqual([]);
    });
  });
});

describe("Golden Coast profit correction writes", () => {
  it("records corrections with a suspense account and reports them in the history", async () => {
    await withFactoryWorld(async (w) => {
      await asDeveloper(w);
      await configure(w);
      const before = await w.agent.get(URL).query({ periodMonth: MONTH });
      expect(before.status, JSON.stringify(before.body)).toBe(200);
      expect(before.body).toMatchObject({
        periodMonth: MONTH,
        sourceNetProfit: "200.00",
        effectiveNetProfit: "200.00",
        adjustment: "0.00",
        correction: null,
        history: [],
        finalized: false,
      });

      const saved = await correct(w);
      expect(saved.status).toBe(200);
      expect(saved.body).toMatchObject({
        sourceNetProfit: "200.00",
        effectiveNetProfit: "150.50",
        difference: "-49.50",
      });
      const suspense = await w.q(
        `SELECT account_type, is_hidden FROM ledger_accounts WHERE company_id = $1 AND sub_type = 'sp_profit_correction_suspense'`,
        [w.companyId]
      );
      expect(suspense).toEqual([{ account_type: "Asset", is_hidden: true }]);

      const zero = await correct(w, { targetNetProfit: "200", reason: "Back to ledger profit" });
      expect(zero.body.difference).toBe("0.00");
      const second = await correct(w, { targetNetProfit: "-20" });
      expect(second.body.difference).toBe("-220.00");
      expect(
        (
          await w.q(
            `SELECT 1 FROM ledger_accounts WHERE company_id = $1 AND sub_type = 'sp_profit_correction_suspense'`,
            [w.companyId]
          )
        ).length
      ).toBe(1);

      const after = await w.agent.get(URL).query({ periodMonth: MONTH });
      expect(after.headers["cache-control"]).toContain("no-store");
      expect(after.body).toMatchObject({ effectiveNetProfit: "-20.00", adjustment: "-220.00" });
      expect(after.body.history.map((h: { targetNetProfit: string }) => h.targetNetProfit)).toEqual([
        "-20.00",
        "200.00",
        "150.50",
      ]);
    });
  });

  it("refuses to edit a finalized month", async () => {
    await withFactoryWorld(async (w) => {
      await asDeveloper(w);
      await configure(w);
      await w.q(`INSERT INTO sp_profit_splits (company_id, period_month) VALUES ($1, $2)`, [w.companyId, MONTH]);
      const res = await correct(w);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("GC_PROFIT_PERIOD_CLOSED");
      expect(await corrections(w)).toEqual([]);
      // A legacy correction row without an actor name is still listed.
      await w.q(
        `INSERT INTO sp_profit_manual_corrections (company_id, period_month, target_net_profit, original_net_profit, reason, actor_id)
         VALUES ($1, $2, 180, 200, 'Imported correction', $3)`,
        [w.companyId, MONTH, w.userId]
      );
      const read = await w.agent.get(URL).query({ periodMonth: MONTH });
      expect(read.body).toMatchObject({ finalized: true, effectiveNetProfit: "180.00" });
      expect(read.body.history).toEqual([expect.objectContaining({ actorName: null, reason: "Imported correction" })]);
    });
  });
});

describe("legacy profit split endpoint", () => {
  it("is retired for Golden Coast and refused for non supplier-partner companies", async () => {
    await withFactoryWorld(async (w) => {
      expect((await legacySplit(w)).status).toBe(403);
      await configure(w, { pnl: false });
      const retired = await legacySplit(w);
      expect(retired.status).toBe(409);
      expect(retired.body.code).toBe("GC_PHASE11_LEGACY_PROFIT_SPLIT_RETIRED");
      expect(await w.q(`SELECT 1 FROM sp_profit_splits WHERE company_id = $1`, [w.companyId])).toEqual([]);
    });
  });

  it("passes a non Golden Coast supplier-partner company to the legacy handler", async () => {
    await withFactoryWorld(async (w) => {
      await configure(w, { goldenCoast: false, pnl: false });
      const res = await legacySplit(w);
      expect(res.status).toBe(200);
      expect(res.body.code).not.toBe("GC_PHASE11_LEGACY_PROFIT_SPLIT_RETIRED");
    });
  });
});
