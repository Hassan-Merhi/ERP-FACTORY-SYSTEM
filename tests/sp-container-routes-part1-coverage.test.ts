/**
 * Supplier Partner container routes (list, create, Excel parse and validate)
 * through the real app in one rolled-back transaction: non supplier-partner
 * companies, missing fields and chart of accounts, override accounts of
 * another company, Excel-only refusals, a manual container with lines and its
 * Goods OTW voucher, a zero-total container with no voucher, the Excel parse
 * (no file, empty, row errors, a parsed container) and the validate preflight.
 */
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const BASE = "/api/sp/containers";
let seq = 0;

async function account(w: FactoryWorld, subType: string, type: string, companyId = w.companyId) {
  return w.one(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type, sub_type) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [companyId, `${w.tag}-A${++seq}`, `${subType} ${seq}`, type, subType]
  );
}

async function spWorld(work: (w: FactoryWorld, a: { otw: number; clearing: number }) => Promise<void>, chart = true) {
  await withFactoryWorld(async (w) => {
    await w.q(`UPDATE companies SET company_type = 'supplier_partner' WHERE id = $1`, [w.companyId]);
    const a = { otw: 0, clearing: 0 };
    if (chart) {
      a.otw = await account(w, "sp_goods_otw", "Asset");
      a.clearing = await account(w, "sp_otw_clearing", "Liability");
    }
    await work(w, a);
  });
}

const otherCompany = (w: FactoryWorld) =>
  w.one(
    `INSERT INTO companies (code, name, company_type) VALUES ($1::varchar, $1::text, 'supplier_partner') RETURNING id`,
    [`${w.tag}O${++seq}`]
  );

const manual = { supplierName: "Acme", invoiceNumber: "INV-1", invoiceDate: "2026-06-01" };

const vouchers = async (w: FactoryWorld) =>
  (await w.q(`SELECT count(*)::int AS n FROM vouchers WHERE company_id = $1`, [w.companyId]))[0].n;

