/**
 * POST /api/stock-items/bulk-merge (server/routes/stock/merge/bulk-merge.ts)
 * over HTTP, one rolled-back company per test. Refusals first: missing or
 * oversized pair lists, POS roles, then per-pair skips (missing codes, unknown
 * codes, other-company items, same item, already-merged items, UOM mismatch)
 * that leave stock untouched. Then a merge through an alias that combines
 * inventory at a shared location, moves it at another, moves aliases, prices
 * and purchase-order lines, retires the duplicate and writes a merge log.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const URL = "/api/stock-items/bulk-merge";

const item = (w: FactoryWorld, code: string, uom = "PCS", companyId = w.companyId) =>
  w.one(`INSERT INTO stock_items (company_id, code, name, uom) VALUES ($1, $2, $3, $4) RETURNING id`, [
    companyId,
    `${w.tag}${code}`,
    `Item ${code}`,
    uom,
  ]);

const stock = (w: FactoryWorld, itemId: number, locationId: number, qty: string, value: string) =>
  w.q(
    `INSERT INTO inventory (company_id, stock_item_id, location_id, quantity, average_rate, total_value)
     VALUES ($1, $2, $3, $4, $5::numeric / $4::numeric, $5)`,
    [w.companyId, itemId, locationId, qty, value]
  );

describe("bulk merge refusals", () => {
  it("rejects a missing, empty or oversized pair list and POS users", () =>
    withFactoryWorld(async (w) => {
      expect((await w.agent.post(URL).send({})).status).toBe(400);
      expect((await w.agent.post(URL).send({ pairs: "A,B" })).status).toBe(400);
      const big = Array.from({ length: 501 }, () => ({ oldCode: "A", keepCode: "B" }));
      const tooMany = await w.agent.post(URL).send({ pairs: big });
      expect(tooMany.status).toBe(400);
      expect(tooMany.body.message).toBe("Maximum 500 pairs per request");
      const pos = await w.agentFor("POS");
      expect((await pos.post(URL).send({ pairs: [{ oldCode: "A", keepCode: "B" }] })).status).toBe(403);
    }));

  it("skips pairs that cannot be merged and leaves every item active", () =>
    withFactoryWorld(async (w) => {
      const keep = await item(w, "KEEP");
      const kg = await item(w, "KG", "KG");
      const merged = await item(w, "GONE");
      await w.q(`UPDATE stock_items SET deleted_at = now() WHERE id = $1`, [merged]);
      const other = await w.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
        `${w.tag}O`,
      ]);
      await item(w, "FOREIGN", "PCS", other);
      await w.q(`INSERT INTO stock_item_code_aliases (company_id, stock_item_id, alias_code) VALUES ($1, $2, $3)`, [
        w.companyId,
        merged,
        `${w.tag}GONEALIAS`,
      ]);
      const t = w.tag;
      const res = await w.agent.post(URL).send({
        pairs: [
          { oldCode: "", keepCode: `${t}KEEP` },
          { keepCode: `${t}KEEP` },
          { oldCode: `${t}KEEP`, keepCode: `${t}NOPE` },
          { oldCode: `${t}NOPE`, keepCode: `${t}KEEP` },
          { oldCode: `${t}FOREIGN`, keepCode: `${t}KEEP` },
          { oldCode: `${t}GONE`, keepCode: `${t}KEEP` },
          { oldCode: `${t}GONEALIAS`, keepCode: `${t}KEEP` },
          { oldCode: ` ${t.toLowerCase()}keep `, keepCode: `${t}KEEP` },
          { oldCode: `${t}KG`, keepCode: `${t}KEEP` },
        ],
      });
      expect(res.status).toBe(200);
      expect(res.body.results.map((r: { status: string; reason: string }) => [r.status, r.reason])).toEqual([
        ["skipped", "Missing code"],
        ["skipped", "Missing code"],
        ["skipped", `Keep code "${t}NOPE" not found`],
        ["skipped", `Old code "${t}NOPE" not found`],
        ["skipped", `Old code "${t}FOREIGN" not found`],
        ["skipped", `Old code "${t}GONE" not found`],
        ["skipped", `Old code "${t}GONEALIAS" not found`],
        ["skipped", "Old and keep codes resolve to the same item"],
        ["skipped", `UOM mismatch: "PCS" vs "KG"`],
      ]);
      const active = await w.q(`SELECT id FROM stock_items WHERE id = ANY($1::int[]) AND deleted_at IS NULL`, [
        [keep, kg],
      ]);
      expect(active).toHaveLength(2);
      expect(await w.q(`SELECT 1 FROM stock_item_merge_logs WHERE company_id = $1`, [w.companyId])).toEqual([]);
    }));
});

describe("bulk merge", () => {
  it("merges a duplicate (named by alias) into the kept item and records the merge", () =>
    withFactoryWorld(async (w) => {
      const keep = await item(w, "KEEP");
      const dup = await item(w, "DUP");
      const second = await w.one(
        `INSERT INTO locations (company_id, code, name) VALUES ($1, $2, 'Shop') RETURNING id`,
        [w.companyId, `${w.tag}L2`]
      );
      await stock(w, keep, w.locationId, "10", "100");
      await stock(w, dup, w.locationId, "5", "75");
      await stock(w, dup, second, "2", "20");
      await w.q(
        `INSERT INTO stock_item_code_aliases (company_id, stock_item_id, alias_code)
         VALUES ($1, $2, $3), ($1, $2, $4), ($1, $5, $6)`,
        // The duplicate's alias equal to the kept code stays put; the kept
        // item already answers to the duplicate's code, so no alias is added.
        [w.companyId, dup, `${w.tag}OLDDUP`, `${w.tag}KEEP`, keep, `${w.tag}DUP`]
      );
      await w.q(
        `INSERT INTO stock_item_location_prices (stock_item_id, location_id, selling_price)
         VALUES ($1, $3, 12), ($2, $3, 15), ($2, $4, 9)`,
        [keep, dup, w.locationId, second]
      );

      const res = await w.agent.post(URL).send({ pairs: [{ oldCode: `${w.tag}OLDDUP`, keepCode: `${w.tag}KEEP` }] });
      expect(res.status).toBe(200);
      expect(res.body.results).toEqual([
        expect.objectContaining({ status: "success", keptItemId: keep, mergedItemId: dup, oldItemName: "Item DUP" }),
      ]);

      const inv = await w.q(
        `SELECT location_id, quantity::float8 AS qty, total_value::float8 AS value, average_rate::float8 AS rate
           FROM inventory WHERE stock_item_id = ANY($1::int[]) ORDER BY location_id`,
        [[keep, dup]]
      );
      expect(inv).toEqual([
        { location_id: w.locationId, qty: 15, value: 175, rate: expect.closeTo(11.6667, 3) },
        { location_id: second, qty: 2, value: 20, rate: 10 },
      ]);
      const aliases = await w.q(
        `SELECT alias_code, stock_item_id FROM stock_item_code_aliases WHERE company_id = $1 ORDER BY alias_code`,
        [w.companyId]
      );
      expect(aliases.map((a) => [a.alias_code, a.stock_item_id])).toEqual([
        [`${w.tag}DUP`, keep],
        [`${w.tag}KEEP`, dup],
        [`${w.tag}OLDDUP`, keep],
      ]);
      const prices = await w.q(
        `SELECT stock_item_id, location_id, selling_price::float8 AS price FROM stock_item_location_prices
          WHERE stock_item_id = ANY($1::int[]) ORDER BY location_id`,
        [[keep, dup]]
      );
      expect(prices).toEqual([
        { stock_item_id: keep, location_id: w.locationId, price: 12 },
        { stock_item_id: keep, location_id: second, price: 9 },
      ]);
      const [retired] = await w.q(
        `SELECT active, name, deleted_at IS NOT NULL AS deleted FROM stock_items WHERE id = $1`,
        [dup]
      );
      expect(retired).toEqual({ active: false, name: "[MERGED] Item DUP", deleted: true });
      const [log] = await w.q(
        `SELECT kept_item_id, merged_item_id, notes, merged_by_user_id FROM stock_item_merge_logs WHERE company_id = $1`,
        [w.companyId]
      );
      expect(log).toEqual({
        kept_item_id: keep,
        merged_item_id: dup,
        notes: "Bulk merge via Excel",
        merged_by_user_id: w.userId,
      });

      // The duplicate is gone now, so a repeat of the same pair is skipped.
      const again = await w.agent.post(URL).send({ pairs: [{ oldCode: `${w.tag}DUP`, keepCode: `${w.tag}KEEP` }] });
      expect(again.body.results[0]).toMatchObject({
        status: "skipped",
        reason: "Old and keep codes resolve to the same item",
      });
    }));
});
