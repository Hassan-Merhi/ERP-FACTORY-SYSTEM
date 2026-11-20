/**
 * GET /api/factory/customer-orders/:id/loading-status-export: the loading
 * status workbook comparing proforma quantities with loaded bales. Pins the
 * status of each article (loaded, over, less, not loaded, not requested), the
 * article/name fallbacks, and company isolation.
 */
import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const url = (id: number | string) => `/api/factory/customer-orders/${id}/loading-status-export`;

async function workbookRows(w: FactoryWorld, orderId: number) {
  const res = await w.agent
    .get(url(orderId))
    .buffer(true)
    .parse((response, done) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => done(null, Buffer.concat(chunks)));
    });
  expect(res.status).toBe(200);
  expect(res.headers["content-type"]).toContain("spreadsheetml");
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(new Uint8Array(res.body as Buffer).buffer as ArrayBuffer);
  const values: string[][] = [];
  book.worksheets.forEach((sheet) =>
    sheet.eachRow((row) => values.push((row.values as unknown[]).slice(1).map((value) => String(value ?? ""))))
  );
  return values;
}

async function order(
  w: FactoryWorld,
  opts: { proformaId?: number | null; invoice?: string | null; date?: string | null } = {}
) {
  const customerId = await w.one(
    `INSERT INTO customers (company_id, code, legal_name) VALUES ($1, $2, 'Loading Customer') RETURNING id`,
    [w.companyId, `${w.tag}C${Math.floor(Math.random() * 1e6)}`]
  );
  return w.one(
    `INSERT INTO customer_orders (company_id, customer_id, order_date, status, location_id, proforma_id_used, invoice_number, container_number)
     VALUES ($1, $2, $3, 'LOADING', $4, $5, $6, $7) RETURNING id`,
    [
      w.companyId,
      customerId,
      opts.date ?? "2026-06-01",
      w.locationId,
      opts.proformaId ?? null,
      opts.invoice ?? null,
      opts.invoice ? "MSCU1234567" : null,
    ]
  );
}

async function load(
  w: FactoryWorld,
  orderId: number,
  b: {
    productId?: number | null;
    baleArticle?: string | null;
    orderArticle?: string | null;
    name?: string | null;
    ref?: string;
  }
) {
  const ref = b.ref ?? `${w.tag}-${Math.floor(Math.random() * 1e9)}`;
  const baleId = await w.one(
    `INSERT INTO factory_bales (company_id, reference_number, bale_code, product_id, article_code, product_name, status)
     VALUES ($1, $2, $2, $3, $4, $5, 'RESERVED_FOR_ORDER') RETURNING id`,
    [w.companyId, ref, b.productId ?? null, b.baleArticle ?? null, b.name ?? null]
  );
  await w.q(
    `INSERT INTO customer_order_bales (order_id, bale_id, bale_reference, location_id, weight, price_used, article_code, bale_name)
     VALUES ($1, $2, $3, $4, 25, 10, $5, $6)`,
    [orderId, baleId, ref, w.locationId, b.orderArticle ?? null, b.name ?? null]
  );
}

