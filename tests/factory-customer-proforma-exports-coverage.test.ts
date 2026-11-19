/**
 * Customer proforma Excel and PDF exports
 * (server/routes/factory/customer-proformas/exports.ts) against real rows in
 * one rolled-back transaction per test.
 *
 * Pinned: invalid ids and other-company proformas are refused; the Admin sees
 * prices; a user whose factory profile hides proforma prices gets the narrow
 * layout; canonical product names and weights come from the bale catalogue.
 */
import ExcelJS from "exceljs";
import type request from "supertest";
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

/** Collect a binary response body (ZIP/PDF/XLSX) as a Buffer. */
function binary(test: request.Test): request.Test {
  return test.buffer(true).parse((res, callback) => {
    const chunks: Buffer[] = [];
    res.on("data", (chunk: Buffer) => chunks.push(chunk));
    res.on("end", () => callback(null, Buffer.concat(chunks)));
  });
}

let seq = 0;
async function proforma(w: FactoryWorld, lineCount: number, companyId = w.companyId) {
  const customerId = await w.one(
    `INSERT INTO customers (company_id, code, legal_name) VALUES ($1, $2, 'Proforma Buyer') RETURNING id`,
    [companyId, `${w.tag}P${++seq}`]
  );
  const proformaId = await w.one(
    `INSERT INTO customer_proformas (company_id, customer_id, name, is_active) VALUES ($1, $2, 'Season PF', true) RETURNING id`,
    [companyId, customerId]
  );
  await w.q(
    `INSERT INTO factory_bale_products (company_id, code, name, article_code, weight_per_bale_kg)
     VALUES ($1, $2, 'Catalogue Rags', 'ART-CAT', 45.5)
     ON CONFLICT DO NOTHING`,
    [companyId, `${w.tag}BP${seq}`]
  );
  for (let i = 0; i < lineCount; i++) {
    const catalogued = i % 2 === 0;
    await w.q(
      `INSERT INTO customer_proforma_lines (proforma_id, article_code, product_name, quantity, price_per_bale)
       VALUES ($1, $2, $3, $4, $5)`,
      [proformaId, catalogued ? "ART-CAT" : `ART-${i}`, `Line ${i}`, 2 + i, catalogued ? "30" : "12.50"]
    );
  }
  return proformaId;
}

const excel = (agent: FactoryWorld["agent"], id: number | string) =>
  binary(agent.get(`/api/factory/customer-proformas/${id}/export/excel`));
const pdf = (agent: FactoryWorld["agent"], id: number | string) =>
  binary(agent.get(`/api/factory/customer-proformas/${id}/export/pdf`));

async function sheetText(body: Buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(body as unknown as ArrayBuffer);
  const sheet = workbook.getWorksheet("Proforma Invoice")!;
  const rows: string[][] = [];
  sheet.eachRow((row) => rows.push((row.values as unknown[]).slice(1).map((v) => (v == null ? "" : String(v)))));
  return rows;
}

/** A Manager of this company whose factory profile hides proforma prices. */
async function hiddenPriceAgent(w: FactoryWorld) {
  const agent = await w.agentFor("Manager");
  const [user] = await w.q<{ id: string }>(
    `SELECT u.id FROM users u JOIN user_company_roles r ON r.user_id = u.id
      WHERE r.company_id = $1 AND r.role = 'Manager' ORDER BY u.username DESC LIMIT 1`,
    [w.companyId]
  );
  await w.q(
    `INSERT INTO factory_user_profiles (company_id, user_id, display_name, hidden_cost_fields)
     VALUES ($1, $2, 'Hidden', ARRAY['hide_proforma_price'])`,
    [w.companyId, user.id]
  );
  return agent;
}

