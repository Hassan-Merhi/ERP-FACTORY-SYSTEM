/**
 * POST /api/erp/supplier-returns/commit against PostgreSQL in one rolled-back
 * transaction per test: request validation, role refusal, every source and
 * stock refusal (nothing written), a posted return with its stock issue,
 * supplier-credit voucher and audit rows, idempotent replay of the same
 * request key, landed-cost variance lines and per-row allocation checks.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { returnSource } from "./helpers/supplierReturnFixture";

const URL = "/api/erp/supplier-returns/commit";
let keySeq = 0;
const key = () => `ret-${process.pid}-${Date.now().toString(36)}-${++keySeq}`;

const commit = (w: FactoryWorld, body: Record<string, unknown>, agent = w.agent) =>
  agent.post(URL).send({ requestKey: key(), returnDate: "2026-06-01", reason: "damaged", fileName: "r.xlsx", ...body });

const batches = async (w: FactoryWorld) =>
  (await w.q(`SELECT count(*)::int AS n FROM erp_supplier_return_batches WHERE company_id = $1`, [w.companyId]))[0].n;
const stockQty = async (w: FactoryWorld, stockItemId: number) =>
  (
    await w.q(`SELECT quantity::text AS q FROM inventory WHERE location_id = $1 AND stock_item_id = $2`, [
      w.locationId,
      stockItemId,
    ])
  )[0]?.q;

describe("supplier return commit: refusals before posting", () => {
  it("refuses non-Admin roles and malformed requests", async () => {
    await withFactoryWorld(async (w) => {
      const manager = await w.agentFor("Manager");
      expect((await commit(w, { lines: [{ offloadItemId: 1, quantity: "1" }] }, manager)).status).toBe(403);
      const cases: Array<[Record<string, unknown>, string]> = [
        [{ supplierId: 1.5, lines: [] }, "RETURN_SUPPLIER_INVALID"],
        [{ requestKey: "bad key!", lines: [] }, "RETURN_IDEMPOTENCY_KEY_REQUIRED"],
        [{ returnDate: "2026-13-01", lines: [] }, "RETURN_DATE_INVALID"],
        [{ lines: "x" }, "RETURN_LINES_INVALID"],
        [{ lines: [{ offloadItemId: 1, quantity: "0" }] }, "RETURN_QUANTITY_INVALID"],
        [{ lines: [{ offloadItemId: 1, quantity: "1.2345" }] }, "RETURN_QUANTITY_INVALID"],
        [
          {
            lines: [
              { offloadItemId: 2, quantity: "1" },
              { offloadItemId: 2, quantity: "1" },
            ],
          },
          "RETURN_LINES_DUPLICATE",
        ],
        [{ lines: [{ offloadItemId: "x", quantity: "1" }] }, "RETURN_LINES_DUPLICATE"],
        [
          {
            lines: [{ offloadItemId: 1, quantity: "1" }],
            requestedRows: [{ code: "A", quantity: "2", allocations: [] }],
          },
          "RETURN_ALLOCATION_INVALID",
        ],
      ];
      for (const [body, code] of cases) {
        const res = await commit(w, body);
        expect(res.status, code).toBe(400);
        expect(res.body.code).toBe(code);
      }
      expect(await batches(w)).toBe(0);
    });
  });

  it("refuses unknown, unavailable, ambiguous, foreign-supplier and over-quantity sources", async () => {
    await withFactoryWorld(async (w) => {
      const missing = await commit(w, { lines: [{ offloadItemId: 2147483000, quantity: "1" }] });
      expect([missing.status, missing.body.code]).toEqual([404, "RETURN_SOURCE_MISSING"]);

      const otw = await returnSource(w, { containerStatus: "OTW" });
      const unavailable = await commit(w, { lines: [{ offloadItemId: otw.offloadItemId, quantity: "1" }] });
      expect([unavailable.status, unavailable.body.code]).toEqual([409, "RETURN_SOURCE_UNAVAILABLE"]);

      const eur = await returnSource(w, { currency: "EUR" });
      const ambiguous = await commit(w, { lines: [{ offloadItemId: eur.offloadItemId, quantity: "1" }] });
      expect([ambiguous.status, ambiguous.body.code]).toEqual([409, "RETURN_SUPPLIER_OR_CURRENCY_AMBIGUOUS"]);

      const src = await returnSource(w);
      const wrongSupplier = await commit(w, {
        supplierId: src.supplierId + 100000,
        lines: [{ offloadItemId: src.offloadItemId, quantity: "1" }],
      });
      expect([wrongSupplier.status, wrongSupplier.body.code]).toEqual([409, "RETURN_SUPPLIER_MISMATCH"]);

      const tooMany = await commit(w, { lines: [{ offloadItemId: src.offloadItemId, quantity: "11" }] });
      expect([tooMany.status, tooMany.body.code]).toEqual([409, "RETURN_EXCEEDS_OFFLOAD"]);

      const noStock = await returnSource(w, { inventory: null });
      const missingRow = await commit(w, { lines: [{ offloadItemId: noStock.offloadItemId, quantity: "1" }] });
      expect([missingRow.status, missingRow.body.code]).toEqual([409, "RETURN_STOCK_ROW_MISSING"]);

      expect(await batches(w)).toBe(0);
      expect(await stockQty(w, src.stockItemId)).toBe("10.000");
    });
  });
});

describe("supplier return commit: posting", () => {
  it("posts the return, issues stock, credits the supplier and replays the same request key", async () => {
    await withFactoryWorld(async (w) => {
      const src = await returnSource(w);
      const requestKey = key();
      const body = {
        requestKey,
        supplierId: src.supplierId,
        lines: [{ offloadItemId: src.offloadItemId, quantity: "4" }],
      };
      const res = await commit(w, body);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        success: true,
        replayed: false,
        totalQty: "4.000",
        supplierCreditUsd: "20.00",
        inventoryReductionUsd: "20.00",
      });
      expect(await stockQty(w, src.stockItemId)).toBe("6.000");
      const [returnLine] = await w.q(
        `SELECT l.voucher_id, l.supplier_credit_usd::text AS credit, v.voucher_number
           FROM erp_supplier_return_lines l JOIN vouchers v ON v.id = l.voucher_id WHERE l.batch_id = $1`,
        [res.body.id]
      );
      expect(returnLine.credit).toBe("20.00");
      expect(returnLine.voucher_number).toMatch(new RegExp(`^SUP-RETURN-${w.companyId}-`));
      const voucherLines = await w.q(
        `SELECT supplier_id, debit_amount::text AS dr, credit_amount::text AS cr FROM voucher_entries WHERE voucher_id = $1`,
        [returnLine.voucher_id]
      );
      expect(voucherLines).toHaveLength(2);
      expect(voucherLines).toContainEqual(expect.objectContaining({ supplier_id: src.supplierId, dr: "20.00" }));

      const replay = await commit(w, body);
      expect(replay.status).toBe(200);
      expect(replay.body).toEqual({ success: true, id: res.body.id, replayed: true });
      expect(await batches(w)).toBe(1);
      expect(await stockQty(w, src.stockItemId)).toBe("6.000");

      const remaining = await commit(w, { lines: [{ offloadItemId: src.offloadItemId, quantity: "7" }] });
      expect(remaining.body.code).toBe("RETURN_EXCEEDS_OFFLOAD");
    });
  });

  it("books the difference between purchase credit and inventory relief to the variance account", async () => {
    await withFactoryWorld(async (w) => {
      const above = await returnSource(w, { rate: "5", inventory: { quantity: "10", value: "80" } });
      const below = await returnSource(w, { rate: "5", inventory: { quantity: "10", value: "30" } });
      const res = await commit(w, {
        lines: [
          { offloadItemId: above.offloadItemId, quantity: "2" },
          { offloadItemId: below.offloadItemId, quantity: "2" },
        ],
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ supplierCreditUsd: "20.00", inventoryReductionUsd: "22.00" });
      const variance = await w.q(
        `SELECT e.debit_amount::text AS dr, e.credit_amount::text AS cr
           FROM voucher_entries e JOIN ledger_accounts a ON a.id = e.ledger_account_id
          WHERE a.company_id = $1 AND a.code = 'SUPPLIER_RETURN_COST_VARIANCE' ORDER BY e.id`,
        [w.companyId]
      );
      expect(variance).toEqual([
        { dr: "6.00", cr: "0.00" },
        { dr: "0.00", cr: "4.00" },
      ]);
    });
  });
});

describe("supplier return commit: requested row allocations", () => {
  it("records each workbook row allocation against its source return line", async () => {
    await withFactoryWorld(async (w) => {
      const src = await returnSource(w);
      const res = await commit(w, {
        lines: [{ offloadItemId: src.offloadItemId, quantity: "3" }],
        requestedRows: [
          { code: src.code, quantity: "1", allocations: [{ offloadItemId: src.offloadItemId, quantity: "1" }] },
          { code: ` ${src.code} `, quantity: "2", allocations: [{ offloadItemId: src.offloadItemId, quantity: "2" }] },
        ],
      });
      expect(res.status).toBe(200);
      const rows = await w.q(
        `SELECT input_row, requested_article_code AS code, allocated_quantity::text AS qty
           FROM erp_supplier_return_allocation_rows WHERE batch_id = $1 ORDER BY input_row`,
        [res.body.id]
      );
      expect(rows).toEqual([
        { input_row: 2, code: src.code, qty: "1.000" },
        { input_row: 3, code: src.code, qty: "2.000" },
      ]);
    });
  });

  it("refuses a row whose source belongs to another article or mixes suppliers", async () => {
    await withFactoryWorld(async (w) => {
      const a = await returnSource(w);
      const b = await returnSource(w);
      const wrongArticle = await commit(w, {
        lines: [{ offloadItemId: b.offloadItemId, quantity: "1" }],
        requestedRows: [
          { code: a.code, quantity: "1", allocations: [{ offloadItemId: b.offloadItemId, quantity: "1" }] },
        ],
      });
      expect([wrongArticle.status, wrongArticle.body.code]).toEqual([409, "RETURN_ARTICLE_SOURCE_MISMATCH"]);

      const sameItem = await returnSource(w, { code: a.code, stockItemId: a.stockItemId, inventory: null });
      const mixed = await commit(w, {
        lines: [
          { offloadItemId: a.offloadItemId, quantity: "1" },
          { offloadItemId: sameItem.offloadItemId, quantity: "1" },
        ],
        requestedRows: [
          {
            code: a.code,
            quantity: "2",
            allocations: [
              { offloadItemId: a.offloadItemId, quantity: "1" },
              { offloadItemId: sameItem.offloadItemId, quantity: "1" },
            ],
          },
        ],
      });
      expect([mixed.status, mixed.body.code]).toEqual([409, "RETURN_ROW_SUPPLIER_MIXED"]);
      expect(await batches(w)).toBe(0);
    });
  });
});