describe("loading status export", () => {
  it("refuses bad ids, missing orders and another company's order", async () => {
    await withFactoryWorld(async (w) => {
      expect((await w.agent.get(url("abc"))).status).toBe(400);
      expect((await w.agent.get(url(2147483000))).status).toBe(404);
      const other = await w.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
        `${w.tag}X`,
      ]);
      const otherCustomer = await w.one(
        `INSERT INTO customers (company_id, code, legal_name) VALUES ($1, $2, 'Other') RETURNING id`,
        [other, `${w.tag}OC`]
      );
      const foreign = await w.one(
        `INSERT INTO customer_orders (company_id, customer_id, order_date, status) VALUES ($1, $2, '2026-06-01', 'LOADING') RETURNING id`,
        [other, otherCustomer]
      );
      expect((await w.agent.get(url(foreign))).status).toBe(404);
    });
  });

  it("classifies every proforma article against loaded bales", async () => {
    await withFactoryWorld(async (w) => {
      const customerId = await w.one(
        `INSERT INTO customers (company_id, code, legal_name) VALUES ($1, $2, 'Proforma Customer') RETURNING id`,
        [w.companyId, `${w.tag}PC`]
      );
      const proformaId = await w.one(
        `INSERT INTO customer_proformas (company_id, customer_id, name) VALUES ($1, $2, 'PF') RETURNING id`,
        [w.companyId, customerId]
      );
      const lines: Array<[string, number, string]> = [
        ["ART-EXACT", 1, "Exact"],
        ["ART-OVER", 1, "Over"],
        ["ART-LESS", 3, "Less"],
        ["ART-NONE", 2, "Never Loaded"],
      ];
      for (const [code, qty, name] of lines) {
        await w.q(
          `INSERT INTO customer_proforma_lines (proforma_id, article_code, quantity, price_per_bale, product_name) VALUES ($1, $2, $3, 10, $4)`,
          [proformaId, code, qty, name]
        );
      }
      const product = await w.one(
        `INSERT INTO factory_bale_products (company_id, code, name, article_code) VALUES ($1, $2, 'Canonical Exact', 'ART-EXACT') RETURNING id`,
        [w.companyId, `${w.tag}PX`]
      );
      await w.q(
        `INSERT INTO factory_bale_products (company_id, code, name, article_code) VALUES ($1, $2, 'Catalog None', 'ART-NONE')`,
        [w.companyId, `${w.tag}PN`]
      );
      const orderId = await order(w, { proformaId, invoice: "INV-77" });
      await load(w, orderId, { productId: product });
      await load(w, orderId, { baleArticle: "ART-OVER", name: "Over bale" });
      await load(w, orderId, { orderArticle: "ART-OVER" });
      await load(w, orderId, { baleArticle: "ART-LESS" });
      await load(w, orderId, { orderArticle: "ART-EXTRA", name: "Extra bale" });
      await load(w, orderId, {});

      const rows = await workbookRows(w, orderId);
      const flat = rows.map((row) => row.join("|"));
      const statusOf = (code: string) =>
        rows.find((row) => row.includes(code) && row.some((cell) => /LOADED|REQUESTED/.test(cell)));
      expect(statusOf("ART-EXACT")).toEqual(expect.arrayContaining(["Canonical Exact", "LOADED"]));
      expect(statusOf("ART-OVER")).toEqual(expect.arrayContaining(["OVERLOADED", "+1"]));
      expect(statusOf("ART-LESS")).toEqual(expect.arrayContaining(["LESS LOADED", "-2"]));
      expect(statusOf("ART-NONE")).toEqual(expect.arrayContaining(["Catalog None", "NOT LOADED"]));
      expect(statusOf("ART-EXTRA")).toEqual(expect.arrayContaining(["Extra bale", "NOT REQUESTED"]));
      expect(flat.some((line) => line.includes("INV-77"))).toBe(true);
      expect(flat.some((line) => line.includes("MSCU1234567"))).toBe(true);
    });
  });

  it("marks every loaded article LOADED when the order has no proforma, with default header values", async () => {
    await withFactoryWorld(async (w) => {
      const orderId = await order(w, { proformaId: null, invoice: null });
      await load(w, orderId, { baleArticle: "ART-ONLY" });
      await load(w, orderId, { baleArticle: "ART-ONLY" });
      const rows = await workbookRows(w, orderId);
      const flat = rows.map((row) => row.join("|"));
      expect(rows.find((row) => row.includes("ART-ONLY") && row.includes("LOADED"))).toBeDefined();
      expect(flat.some((line) => line.includes(`INV-${String(orderId).padStart(6, "0")}`))).toBe(true);
      expect(flat.some((line) => line.includes("NOT REQUESTED"))).toBe(true); // legend only
    });
  });
});