async function workbook(rows: Array<Record<string, unknown>>): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("PO");
  const headers = [
    "Container_Number",
    "PO_Number",
    "Supplier_Code",
    "Item_Barcode",
    "Item_Name",
    "Quantity",
    "Rate",
    "Charge_Type",
    "Charge_Amount",
  ];
  ws.addRow(headers);
  for (const row of rows) ws.addRow(headers.map((h) => row[h] ?? null));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe("SP containers list and create", () => {
  it("refuses non supplier-partner companies and lists only this company's containers", async () => {
    await withFactoryWorld(async (w) => {
      expect((await w.agent.get(BASE)).status).toBe(403);
      expect((await w.agent.post(BASE).send(manual)).status).toBe(403);
    });
    await spWorld(async (w) => {
      const empty = await w.agent.get(BASE);
      expect([empty.status, empty.body]).toEqual([200, []]);
    });
  });

  it("refuses missing fields, a missing chart and foreign or Excel override accounts", async () => {
    await spWorld(async (w) => {
      expect((await w.agent.post(BASE).send({ ...manual, supplierName: "" })).status).toBe(400);
      const noChart = await w.agent.post(BASE).send(manual);
      expect(noChart.body.message).toMatch(/Chart of accounts not set up/);
    }, false);
    await spWorld(async (w) => {
      const other = await otherCompany(w);
      const foreignOtw = await account(w, "sp_goods_otw", "Asset", other);
      const badOtw = await w.agent.post(BASE).send({ ...manual, invoiceTotalUsd: "10", otwAccountId: foreignOtw });
      expect([badOtw.status, badOtw.body.message]).toEqual([400, "Goods OTW account not found for this company"]);
      const badClr = await w.agent
        .post(BASE)
        .send({ ...manual, invoiceTotalUsd: "10", otwClearingAccountId: foreignOtw });
      expect([badClr.status, badClr.body.message]).toEqual([400, "OTW Clearing account not found for this company"]);
      const excelOverride = await w.agent
        .post(BASE)
        .send({ ...manual, importSource: "excel", otwAccountId: foreignOtw });
      expect(excelOverride.body.message).toMatch(/Excel imports must use/);
      const excelInvalid = await w.agent.post(BASE).send({ ...manual, importSource: "excel" });
      expect([excelInvalid.status, excelInvalid.body.code]).toEqual([400, "SP_EXCEL_IMPORT_INVALID"]);
      expect(await w.q(`SELECT 1 FROM sp_containers WHERE company_id = $1`, [w.companyId])).toHaveLength(0);
      expect(await vouchers(w)).toBe(0);
    });
  });

  it("creates a container with lines and its Goods OTW voucher, using override accounts", async () => {
    await spWorld(async (w) => {
      const customOtw = await account(w, "sp_goods_otw_alt", "Asset");
      const customClr = await account(w, "sp_otw_clearing_alt", "Liability");
      const res = await w.agent.post(BASE).send({
        ...manual,
        containerNumber: "MSKU1",
        invoiceTotalUsd: "250.50",
        discountPct: "5",
        freightEstimateUsd: "40",
        notes: "first",
        otwAccountId: String(customOtw),
        otwClearingAccountId: String(customClr),
        lines: [
          { articleCode: "ART-A", description: "Cream", qty: "10", unitRateUsd: "20" },
          { articleCode: "ART-B", qty: "5", unitRateUsd: "10.1" },
        ],
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ invoiceTotalUsd: "250.5000", status: "open", containerNumber: "MSKU1" });
      const legs = await w.q<{ ledger_account_id: number; debit: string; credit: string }>(
        `SELECT ve.ledger_account_id, ve.debit_amount::text AS debit, ve.credit_amount::text AS credit
           FROM voucher_entries ve JOIN sp_containers c ON c.goods_otw_voucher_id = ve.voucher_id
          WHERE c.id = $1 ORDER BY ve.id`,
        [res.body.id]
      );
      expect(legs.map((l) => [l.ledger_account_id, Number(l.debit), Number(l.credit)])).toEqual([
        [customOtw, 250.5, 0],
        [customClr, 0, 250.5],
      ]);
      const listed = await w.agent.get(BASE);
      expect(listed.body).toHaveLength(1);
      expect(listed.body[0]).toMatchObject({ totalQty: 15 });
      expect(listed.body[0].lines).toHaveLength(2);
    });
  });

  it("imports a validated Excel container and refuses the same container number again", async () => {
    await spWorld(async (w) => {
      const supplierId = await w.one(
        `INSERT INTO suppliers (company_id, code, legal_name, email) VALUES ($1, $2, 'Excel Supplier', '') RETURNING id`,
        [w.companyId, `${w.tag}-ES`]
      );
      const body = {
        importSource: "excel",
        supplierId,
        supplierName: "Excel Supplier",
        containerNumber: "XLSU1",
        invoiceNumber: "PO-X1",
        invoiceDate: "2026-06-01",
        invoiceTotalUsd: "110",
        freightEstimateUsd: "10",
        lines: [{ articleCode: "ART-A", qty: "4", unitRateUsd: "25" }],
      };
      const res = await w.agent.post(BASE).send(body);
      expect(res.status).toBe(200);
      expect(res.body.supplierId).toBe(supplierId);
      expect(await vouchers(w)).toBe(1);
      const again = await w.agent.post(BASE).send({ ...body, invoiceNumber: "PO-X2" });
      expect([again.status, again.body.code]).toEqual([400, "SP_EXCEL_IMPORT_INVALID"]);
      expect(await vouchers(w)).toBe(1);
    });
  });

  it("refuses another company's supplierId on a manual container and saves nothing", async () => {
    await spWorld(async (w) => {
      const other = await otherCompany(w);
      const foreignSupplier = await w.one(
        `INSERT INTO suppliers (company_id, code, legal_name, email) VALUES ($1, $2, 'Foreign', '') RETURNING id`,
        [other, `${w.tag}-FS`]
      );
      for (const invoiceTotalUsd of ["10", undefined]) {
        const res = await w.agent.post(BASE).send({ ...manual, supplierId: foreignSupplier, invoiceTotalUsd });
        expect([res.status, res.body.message]).toEqual([404, "Supplier not found"]);
      }
      const bad = await w.agent.post(BASE).send({ ...manual, supplierId: "abc" });
      expect(bad.status).toBe(404);
      expect(await vouchers(w)).toBe(0);
      expect(await w.q(`SELECT 1 FROM sp_containers WHERE company_id = $1`, [w.companyId])).toHaveLength(0);

      const ownSupplier = await w.one(
        `INSERT INTO suppliers (company_id, code, legal_name, email) VALUES ($1, $2, 'Own', '') RETURNING id`,
        [w.companyId, `${w.tag}-OS`]
      );
      const ok = await w.agent.post(BASE).send({ ...manual, supplierId: String(ownSupplier) });
      expect(ok.status).toBe(200);
      expect(ok.body.supplierId).toBe(ownSupplier);
    });
  });

  it("creates a zero-total container without a voucher", async () => {
    await spWorld(async (w) => {
      const res = await w.agent.post(BASE).send({ ...manual, supplierId: "", lines: [] });
      expect(res.status).toBe(200);
      expect(res.body.goodsOtwVoucherId ?? null).toBeNull();
      expect(await vouchers(w)).toBe(0);
    });
  });
});

