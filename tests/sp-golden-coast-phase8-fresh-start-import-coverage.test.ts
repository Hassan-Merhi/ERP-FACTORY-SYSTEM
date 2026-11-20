/**
 * Golden Coast Fresh Start Excel container import
 * (server/routes/sp/spGoldenCoastPhase8FreshStartImportRoute.ts) over HTTP
 * against PostgreSQL, one rolled-back supplier-partner company per test.
 *
 * Pinned refusals (nothing written): a non supplier-partner company, a body
 * that is not a parsed Excel container, a supplier link, a company without
 * Golden Coast setup, a missing or duplicated OTW clearing account, a foreign
 * stock item, a non-positive total or out-of-range discount, a negative fee,
 * and a total that does not reconcile. The success path posts a balanced
 * voucher and writes the container with its lines; the same idempotency key
 * replays it; a different key with the same container number is a duplicate;
 * a replayed voucher whose container vanished is reported as corrupt.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const URL = "/api/sp/golden-coast/phase8/containers/import-excel";

async function goldenCoast(w: FactoryWorld, opts: { clearing?: number; capital?: boolean } = {}) {
  await w.q(`UPDATE companies SET company_type = 'supplier_partner' WHERE id = $1`, [w.companyId]);
  const ledger = (code: string, type: string, subType: string) =>
    w.one(
      `INSERT INTO ledger_accounts (company_id, code, name, account_type, sub_type)
       VALUES ($1, $2::varchar, $2::text, $3, $4) RETURNING id`,
      [w.companyId, `${w.tag}${code}`, type, subType]
    );
  if (opts.capital !== false) {
    await ledger("PC", "Equity", "gc_partner_capital");
    await ledger("OC", "Equity", "gc_owner_capital");
  }
  await ledger("SAV", "Loans", "gc_hassan_savings");
  const otw = await ledger("OTW", "Asset", "sp_goods_otw");
  await ledger("SIH", "Asset", "sp_stock");
  await ledger("RES", "Asset", "sp_prepaid_expenses");
  const clearing: number[] = [];
  for (let i = 0; i < (opts.clearing ?? 1); i += 1) {
    clearing.push(await ledger(`CLR${i}`, "Liability", "sp_otw_clearing"));
  }
  const item = await w.one(
    `INSERT INTO stock_items (company_id, code, name, uom) VALUES ($1, $2, 'Bales', 'pcs') RETURNING id`,
    [w.companyId, `${w.tag}SI`]
  );
  return { otw, clearing, item };
}

function body(item: number, extra: Record<string, unknown> = {}) {
  return {
    importSource: "excel",
    containerNumber: "FSCU1234567",
    invoiceNumber: "FS-INV-1",
    invoiceDate: "2026-09-05",
    invoiceTotalUsd: "190",
    discountPct: "10",
    freightEstimateUsd: "5",
    surchargeUsd: "3",
    fumigationUsd: "1",
    documentChargesUsd: "1",
    lines: [{ stockItemId: item, articleCode: "BAG", description: "Bag", qty: "10", unitRateUsd: "20" }],
    ...extra,
  };
}

const containers = (w: FactoryWorld) =>
  w.q(`SELECT id, container_number, supplier_id, goods_otw_voucher_id FROM sp_containers WHERE company_id = $1`, [
    w.companyId,
  ]);

let requestSeq = 0;
const post = (w: FactoryWorld, payload: unknown, key = `${w.tag}-R${++requestSeq}`) =>
  w.agent.post(URL).set("X-Idempotency-Key", key).send(payload);

/**
 * The voucher-path request boundary answers a repeated key from its own guard
 * row. Wait for that row to complete, then drop it so the repeated request
 * reaches the handler's own replay logic.
 */