describe("customer proforma export refusals", () => {
  it("rejects an invalid id and another company's proforma for both formats", async () => {
    await withFactoryWorld(async (w) => {
      for (const route of ["excel", "pdf"]) {
        const bad = await w.agent.get(`/api/factory/customer-proformas/abc/export/${route}`);
        expect(bad.status).toBe(400);
      }
      const other = await w.one(
        `INSERT INTO companies (code, name, company_type, base_currency) VALUES ($1::varchar, $1::text, 'factory', 'USD') RETURNING id`,
        [`${w.tag}O`]
      );
      const foreign = await proforma(w, 1, other);
      for (const route of ["excel", "pdf"]) {
        const res = await w.agent.get(`/api/factory/customer-proformas/${foreign}/export/${route}`);
        expect(res.status).toBe(404);
        expect(res.body.message).toBe("Proforma not found");
      }
    });
  });
});

describe("customer proforma Excel export", () => {
  it("shows prices and catalogue names to an Admin", async () => {
    await withFactoryWorld(async (w) => {
      await w.q(`UPDATE companies SET base_currency = 'EUR' WHERE id = $1`, [w.companyId]);
      const id = await proforma(w, 3);
      const res = await excel(w.agent, id);
      expect(res.status).toBe(200);
      const rows = await sheetText(res.body as Buffer);
      const header = rows.find((r) => r[0] === "#")!;
      expect(header).toEqual([
        "#",
        "Article Code",
        "Product Name",
        "Qty (Bales)",
        "Kg / Bale",
        "Price / Bale",
        "Total KG",
        "Total Price",
      ]);
      const first = rows.find((r) => r[1] === "ART-CAT")!;
      expect(first.slice(2)).toEqual(["Catalogue Rags", "2", "45.50", "€30", "91", "€60"]);
      const uncatalogued = rows.find((r) => r[1] === "ART-1")!;
      expect(uncatalogued.slice(2)).toEqual(["Line 1", "3", "0", "€12.50", "0", "€37.50"]);
      const total = rows.find((r) => r.includes("GRAND TOTAL"))!;
      expect(total).toContain("9");
    });
  });

  it("drops the price columns when the user's profile hides proforma prices", async () => {
    await withFactoryWorld(async (w) => {
      const id = await proforma(w, 2);
      const res = await excel(await hiddenPriceAgent(w), id);
      expect(res.status).toBe(200);
      const rows = await sheetText(res.body as Buffer);
      expect(rows.find((r) => r[0] === "#")).toEqual([
        "#",
        "Article Code",
        "Product Name",
        "Qty (Bales)",
        "Kg / Bale",
        "Total KG",
      ]);
    });
  });

  it("exports an empty proforma in an unlisted currency", async () => {
    await withFactoryWorld(async (w) => {
      await w.q(`UPDATE companies SET base_currency = 'ZMW' WHERE id = $1`, [w.companyId]);
      const id = await proforma(w, 0);
      const res = await excel(w.agent, id);
      expect(res.status).toBe(200);
      const rows = await sheetText(res.body as Buffer);
      expect(rows.find((r) => r.includes("GRAND TOTAL"))).toContain("ZMW 0");
    });
  });
});

describe("customer proforma PDF export", () => {
  it("renders a priced multi-page proforma", async () => {
    await withFactoryWorld(async (w) => {
      await w.q(`UPDATE companies SET base_currency = 'CFA' WHERE id = $1`, [w.companyId]);
      const id = await proforma(w, 60);
      const res = await pdf(w.agent, id);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toBe("application/pdf");
      const body = res.body as Buffer;
      expect(body.subarray(0, 5).toString()).toBe("%PDF-");
      expect((body.toString("latin1").match(/\/Type \/Page\b/g) ?? []).length).toBeGreaterThan(1);
    });
  });

  it("renders the hidden-price layout and an empty proforma", async () => {
    await withFactoryWorld(async (w) => {
      await w.q(`UPDATE companies SET base_currency = 'ZMW' WHERE id = $1`, [w.companyId]);
      const id = await proforma(w, 2);
      const empty = await proforma(w, 0);
      const agent = await hiddenPriceAgent(w);
      for (const target of [id, empty]) {
        const res = await pdf(agent, target);
        expect(res.status).toBe(200);
        expect((res.body as Buffer).subarray(0, 5).toString()).toBe("%PDF-");
      }
    });
  });
});
