/**
 * Canonical factory invoice rendering variants (buildCanonicalInvoicePdf and
 * buildCanonicalInvoiceExcel): Arabic right-to-left and French labels, hidden
 * selling prices, charges hidden or summarised (named, unnamed, total only,
 * no freight), CFA and unknown currency symbols, mixed pricing modes,
 * dispatch trips, blank header fields and multi-page tables; plus the
 * snapshot readers for an order that does not exist.
 */
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import {
  buildCanonicalInvoiceExcel,
  buildCanonicalInvoicePdf,
  currencySymbol,
  freezeCanonicalInvoiceDocument,
  getCanonicalInvoiceDocument,
  type CanonicalInvoiceDocument,
} from "../server/services/factoryInvoiceDocumentService";
import { withFactoryWorld } from "./helpers/rolledBackFactoryApp";

type Line = CanonicalInvoiceDocument["lines"][number];

const line = (i: number, patch: Partial<Line> = {}): Line => ({
  articleCode: `GS${1000 + i}`,
  productName: `PRODUCT ${i} WITH A LONG DESCRIPTIVE NAME THAT WRAPS ACROSS LINES`,
  productNameAr: `منتج ${i}`,
  productNameFr: `Produit ${i}`,
  category: i % 2 ? "Cream Summer" : "Mixed Winter",
  categoryAr: "فئة",
  categoryFr: "Catégorie",
  qty: 2,
  weightPerBale: 45,
  totalWeight: 90,
  pricingMode: "per_bale",
  pricePerBale: 120,
  pricePerKg: 0,
  unitPrice: 120,
  totalPrice: 240,
  ...patch,
});

const invoice = (patch: Partial<CanonicalInvoiceDocument> = {}): CanonicalInvoiceDocument => ({
  version: 1,
  orderId: 11953,
  companyId: 1,
  invoiceNumber: "INV-011953",
  orderDate: "2026-09-19",
  status: "PARTIALLY_DISPATCHED",
  customerName: "HASSAN DAKIK CLIENT",
  customerCode: "HDC",
  baseCurrency: "USD",
  containerNumber: "TCNU3846298",
  destination: "MALI",
  shippingCompany: "",
  subtotalBales: 480,
  freightAmount: 0,
  otherChargesTotal: 0,
  grandTotal: 480,
  totalQtyBales: 4,
  lines: [line(1), line(2)],
  charges: [],
  frozenAt: "2026-09-19T12:00:00.000Z",
  ...patch,
});

const pages = (buffer: Buffer) => (buffer.toString("latin1").match(/\/Type \/Page\b/g) ?? []).length;

async function sheetOf(buffer: Buffer) {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(buffer as unknown as ArrayBuffer);
  const sheet = book.worksheets[0];
  const text: string[] = [];
  sheet.eachRow((row) => row.eachCell((cell) => text.push(String(cell.value ?? ""))));
  return { sheet, text };
}

describe("currencySymbol", () => {
  it("maps known codes and falls back to the code itself", () => {
    expect(currencySymbol("xof")).toBe("CFA");
    expect(currencySymbol("GBP")).toBe("£");
    expect(currencySymbol("ZMW")).toBe("ZMW");
    expect(currencySymbol(null)).toBe("$");
  });
});

describe("buildCanonicalInvoicePdf", () => {
  it("renders an Arabic, multi-page CFA invoice with every charge kind and dispatch trips", async () => {
    const lines = Array.from({ length: 70 }, (_, i) =>
      line(i, i % 3 === 0 ? { pricingMode: "per_kg", pricePerKg: 2, unitPrice: 2, totalPrice: 180 } : {})
    );
    const { buffer, fileName } = await buildCanonicalInvoicePdf(
      invoice({
        baseCurrency: "CFA",
        lines,
        freightAmount: 50,
        charges: [
          { id: 1, name: "", amount: 10, chargeType: "OTHER" },
          { id: 2, name: "Clearance", amount: 20, chargeType: "OTHER" },
          { id: 3, name: "Freight", amount: 50, chargeType: "FREIGHT" },
        ],
        dispatchTrips: [{ dispatchNumber: 4 }, { dispatchNumber: 12 }] as CanonicalInvoiceDocument["dispatchTrips"],
      }),
      { language: "ar" }
    );
    expect(buffer.subarray(0, 4).toString("ascii")).toBe("%PDF");
    expect(pages(buffer)).toBeGreaterThan(2);
    expect(fileName).toMatch(/\.pdf$/);
  });

  it("renders French, hidden-price and charge-free variants with blank header fields", async () => {
    const blank = invoice({
      customerName: "",
      orderDate: "",
      containerNumber: "",
      destination: "",
      baseCurrency: "ZMW",
    });
    await buildCanonicalInvoiceExcel({ ...blank, baseCurrency: "ABCD" });
    for (const options of [
      { language: "fr" as const },
      { hideSelling: true },
      { noCharges: true },
      { language: "en" as const },
    ]) {
      const { buffer } = await buildCanonicalInvoicePdf({ ...blank, otherChargesTotal: 15, grandTotal: 495 }, options);
      expect(buffer.subarray(0, 4).toString("ascii")).toBe("%PDF");
    }
    const hidden = await buildCanonicalInvoicePdf(invoice({ lines: Array.from({ length: 60 }, (_, i) => line(i)) }), {
      hideSelling: true,
    });
    expect(pages(hidden.buffer)).toBeGreaterThan(1);
  });
});

