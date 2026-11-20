/**
 * Supplier Partner opening stock (server/routes/sp/spOpeningStockRoutes.ts),
 * one rolled-back transaction per test through the full HTTP stack.
 *
 * Pinned: non-SP companies are refused; every validation refusal writes no
 * movement or voucher; the posted voucher always balances (base clearing and
 * opening-equity legs appear only when non-zero, on the right side); another
 * company's location is refused by the inventory integrity check.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

async function spCompany(w: FactoryWorld, setup = true): Promise<number> {
  await w.q(`UPDATE companies SET company_type = 'supplier_partner' WHERE id = $1`, [w.companyId]);
  if (setup) {
    const res = await w.agent.post("/api/sp/setup").send({
      confirmation: "CHANGE SP SETUP",
      reason: "SP opening stock coverage world",
      idempotencyKey: `setup-${w.tag}`,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }
  return w.one(
    `INSERT INTO stock_items (company_id, code, name, uom, active) VALUES ($1, $2, 'SP item', 'PCS', true) RETURNING id`,
    [w.companyId, `${w.tag}-ITEM`]
  );
}

let keySeq = 0;
/** POST through the SP sensitive-action guard (exact confirmation, reason, idempotency key). */
function post(w: FactoryWorld, body: Record<string, unknown>, key = `open-${w.tag}-${++keySeq}`) {
  return w.agent
    .post("/api/sp/opening-stock")
    .send({ confirmation: "POST SP OPENING STOCK", reason: "Opening stock count", idempotencyKey: key, ...body });
}

async function counts(w: FactoryWorld) {
  const [row] = await w.q<{ movements: number; vouchers: number }>(
    `SELECT (SELECT count(*)::int FROM sp_stock_movements WHERE company_id = $1) AS movements,
            (SELECT count(*)::int FROM vouchers WHERE company_id = $1) AS vouchers`,
    [w.companyId]
  );
  return row;
}

async function entries(w: FactoryWorld, voucherId: number) {
  return w.q<{ code: string; debit: string; credit: string }>(
    `SELECT la.code, COALESCE(ve.debit_amount, 0)::numeric::text AS debit, COALESCE(ve.credit_amount, 0)::numeric::text AS credit
       FROM voucher_entries ve JOIN ledger_accounts la ON la.id = ve.ledger_account_id
      WHERE ve.voucher_id = $1 ORDER BY ve.id`,
    [voucherId]
  );
}

