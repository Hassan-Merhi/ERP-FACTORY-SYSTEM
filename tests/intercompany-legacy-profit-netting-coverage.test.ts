/**
 * normalizeLegacyIntercompanyProfit on the intercompany trade fixture inside
 * one rolled-back transaction per test. Refusals first - confirmation and
 * role, a company outside the pair, a stale version, a received container,
 * price revisions, missing or contradictory import evidence, original
 * vouchers that do not match, and voucher lines that differ from an at-cost
 * import - each leaving no netting voucher or audit event. Then the netting
 * journal itself and its idempotent replay.
 */
import { describe, expect, it } from "vitest";

import { withRolledBackPool } from "./helpers/routedPoolClient";
import { createIntercompanyTradeWorld, type IntercompanyTradeWorld } from "./helpers/intercompanyTradeFixture";
import { normalizeLegacyIntercompanyProfit } from "../server/services/intercompany/legacyProfitNetting";

const world = <T>(work: (w: IntercompanyTradeWorld) => Promise<T>, landed?: string) =>
  withRolledBackPool(async (client) => work(await createIntercompanyTradeWorld(client, { landed })));

type Trade = Awaited<ReturnType<IntercompanyTradeWorld["trade"]>>;

const input = (tradeId: number, over: Record<string, unknown> = {}) => ({
  tradeId,
  expectedVersion: 1,
  postingDate: "2026-06-20",
  confirmNoCashOrStockChange: true,
  ...over,
});

/** The at-cost import's original lines: Dr AR / Cr Sales, Dr COGS / Cr Purchases. */
async function atCostLines(w: IntercompanyTradeWorld, t: Trade, amount = "100.00") {
  const a = w.accounts;
  await w.q(
    `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount)
     VALUES ($1, $3, $5, 0), ($1, $4, 0, $5), ($2, $6, $5, 0), ($2, $7, 0, $5)`,
    [
      t.vouchers.sale,
      t.vouchers.cost,
      a.sourceReceivableAccountId,
      a.sourceSalesAccountId,
      amount,
      a.sourceCostAccountId,
      a.sourcePurchaseAccountId,
    ]
  );
}

async function footprint(w: IntercompanyTradeWorld) {
  const [row] = await w.q(
    `SELECT (SELECT count(*)::int FROM vouchers WHERE company_id = $1) AS vouchers,
            (SELECT count(*)::int FROM intercompany_audit_events
              WHERE source_company_id = $1 AND event_type = 'intercompany-internal-profit-netted') AS netted`,
    [w.sourceCompanyId]
  );
  return row;
}

async function refused(w: IntercompanyTradeWorld, run: () => Promise<unknown>, code: string) {
  const before = await footprint(w);
  await expect(run()).rejects.toMatchObject({ code });
  expect(await footprint(w)).toEqual(before);
}