describe("buildCanonicalInvoiceExcel", () => {
  it("writes summary rows for named, unnamed and freight charges in CFA", async () => {
    const { buffer, fileName } = await buildCanonicalInvoiceExcel(
      invoice({
        baseCurrency: "CFA",
        freightAmount: 50,
        charges: [
          { id: 1, name: "", amount: 10, chargeType: "OTHER" },
          { id: 2, name: "Clearance", amount: 20, chargeType: "OTHER" },
        ],
        dispatchTrips: [{ dispatchNumber: 7 }] as CanonicalInvoiceDocument["dispatchTrips"],
        lines: [line(1), line(2, { pricingMode: "per_kg", pricePerKg: 2, unitPrice: 2, totalPrice: 180 })],
      }),
      { language: "en" }
    );
    expect(fileName).toMatch(/\.xlsx$/);
    const { text } = await sheetOf(buffer);
    expect(text).toEqual(expect.arrayContaining(["Clearance", "#007", "PARTIALLY DISPATCHED"]));
    expect(text.filter((value) => value === "Other Charges" || value === "Other charges").length).toBeGreaterThan(0);
  });

  it("writes Arabic right-to-left sheets, hides prices and charges on request and summarises total-only charges", async () => {
    const arabic = await sheetOf(
      (await buildCanonicalInvoiceExcel(invoice({ otherChargesTotal: 15 }), { language: "ar" })).buffer
    );
    expect(arabic.sheet.views[0]?.rightToLeft).toBe(true);

    const hidden = await sheetOf((await buildCanonicalInvoiceExcel(invoice(), { hideSelling: true })).buffer);
    const headerRow = (sheet: ExcelJS.Worksheet) => {
      let cells: string[] = [];
      sheet.eachRow((row) => {
        if (row.getCell(1).value === "#")
          cells = (row.values as unknown[]).filter((v) => v != null && v !== "").map(String);
      });
      return cells;
    };
    expect(headerRow(hidden.sheet)).toHaveLength(7);
    expect(headerRow(arabic.sheet)).toHaveLength(9);

    const noCharges = await sheetOf(
      (
        await buildCanonicalInvoiceExcel(invoice({ freightAmount: 9, baseCurrency: "ZMW" }), {
          noCharges: true,
          language: "fr",
        })
      ).buffer
    );
    const withCharges = await sheetOf(
      (await buildCanonicalInvoiceExcel(invoice({ freightAmount: 9, baseCurrency: "ZMW" }), { language: "fr" })).buffer
    );
    // The charge summary (subtotal, freight, grand total) is left out entirely.
    expect(withCharges.sheet.rowCount - noCharges.sheet.rowCount).toBeGreaterThanOrEqual(3);
  });
});

describe("canonical invoice snapshots", () => {
  it("returns null for an order that does not exist", async () => {
    expect(await getCanonicalInvoiceDocument(2_000_000_000, 2_000_000_000)).toBeNull();
    expect(await freezeCanonicalInvoiceDocument(2_000_000_000, 2_000_000_000)).toBeNull();
  });

  it("freezes a finalized order once, reuses the snapshot and serves drafts live", () =>
    withFactoryWorld(async (world) => {
      const customer = await world.one(
        `INSERT INTO customers (company_id, code, legal_name) VALUES ($1, $2, 'Snapshot Buyer') RETURNING id`,
        [world.companyId, `${world.tag}-C`]
      );
      const order = await world.one(
        `INSERT INTO customer_orders (company_id, customer_id, order_date, status, invoice_number, grand_total)
         VALUES ($1, $2, '2026-09-01', 'FINALIZED', $3, '0') RETURNING id`,
        [world.companyId, customer, `${world.tag}-INV`]
      );
      const snapshots = () =>
        world.q(`SELECT snapshot FROM factory_invoice_document_snapshots WHERE order_id = $1`, [order]);

      // A stored row that is not a canonical snapshot is ignored and not overwritten by a plain read.
      await world.q(
        `INSERT INTO factory_invoice_document_snapshots (order_id, company_id, snapshot, frozen_at, updated_at)
         VALUES ($1, $2, '{}'::jsonb, NOW(), NOW())`,
        [order, world.companyId]
      );
      const unfrozen = await getCanonicalInvoiceDocument(order, world.companyId);
      expect(unfrozen).toMatchObject({ orderId: order, invoiceNumber: `${world.tag}-INV`, status: "FINALIZED" });
      expect((await snapshots())[0].snapshot).toEqual({});

      const frozen = await freezeCanonicalInvoiceDocument(order, world.companyId);
      expect((await snapshots())[0].snapshot).toMatchObject({ version: 1, orderId: order });
      expect(await getCanonicalInvoiceDocument(order, world.companyId)).toEqual(frozen);

      await world.q(`DELETE FROM factory_invoice_document_snapshots WHERE order_id = $1`, [order]);
      const fresh = await getCanonicalInvoiceDocument(order, world.companyId);
      expect((await snapshots())[0].snapshot).toEqual(fresh);

      await world.q(`UPDATE customer_orders SET status = 'DRAFT' WHERE id = $1`, [order]);
      expect(await getCanonicalInvoiceDocument(order, world.companyId)).toMatchObject({ status: "DRAFT" });
      expect(await freezeCanonicalInvoiceDocument(order, world.companyId, false)).toMatchObject({ status: "DRAFT" });
      // Another company cannot read this order's invoice.
      expect(await getCanonicalInvoiceDocument(order, world.companyId + 100000)).toBeNull();
    }));
});
