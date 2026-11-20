/**
 * Supplier Profit Check workbook exports
 * (server/routes/supplier-profit-check/export.ts) over HTTP against
 * PostgreSQL, one rolled-back company per test; the returned workbook is read
 * back with ExcelJS.
 *
 * Pinned: the internal analysis refuses a missing or oversized row list,
 * derives landing cost, profit, profit % and status (gaining, losing,
 * break-even, no sales data) when the client sends none, keeps values the
 * client did send, clamps negative quantities and extras, and totals only the
 * ordered quantities. The supplier proforma export refuses a bad id and
 * another company's proforma.
 */
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import { withFactoryWorld } from "./helpers/rolledBackFactoryApp";
import { otherCompany } from "./helpers/voucherReadFixture";

const INTERNAL = "/api/supplier-profit-check/export-internal";

async function readSheet(body: Buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(body);
  const sheet = workbook.getWorksheet("Analysis")!;
  const rows: unknown[][] = [];
  sheet.eachRow((row) => rows.push((row.values as unknown[]).slice(1)));
  return rows;
}

const binary = (
  res: { on: (event: string, cb: (chunk?: Buffer) => void) => void },
  cb: (e: null, b: Buffer) => void
) => {
  const chunks: Buffer[] = [];
  res.on("data", (chunk?: Buffer) => chunks.push(chunk!));
  res.on("end", () => cb(null, Buffer.concat(chunks)));
};

describe("internal profit analysis export", () => {
  it("refuses a missing or oversized row list", () =>
    withFactoryWorld(async (w) => {
      expect((await w.agent.post(INTERNAL).send({})).status).toBe(400);
      const many = Array.from({ length: 10001 }, () => ({}));
      const res = await w.agent.post(INTERNAL).send({ rows: many });
      expect(res.status).toBe(400);
      expect(res.body.message).toBe("Too many rows to export");
    }));

  it("derives missing figures, keeps supplied ones and totals ordered quantities", () =>
    withFactoryWorld(async (w) => {
      const res = await w.agent
        .post(INTERNAL)
        .send({
          supplierName: "Acme",
          rows: [
            {
              code: "G",
              name: "Gain",
              qty: 2,
              avgSellingPrice: 30,
              poPrice: 10,
              extraCostPerBale: 5,
              configPrice: 25,
              inventoryAvgCost: 12,
            },
            {
              code: "L",
              name: "Loss",
              qty: "1",
              effectiveSellPrice: "10",
              effectivePoPrice: "12",
              extraCostPerBale: -3,
            },
            { code: "B", name: "Even", qty: -4, effectiveSellPrice: 10, landingCost: 10, poPriceSource: "override" },
            { code: "N", name: "None", qty: "", effectivePoPrice: 8 },
            { code: "Z", name: "ZeroSell", qty: 1, effectiveSellPrice: 0, landingCost: 0 },
            {
              code: "S",
              name: "Supplied",
              qty: 3,
              effectiveSellPrice: 20,
              landingCost: 15,
              costProfit: 4,
              costProfitPct: 50,
              computedStatus: "custom",
              hassanProfit: 7,
              salesQty: 9,
              currentStock: 11,
            },
          ],
        })
        .buffer(true)
        .parse(binary);
      expect(res.status).toBe(200);
      const rows = await readSheet(res.body as Buffer);
      expect(String(rows[0][0])).toBe("INTERNAL PROFIT ANALYSIS — Acme");
      expect(String(rows[1][0])).toContain("All Time → All Time   |   Proforma Ref: N/A");
      const byCode = new Map(rows.slice(3).map((r) => [r[0], r]));
      // Gain: landing 10 + 5 = 15, profit 15, 50 %, hassan 25 - 12 = 13.
      expect(byCode.get("G")!.slice(3, 17)).toEqual([30, 10, 5, 15, 15, 50, "gaining", 2, 30, 60, 30, 12, 25, 13]);
      expect(byCode.get("L")!.slice(5, 10)).toEqual([0, 12, -2, -20, "losing"]);
      expect(byCode.get("B")!.slice(9, 11)).toEqual(["break_even", 0]);
      expect(byCode.get("B")![18]).toBe("override");
      expect(byCode.get("N")!.slice(3, 10)).toEqual(["", 8, 0, 8, "", "", "no_sales_data"]);
      expect(byCode.get("N")![18]).toBe("missing");
      expect(byCode.get("Z")!.slice(7, 10)).toEqual([0, "", "break_even"]);
      expect(byCode.get("S")!.slice(2, 18)).toEqual([9, 20, "", 0, 15, 4, 50, "custom", 3, 45, 60, 12, 0, 0, 7, 11]);
      const totals = rows[rows.length - 1];
      expect(totals.slice(0, 2)).toEqual(["TOTALS", "4 items"]);
      expect(totals.slice(10, 14)).toEqual([7, 30 + 12 + 0 + 45, 60 + 10 + 0 + 60, 30 - 2 + 0 + 12]);
    }));
});