describe("SP opening stock routes", () => {
  it("refuses a company that is not a supplier partner", async () => {
    await withFactoryWorld(async (w) => {
      const list = await w.agent.get("/api/sp/opening-stock");
      expect([403]).toContain(list.status);
      const refused = await post(w, { articleCode: "A1", stockItemId: 1, qty: 1 });
      expect(refused.status).toBe(403);
      expect(await counts(w)).toEqual({ movements: 0, vouchers: 0 });
    });
  });

  it("rejects every invalid request without writing", async () => {
    await withFactoryWorld(async (w) => {
      const stockItemId = await spCompany(w);
      const cases: [Record<string, unknown>, RegExp][] = [
        [{ stockItemId, qty: 1, finalUnitCostUsd: 1 }, /articleCode required/],
        [{ articleCode: "A1", stockItemId: "x", qty: 1, finalUnitCostUsd: 1 }, /stockItemId is required/],
        [{ articleCode: "A1", stockItemId, qty: 0, finalUnitCostUsd: 1 }, /qty must be > 0/],
        [{ articleCode: "A1", stockItemId, finalUnitCostUsd: 1 }, /qty must be > 0/],
        [{ articleCode: "A1", stockItemId, qty: "2", finalUnitCostUsd: "0" }, /finalUnitCostUsd must be > 0/],
      ];
      for (const [body, message] of cases) {
        const res = await post(w, body);
        expect(res.status, JSON.stringify(res.body)).toBe(400);
        expect(res.body.message).toMatch(message);
      }
      expect(await counts(w)).toEqual({ movements: 0, vouchers: 0 });
    });
  });

  it("refuses when SP accounts are not set up", async () => {
    await withFactoryWorld(async (w) => {
      const stockItemId = await spCompany(w, false);
      const res = await post(w, { articleCode: "A1", stockItemId, qty: 1, finalUnitCostUsd: 2 });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/SP accounts not configured/);
      expect(await counts(w)).toEqual({ movements: 0, vouchers: 0 });
    });
  });

  it("refuses when the company has no active location", async () => {
    await withFactoryWorld(async (w) => {
      const stockItemId = await spCompany(w);
      await w.q(`UPDATE locations SET deleted_at = now() WHERE company_id = $1`, [w.companyId]);
      const res = await post(w, { articleCode: "A1", stockItemId, qty: 1, finalUnitCostUsd: 2 });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("SP_INVENTORY_LINK_REQUIRED");
      expect(await counts(w)).toEqual({ movements: 0, vouchers: 0 });
    });
  });

  it("posts final cost above base to opening equity on the credit side and lists it", async () => {
    await withFactoryWorld(async (w) => {
      const stockItemId = await spCompany(w);
      const res = await post(w, {
        articleCode: "A1",
        stockItemId,
        qty: 4,
        baseUnitCostUsd: 2,
        landedUnitCostUsd: 2.5,
        finalUnitCostUsd: 3,
        notes: "Opening count",
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.movement).toMatchObject({
        articleCode: "A1",
        locationId: w.locationId,
        description: "Opening count",
      });
      expect(await entries(w, res.body.voucherId)).toEqual([
        { code: "SP-STOCK", debit: "12.00", credit: "0.00" },
        { code: "SP-COSTCLR", debit: "0.00", credit: "8.00" },
        { code: "SP-OPNBAL", debit: "0.00", credit: "4.00" },
      ]);
      const [inv] = await w.q<{ quantity: string }>(
        `SELECT quantity::text FROM inventory WHERE company_id = $1 AND stock_item_id = $2`,
        [w.companyId, stockItemId]
      );
      expect(Number(inv.quantity)).toBe(4);
      const list = await w.agent.get("/api/sp/opening-stock");
      expect(list.status).toBe(200);
      expect(list.body).toEqual([expect.objectContaining({ article_code: "A1", source_type: "opening" })]);
    });
  });

  it("debits opening equity when final cost is below base, and omits zero legs", async () => {
    await withFactoryWorld(async (w) => {
      const stockItemId = await spCompany(w);
      const below = await post(w, {
        articleCode: "B1",
        stockItemId,
        qty: "2",
        baseUnitCostUsd: "5",
        finalUnitCostUsd: "4",
        locationId: String(w.locationId),
      });
      expect(below.status, JSON.stringify(below.body)).toBe(200);
      expect(await entries(w, below.body.voucherId)).toEqual([
        { code: "SP-STOCK", debit: "8.00", credit: "0.00" },
        { code: "SP-COSTCLR", debit: "0.00", credit: "10.00" },
        { code: "SP-OPNBAL", debit: "2.00", credit: "0.00" },
      ]);
      const equal = await post(w, { articleCode: "B2", stockItemId, qty: 1, baseUnitCostUsd: 3, finalUnitCostUsd: 3 });
      expect(equal.status).toBe(200);
      expect((await entries(w, equal.body.voucherId)).map((e) => e.code)).toEqual(["SP-STOCK", "SP-COSTCLR"]);
      const noBase = await post(w, { articleCode: "B3", stockItemId, qty: 1, finalUnitCostUsd: 3 });
      expect(noBase.status).toBe(200);
      expect((await entries(w, noBase.body.voucherId)).map((e) => e.code)).toEqual(["SP-STOCK", "SP-OPNBAL"]);
    });
  });

  it("refuses another company's location and writes nothing", async () => {
    await withFactoryWorld(async (w) => {
      const stockItemId = await spCompany(w);
      const otherCompany = await w.one(`INSERT INTO companies (code, name) VALUES ($1, 'Other SP') RETURNING id`, [
        `${w.tag}O`,
      ]);
      const otherLocation = await w.one(
        `INSERT INTO locations (company_id, code, name) VALUES ($1, $2, 'Other') RETURNING id`,
        [otherCompany, `${w.tag}OL`]
      );
      const res = await post(w, {
        articleCode: "C1",
        stockItemId,
        qty: 1,
        finalUnitCostUsd: 3,
        locationId: otherLocation,
      });
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.code).toBe("SP_INVENTORY_LINK_REQUIRED");
      expect(await counts(w)).toEqual({ movements: 0, vouchers: 0 });
    });
  });
});