async function forgetRequestGuard(w: FactoryWorld, key: string) {
  for (let i = 0; i < 50; i += 1) {
    const [row] = await w.q(
      `SELECT state FROM voucher_path_request_guards WHERE company_id = $1 AND idempotency_key = $2`,
      [w.companyId, key]
    );
    if (row?.state === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await w.q(`DELETE FROM voucher_path_request_guards WHERE company_id = $1 AND idempotency_key = $2`, [
    w.companyId,
    key,
  ]);
}

describe("Fresh Start Excel import refusals", () => {
  it("refuses a company that is not a supplier partner", () =>
    withFactoryWorld(async (w) => {
      const res = await post(w, { importSource: "excel" });
      expect(res.status).toBe(403);
      expect(await containers(w)).toEqual([]);
    }));

  it("refuses a non-Excel body and a supplier link before touching the books", () =>
    withFactoryWorld(async (w) => {
      const { item } = await goldenCoast(w);
      const notExcel = await post(w, body(item, { importSource: "manual" }));
      expect(notExcel.status).toBe(400);
      expect(notExcel.body.message).toMatch(/parsed Excel container/);
      const supplier = await post(w, body(item, { supplierId: 7 }));
      expect(supplier.status).toBe(400);
      expect(supplier.body.message).toMatch(/must not have a supplier/);
      // An empty-string or zero supplier is treated as "no supplier".
      const blank = await post(w, body(item, { supplierId: "", invoiceTotalUsd: "0" }));
      expect(blank.status).toBe(400);
      expect(blank.body.message).toMatch(/Invalid invoice total/);
      const zero = await post(w, body(item, { supplierId: 0, discountPct: "101" }));
      expect(zero.status).toBe(400);
      expect(zero.body.message).toMatch(/Invalid invoice total or discount/);
      expect(await containers(w)).toEqual([]);
    }));

  it("refuses a company without Golden Coast capital accounts", () =>
    withFactoryWorld(async (w) => {
      const { item } = await goldenCoast(w, { capital: false });
      const res = await post(w, body(item));
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("GC_PHASE8_NOT_CONFIGURED");
    }));

  it("refuses a missing or ambiguous OTW clearing account", () =>
    withFactoryWorld(async (w) => {
      const { item } = await goldenCoast(w, { clearing: 0 });
      const none = await post(w, body(item));
      expect(none.status).toBe(409);
      expect(none.body.code).toBe("GC_PHASE8_ROLES_INVALID");
      await w.q(
        `INSERT INTO ledger_accounts (company_id, code, name, account_type, sub_type)
         VALUES ($1, $2::varchar, $2::text, 'Liability', 'sp_otw_clearing'),
                ($1, $3::varchar, $3::text, 'Liability', 'sp_otw_clearing')`,
        [w.companyId, `${w.tag}C1`, `${w.tag}C2`]
      );
      const two = await post(w, body(item));
      expect(two.status).toBe(409);
      expect(two.body.message).toMatch(/Exactly one active GC Goods OTW Clearing/);
      expect(await containers(w)).toEqual([]);
    }));

  it("refuses another company's stock item, bad fees and an unreconciled total", () =>
    withFactoryWorld(async (w) => {
      const { item } = await goldenCoast(w);
      const other = await w.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
        `${w.tag}O`,
      ]);
      const foreign = await w.one(
        `INSERT INTO stock_items (company_id, code, name, uom) VALUES ($1, $2, 'Foreign', 'pcs') RETURNING id`,
        [other, `${w.tag}FI`]
      );
      const foreignRes = await post(w, body(foreign));
      expect(foreignRes.status).toBe(400);
      expect(foreignRes.body.code).toBe("GC_PHASE8_STOCK_ITEM_INVALID");
      const negativePct = await post(w, body(item, { discountPct: "-1" }));
      expect(negativePct.status).toBe(400);
      const fee = await post(w, body(item, { surchargeUsd: "-2" }));
      expect(fee.status).toBe(400);
      expect(fee.body.message).toMatch(/fees cannot be negative/);
      const mismatch = await post(w, body(item, { invoiceTotalUsd: "250" }));
      expect(mismatch.status).toBe(409);
      expect(mismatch.body.code).toBe("GC_PHASE8_INVOICE_TOTAL_MISMATCH");
      const invalid = await post(w, body(item, { lines: [] }));
      expect(invalid.status).toBe(400);
      expect(await containers(w)).toEqual([]);
    }));
});

describe("Fresh Start Excel import posting", () => {
  it("posts the funding voucher, replays the same key and refuses a duplicate container", () =>
    withFactoryWorld(async (w) => {
      const { item, otw, clearing } = await goldenCoast(w);
      const key = `${w.tag}-FIRST`;
      const res = await post(w, body(item), key);
      expect(res.status, res.text).toBe(200);
      expect(res.body.replayed).toBe(false);
      expect(res.body.container).toMatchObject({ supplierId: null, invoiceTotalUsd: "190.0000" });
      expect(res.body.lines).toHaveLength(1);
      const voucherId = Number(res.body.posting.voucher.id);
      const entries = await w.q(
        `SELECT ledger_account_id, debit_amount::numeric::text AS dr, credit_amount::numeric::text AS cr
           FROM voucher_entries WHERE voucher_id = $1 ORDER BY debit_amount DESC`,
        [voucherId]
      );
      expect(entries.map((e) => [e.ledger_account_id, Number(e.dr), Number(e.cr)])).toEqual([
        [otw, 190, 0],
        [clearing[0], 0, 190],
      ]);

      await forgetRequestGuard(w, key);
      const replay = await post(w, body(item), key);
      expect(replay.status).toBe(200);
      expect(replay.body.posting.replayed).toBe(true);
      expect(replay.body.replayed).toBe(true);
      expect(replay.body.container.id).toBe(res.body.container.id);

      const duplicate = await post(w, body(item, { invoiceNumber: "FS-INV-2" }));
      expect(duplicate.status).toBe(409);
      expect(duplicate.body.code).toBe("GC_PHASE8_DUPLICATE_CONTAINER");
      expect(await containers(w)).toHaveLength(1);
    }));

  it("reports a replayed voucher whose container document is gone as corrupt", () =>
    withFactoryWorld(async (w) => {
      const { item } = await goldenCoast(w);
      const key = `${w.tag}-GONE`;
      const first = await post(w, body(item, { containerNumber: "" }), key);
      expect(first.status, first.text).toBe(200);
      expect(first.body.container.containerNumber).toBeNull();
      await w.q(`DELETE FROM sp_container_lines WHERE company_id = $1`, [w.companyId]);
      await w.q(`DELETE FROM sp_containers WHERE company_id = $1`, [w.companyId]);
      expect(await containers(w)).toEqual([]);
      await forgetRequestGuard(w, key);
      const replay = await post(w, body(item, { containerNumber: "" }), key);
      expect(replay.status).toBe(409);
      expect(replay.body.code).toBe("GC_PHASE8_IDEMPOTENCY_CORRUPT");
    }));
});