describe("legacy intercompany profit netting refusals", () => {
  it("needs Owner/Developer confirmation, a pair company and a valid date", () =>
    world(async (w) => {
      const t = await w.trade();
      await atCostLines(w, t);
      await t.audit();
      await refused(
        w,
        () => normalizeLegacyIntercompanyProfit(input(t.tradeId, { confirmNoCashOrStockChange: false }), w.identity()),
        "IC_NETTING_FORBIDDEN"
      );
      const manager = await w.otherUser([[w.sourceCompanyId, "Manager"]]);
      await refused(
        w,
        () => normalizeLegacyIntercompanyProfit(input(t.tradeId), w.identity(w.sourceCompanyId, "Manager", manager)),
        "IC_NETTING_FORBIDDEN"
      );
      const outsider = await w.company("Z", "erp");
      const stranger = await w.otherUser([[outsider, "Owner"]]);
      await refused(
        w,
        () => normalizeLegacyIntercompanyProfit(input(t.tradeId), w.identity(outsider, "Owner", stranger)),
        "IC_EDIT_NOT_FOUND"
      );
      await expect(
        normalizeLegacyIntercompanyProfit(input(t.tradeId, { postingDate: "20-06-2026" }), w.identity())
      ).rejects.toThrow();
    }));

  it("refuses a stale version, a received container and revised prices", () =>
    world(async (w) => {
      const t = await w.trade();
      await atCostLines(w, t);
      await t.audit();
      await refused(
        w,
        () => normalizeLegacyIntercompanyProfit(input(t.tradeId, { expectedVersion: 9 }), w.identity()),
        "IC_NETTING_STALE"
      );
      await w.q(
        `INSERT INTO intercompany_trade_revisions (trade_id, revision_number, kind, request_key, actor_user_id,
           initiating_company_id, amount_before, amount_after, posting_date, reason)
         VALUES ($1, 2, 'line_edit', $2, $3, $4, 100, 90, '2026-06-10', 'Price cut')`,
        [t.tradeId, `${w.tag}-rev`, w.userId, w.sourceCompanyId]
      );
      await refused(w, () => normalizeLegacyIntercompanyProfit(input(t.tradeId), w.identity()), "IC_NETTING_REVISED");

      const received = await w.trade("R", "Received");
      await received.audit();
      await refused(
        w,
        () => normalizeLegacyIntercompanyProfit(input(received.tradeId), w.identity()),
        "IC_EDIT_INVENTORY_DEPENDENCY"
      );
    }));

  it("refuses when the import evidence is missing or contradictory", () =>
    world(async (w) => {
      const none = await w.trade("A");
      await refused(
        w,
        () => normalizeLegacyIntercompanyProfit(input(none.tradeId), w.identity()),
        "IC_NETTING_EVIDENCE"
      );
      const same = await w.trade("B");
      await same.audit({ sourceCostVoucherId: same.vouchers.sale });
      await refused(
        w,
        () => normalizeLegacyIntercompanyProfit(input(same.tradeId), w.identity()),
        "IC_NETTING_EVIDENCE"
      );
      const text = await w.trade("C");
      await text.audit({ sourceSaleVoucherId: "12" });
      await refused(
        w,
        () => normalizeLegacyIntercompanyProfit(input(text.tradeId), w.identity()),
        "IC_NETTING_EVIDENCE"
      );
    }));

  it("refuses original vouchers that do not match the landed cost", () =>
    world(async (w) => {
      const cases: Array<[string, (t: Trade) => Promise<unknown>]> = [
        ["amount", (t) => w.q(`UPDATE vouchers SET total_amount = 99 WHERE id = $1`, [t.vouchers.sale])],
        ["type", (t) => w.q(`UPDATE vouchers SET voucher_type = 'Journal' WHERE id = $1`, [t.vouchers.sale])],
        ["cost type", (t) => w.q(`UPDATE vouchers SET voucher_type = 'Payment' WHERE id = $1`, [t.vouchers.cost])],
        ["deleted", (t) => w.q(`UPDATE vouchers SET deleted_at = now() WHERE id = $1`, [t.vouchers.cost])],
        ["gone", (t) => t.audit({ sourceCostVoucherId: 2147483000 }, `ic-container-import:0:${t.tradeId}`)],
      ];
      let n = 0;
      for (const [label, spoil] of cases) {
        const t = await w.trade(`V${++n}`);
        // Lines and header changes land before the import evidence links them.
        await spoil(t);
        if (label !== "gone") await t.audit();
        await refused(
          w,
          () => normalizeLegacyIntercompanyProfit(input(t.tradeId), w.identity()),
          "IC_NETTING_VOUCHERS"
        );
      }
    }));

  it("refuses when the original lines differ from an at-cost import", () =>
    world(async (w) => {
      const missing = await w.trade("A");
      await missing.audit();
      await refused(
        w,
        () => normalizeLegacyIntercompanyProfit(input(missing.tradeId), w.identity()),
        "IC_NETTING_ENTRIES"
      );
      const wrong = await w.trade("B");
      await atCostLines(w, wrong, "60.00");
      await wrong.audit();
      await refused(
        w,
        () => normalizeLegacyIntercompanyProfit(input(wrong.tradeId), w.identity()),
        "IC_NETTING_ENTRIES"
      );
    }));

  it("refuses a zero landed cost", () =>
    world(async (w) => {
      const t = await w.trade();
      await t.audit();
      await refused(w, () => normalizeLegacyIntercompanyProfit(input(t.tradeId), w.identity()), "IC_NETTING_VOUCHERS");
    }, "0.00"));
});

describe("legacy intercompany profit netting", () => {
  it("posts one Dr Sales / Cr COGS journal and replays as already netted", () =>
    world(async (w) => {
      const t = await w.trade();
      await atCostLines(w, t);
      await t.audit();
      const result = await normalizeLegacyIntercompanyProfit(input(t.tradeId), w.identity());
      expect(result).toMatchObject({
        tradeId: t.tradeId,
        alreadyNetted: false,
        amount: "100.00",
        noCashOrStockChange: true,
      });
      const lines = await w.q(
        `SELECT ledger_account_id AS account, debit_amount::text AS debit, credit_amount::text AS credit
           FROM voucher_entries WHERE voucher_id = $1 ORDER BY id`,
        [(result as { voucherId: number }).voucherId]
      );
      expect(lines.map((l) => [Number(l.account), l.debit, l.credit])).toEqual([
        [w.accounts.sourceSalesAccountId, "100.00", "0.00"],
        [w.accounts.sourceCostAccountId, "0.00", "100.00"],
      ]);
      const [event] = await w.q(`SELECT payload FROM intercompany_audit_events WHERE event_key = $1`, [
        `ic-technical-profit-normalized:${t.tradeId}`,
      ]);
      expect(event.payload).toMatchObject({
        amount: "100.00",
        originalSaleVoucherId: t.vouchers.sale,
        originalCostVoucherId: t.vouchers.cost,
      });

      const before = await footprint(w);
      const replay = await normalizeLegacyIntercompanyProfit(input(t.tradeId), w.identity());
      expect(replay).toEqual({ tradeId: t.tradeId, alreadyNetted: true, noCashOrStockChange: true });
      expect(await footprint(w)).toEqual(before);
    }));

  it("treats an import recorded with technical netting as already netted", () =>
    world(async (w) => {
      const t = await w.trade();
      await t.audit({ technicalProfitNetting: true });
      const before = await footprint(w);
      const result = await normalizeLegacyIntercompanyProfit(input(t.tradeId), w.identity());
      expect(result).toMatchObject({ alreadyNetted: true });
      expect(await footprint(w)).toEqual(before);
    }));
});