describe("supplier proforma export", () => {
  it("refuses a bad id and another company's proforma", () =>
    withFactoryWorld(async (w) => {
      expect((await w.agent.get("/api/supplier-profit-check/proforma/abc/export-supplier")).status).toBe(400);
      const other = await otherCompany(w);
      const supplier = await w.one(
        `INSERT INTO suppliers (company_id, code, legal_name, email) VALUES ($1, $2, 'Foreign', 'x@example.test') RETURNING id`,
        [other, `${w.tag}FS`]
      );
      const proforma = await w.one(
        `INSERT INTO supplier_proformas (company_id, supplier_id, reference) VALUES ($1, $2, 'F') RETURNING id`,
        [other, supplier]
      );
      const res = await w.agent.get(`/api/supplier-profit-check/proforma/${proforma}/export-supplier`);
      expect(res.status).toBe(404);
    }));

  it("exports the proforma's resolved lines with a grand total", () =>
    withFactoryWorld(async (w) => {
      const supplier = await w.one(
        `INSERT INTO suppliers (company_id, code, legal_name, email) VALUES ($1, $2, 'Acme Ltd', 'x@example.test') RETURNING id`,
        [w.companyId, `${w.tag}S`]
      );
      await w.q(`INSERT INTO stock_items (company_id, code, name, uom) VALUES ($1, $2, 'Canonical Shirts', 'PCS')`, [
        w.companyId,
        `${w.tag}A`,
      ]);
      const proforma = await w.one(
        `INSERT INTO supplier_proformas (company_id, supplier_id, reference) VALUES ($1, $2, 'PF-9') RETURNING id`,
        [w.companyId, supplier]
      );
      await w.q(
        `INSERT INTO supplier_proforma_lines (proforma_id, barcode, item_name, qty, weight_per_bale, price_per_bale)
         VALUES ($1, $2, 'Typed name', 2, 0, 10), ($1, 'RAW', 'Raw line', 3, 0, 4), ($1, 'FREE', 'Free', 1, 0, 0)`,
        [proforma, `${w.tag}a`]
      );
      const res = await w.agent
        .get(`/api/supplier-profit-check/proforma/${proforma}/export-supplier`)
        .buffer(true)
        .parse(binary);
      expect(res.status).toBe(200);
      expect(res.headers["content-disposition"]).toContain("proforma-PF-9.xlsx");
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(res.body as Buffer);
      const rows: unknown[][] = [];
      workbook.getWorksheet("Proforma")!.eachRow((row) => rows.push((row.values as unknown[]).slice(1)));
      expect(rows.slice(4)).toEqual([
        ["FREE", "Free", 1, 0, 0],
        ["RAW", "Raw line", 3, 4, 12],
        [`${w.tag}A`, "Canonical Shirts", 2, 10, 20],
        ["", "GRAND TOTAL", 6, "", 32],
      ]);
    }));
});