describe("SP container Excel parse and validate", () => {
  const parse = (w: FactoryWorld, file?: Buffer) => {
    const req = w.agent.post(`${BASE}/import-excel/parse`);
    return file ? req.attach("file", file, "po.xlsx") : req;
  };

  it("refuses a missing, empty or invalid workbook", async () => {
    await spWorld(async (w) => {
      expect((await parse(w)).body.message).toBe("No file uploaded");
      expect((await parse(w, await workbook([]))).body.message).toBe("Excel file is empty");
      const bad = await parse(
        w,
        await workbook([{ Container_Number: "C1", Item_Name: "Cotton", Quantity: 0, Rate: 1 }])
      );
      expect([bad.status, bad.body.message]).toEqual([400, "Validation errors"]);
      expect(bad.body.errors[0]).toMatch(/Quantity must be a non-zero number/);
      const noItems = await parse(
        w,
        await workbook([{ Container_Number: "C1", Charge_Type: "Freight", Charge_Amount: 5 }])
      );
      expect(noItems.body.message).toBe("No valid item rows found");
    });
  });

  it("parses a container with its supplier and charges, and validates a request", async () => {
    await spWorld(async (w) => {
      const supplierId = await w.one(
        `INSERT INTO suppliers (company_id, code, legal_name, email) VALUES ($1, 'SUPX', 'Supplier X', '') RETURNING id`,
        [w.companyId]
      );
      const file = await workbook([
        {
          Container_Number: "MSKU9",
          PO_Number: "PO-9",
          Supplier_Code: "SUPX",
          Item_Name: "Cotton",
          Quantity: 4,
          Rate: 25,
        },
        { Container_Number: "MSKU9", Charge_Type: "Freight", Charge_Amount: 30 },
      ]);
      const res = await parse(w, file);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ fileName: "po.xlsx", rowCount: 2, freshStartOtwSource: false });
      expect(res.body.containers).toEqual([
        expect.objectContaining({ containerNumber: "MSKU9", supplierId, itemsTotal: 100 }),
      ]);

      const validation = await w.agent.post(`${BASE}/import-excel/validate`).send({});
      expect(validation.status).toBe(200);
      expect(validation.body.errors).toEqual(
        expect.arrayContaining(["Select a valid supplier.", "Container number is required."])
      );
    });
  });
});
