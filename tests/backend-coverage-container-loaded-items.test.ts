/**
 * Container loaded-item verification: the proforma-vs-loaded reconciliation a
 * buyer runs before a container is offloaded.
 *
 * The behaviour that matters is the comparison itself — what the supplier said
 * they would ship against what the container actually holds — and the tenant
 * boundary around it, since a container belongs to exactly one company and its
 * loaded manifest must never be readable or writable from another.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "clitems";
let ctx: TestContext;
let agent: request.SuperAgentTest;
let supplierId: number;
let containerId: number;
let proformaId: number;
let foreignCompanyId: number;
let foreignContainerId: number;
let foreignProformaId: number;

type ComparisonRow = {
  barcode: string;
  expectedQty: number;
  loadedQty: number;
  expectedPricePerBale: number;
  loadedPricePerBale: number;
  expectedWeightTotal: number;
  loadedWeightTotal: number;
  expectedTotalValue: number;
  loadedTotalValue: number;
  statusQty: string;
  priceStatus: string;
  priceDiffPerBale: number;
  totalPriceDiff: number;
};

async function insertSupplier(companyId: number, code: string): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO suppliers (company_id, code, legal_name, email, active)
     VALUES ($1, $2, $3, $4, true) RETURNING id`,
    [companyId, code, `${TEST_PREFIX} Supplier ${code}`, `${code.toLowerCase()}@example.test`]
  );
  return result.rows[0].id;
}

async function insertContainer(companyId: number, supplier: number, number_: string): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO containers (company_id, container_number, supplier_id, status, import_date)
     VALUES ($1, $2, $3, 'OTW', '2026-09-01') RETURNING id`,
    [companyId, number_, supplier]
  );
  return result.rows[0].id;
}

async function insertProforma(companyId: number, supplier: number, reference: string): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO supplier_proformas (company_id, supplier_id, reference)
     VALUES ($1, $2, $3) RETURNING id`,
    [companyId, supplier, reference]
  );
  return result.rows[0].id;
}

async function insertProformaLine(
  proforma: number,
  barcode: string,
  itemName: string,
  qty: number,
  weightPerBale: string,
  pricePerBale: string
): Promise<void> {
  await pool.query(
    `INSERT INTO supplier_proforma_lines (proforma_id, barcode, item_name, qty, weight_per_bale, price_per_bale)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [proforma, barcode, itemName, qty, weightPerBale, pricePerBale]
  );
}

async function loadedItems(container: number): Promise<Array<{ id: number; barcode: string; qty: number }>> {
  const result = await pool.query<{ id: number; barcode: string; qty: number }>(
    `SELECT id, barcode, qty FROM supplier_container_loaded_items WHERE container_id = $1 ORDER BY barcode`,
    [container]
  );
  return result.rows;
}

async function clearLoadedItems(container: number): Promise<void> {
  await pool.query(`DELETE FROM supplier_container_loaded_items WHERE container_id = $1`, [container]);
}

function rowFor(comparison: ComparisonRow[], barcode: string): ComparisonRow {
  const row = comparison.find((entry) => entry.barcode === barcode);
  expect(row, `expected a comparison row for ${barcode}`).toBeDefined();
  return row as ComparisonRow;
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  agent = request.agent(ctx.app);

  const login = await agent.post("/api/auth/login").send({
    username: `${TEST_PREFIX}_testuser`,
    password: "testpassword123",
  });
  expect(login.status).toBe(200);
  const selected = await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
  expect(selected.status).toBe(200);

  supplierId = await insertSupplier(ctx.companyId, `${TEST_PREFIX}S1`);
  containerId = await insertContainer(ctx.companyId, supplierId, `${TEST_PREFIX}-CONT-1`);
  proformaId = await insertProforma(ctx.companyId, supplierId, `${TEST_PREFIX}-PRO-1`);

  // A second company the logged-in user has no role in, used to prove the
  // container boundary rather than merely assuming it.
  const foreign = await pool.query<{ id: number }>(
    `INSERT INTO companies (code, name, company_type, active, base_currency)
     VALUES ($1, $2, 'erp', true, 'USD') RETURNING id`,
    ["CLIFRGN", `${TEST_PREFIX}_ForeignCompany`]
  );
  foreignCompanyId = foreign.rows[0].id;
  const foreignSupplierId = await insertSupplier(foreignCompanyId, `${TEST_PREFIX}F1`);
  foreignContainerId = await insertContainer(foreignCompanyId, foreignSupplierId, `${TEST_PREFIX}-FRGN-1`);
  foreignProformaId = await insertProforma(foreignCompanyId, foreignSupplierId, `${TEST_PREFIX}-FRGN-PRO`);
}, 120_000);

afterAll(async () => {
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60_000);

describe("container loaded-item manifest", () => {
  it("creates, lists, edits and removes a loaded line", async () => {
    await clearLoadedItems(containerId);

    const created = await agent.post(`/api/containers/${containerId}/loaded-items`).send({
      barcode: " BC-CRUD ",
      itemName: "Crud bale",
      qty: "7",
      weightPerBale: "45.5",
      pricePerBale: "12.25",
    });
    expect(created.status).toBe(200);
    expect(created.body.barcode).toBe("BC-CRUD");
    expect(created.body.qty).toBe(7);

    const listed = await agent.get(`/api/containers/${containerId}/loaded-items`);
    expect(listed.status).toBe(200);
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0].id).toBe(created.body.id);

    const patched = await agent.patch(`/api/container-loaded-items/${created.body.id}`).send({
      qty: "9",
      itemName: "Crud bale edited",
      pricePerBale: "13.00",
    });
    expect(patched.status).toBe(200);
    expect(patched.body.qty).toBe(9);
    expect(patched.body.itemName).toBe("Crud bale edited");

    const removed = await agent.delete(`/api/container-loaded-items/${created.body.id}`);
    expect(removed.status).toBe(200);
    expect(removed.body.success).toBe(true);
    expect(await loadedItems(containerId)).toHaveLength(0);
  }, 60_000);

  it("treats a non-numeric quantity as zero rather than failing the write", async () => {
    await clearLoadedItems(containerId);

    const created = await agent.post(`/api/containers/${containerId}/loaded-items`).send({
      barcode: "BC-NAN",
      qty: "not-a-number",
    });
    expect(created.status).toBe(200);
    expect(created.body.qty).toBe(0);
    expect(created.body.itemName).toBeNull();

    await clearLoadedItems(containerId);
  }, 60_000);

  it("refuses manifest access for a container owned by another company", async () => {
    const list = await agent.get(`/api/containers/${foreignContainerId}/loaded-items`);
    expect(list.status).toBe(403);

    const create = await agent
      .post(`/api/containers/${foreignContainerId}/loaded-items`)
      .send({ barcode: "BC-FRGN", qty: 1 });
    expect(create.status).toBe(403);

    const importAttempt = await agent
      .post(`/api/containers/${foreignContainerId}/import-loaded-items`)
      .send({ items: [{ barcode: "BC-FRGN", qty: 1 }] });
    expect(importAttempt.status).toBe(403);

    expect(await loadedItems(foreignContainerId)).toHaveLength(0);
  }, 60_000);

  it("rejects an unparseable container or item id", async () => {
    expect((await agent.get("/api/containers/not-a-number/loaded-items")).status).toBe(400);
    expect((await agent.patch("/api/container-loaded-items/not-a-number").send({ qty: 1 })).status).toBe(400);
    expect((await agent.delete("/api/container-loaded-items/not-a-number")).status).toBe(400);
  }, 60_000);

  it("reports a missing loaded line as not found", async () => {
    expect((await agent.patch("/api/container-loaded-items/2147481900").send({ qty: 1 })).status).toBe(404);
    expect((await agent.delete("/api/container-loaded-items/2147481900")).status).toBe(404);
  }, 60_000);
});

describe("container loaded-item import", () => {
  it("imports a manifest under either the camelCase or the spreadsheet header spelling", async () => {
    await clearLoadedItems(containerId);

    const response = await agent.post(`/api/containers/${containerId}/import-loaded-items`).send({
      items: [
        { barcode: "BC-IMP-1", itemName: "Camel case line", qty: 4, weightPerBale: "40", pricePerBale: "10" },
        { Barcode: "BC-IMP-2", "Item Name": "Header line", Qty: 6, "Weight per Bale": "50", "Price per Bale": "11" },
      ],
    });

    expect(response.status).toBe(200);
    expect(response.body.imported).toBe(2);
    const stored = await loadedItems(containerId);
    expect(stored.map((row) => row.barcode)).toEqual(["BC-IMP-1", "BC-IMP-2"]);
    expect(stored.map((row) => row.qty)).toEqual([4, 6]);

    await clearLoadedItems(containerId);
  }, 60_000);

  it("refuses an import with nothing in it", async () => {
    const empty = await agent.post(`/api/containers/${containerId}/import-loaded-items`).send({ items: [] });
    expect(empty.status).toBe(400);
    expect(empty.body.message).toMatch(/no items/i);

    const missing = await agent.post(`/api/containers/${containerId}/import-loaded-items`).send({});
    expect(missing.status).toBe(400);
  }, 60_000);
});

describe("container loaded-item auto-populate", () => {
  it("refuses to auto-populate a container with no purchase order", async () => {
    await clearLoadedItems(containerId);
    const response = await agent.post(`/api/containers/${containerId}/auto-populate-loaded-items`);
    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/no purchase orders/i);
  }, 60_000);

  it("copies the purchase order lines onto the container and then refuses to do it twice", async () => {
    await clearLoadedItems(containerId);

    const po = await pool.query<{ id: number }>(
      `INSERT INTO purchase_orders (company_id, po_number, container_id, supplier_id, currency, status)
       VALUES ($1, $2, $3, $4, 'USD', 'Open') RETURNING id`,
      [ctx.companyId, `${TEST_PREFIX}-PO-1`, containerId, supplierId]
    );
    const poId = po.rows[0].id;
    await pool.query(
      `INSERT INTO po_line_items (po_id, stock_item_id, item_name, quantity, rate, line_total)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [poId, ctx.stockItemIds[0], "PO line one", "12.4", "9.50", "117.80"]
    );
    await pool.query(
      `INSERT INTO po_line_items (po_id, stock_item_id, item_name, quantity, rate, line_total)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [poId, ctx.stockItemIds[1], "PO line two", "3", "4.00", "12.00"]
    );

    const populated = await agent.post(`/api/containers/${containerId}/auto-populate-loaded-items`);
    expect(populated.status).toBe(200);
    expect(populated.body.imported).toBe(2);
    expect(populated.body.skipped).toBe(0);

    const stored = await loadedItems(containerId);
    expect(stored).toHaveLength(2);
    // 12.4 bales is not a thing: the quantity is rounded to whole bales.
    const first = stored.find((row) => row.barcode === `${TEST_PREFIX}-ITEM1`);
    expect(first?.qty).toBe(12);

    const again = await agent.post(`/api/containers/${containerId}/auto-populate-loaded-items`);
    expect(again.status).toBe(400);
    expect(again.body.message).toMatch(/already has loaded items/i);

    await clearLoadedItems(containerId);
    await pool.query(`DELETE FROM po_line_items WHERE po_id = $1`, [poId]);
    await pool.query(`DELETE FROM purchase_orders WHERE id = $1`, [poId]);
  }, 60_000);
});

describe("container verification summary", () => {
  beforeAll(async () => {
    await pool.query(`DELETE FROM supplier_proforma_lines WHERE proforma_id = $1`, [proformaId]);
    // One line per outcome the comparison is meant to classify.
    await insertProformaLine(proformaId, "BC-MATCH", "Matching bale", 10, "50", "20.00");
    await insertProformaLine(proformaId, "BC-OVER", "Over-loaded bale", 5, "40", "15.00");
    await insertProformaLine(proformaId, "BC-UNDER", "Under-loaded bale", 8, "30", "12.00");
    await insertProformaLine(proformaId, "BC-MISSING", "Never loaded bale", 4, "25", "9.00");
    // The same barcode twice: the proforma side must aggregate before comparing.
    await insertProformaLine(proformaId, "BC-MATCH", "Matching bale second line", 2, "50", "20.00");

    await clearLoadedItems(containerId);
    await agent
      .post(`/api/containers/${containerId}/import-loaded-items`)
      .send({
        items: [
          { barcode: "BC-MATCH", itemName: "Matching bale", qty: 12, weightPerBale: "50", pricePerBale: "20.00" },
          { barcode: "BC-OVER", itemName: "Over-loaded bale", qty: 9, weightPerBale: "40", pricePerBale: "16.50" },
          { barcode: "BC-UNDER", itemName: "Under-loaded bale", qty: 3, weightPerBale: "30", pricePerBale: "12.00" },
          { barcode: "BC-EXTRA", itemName: "Not on the proforma", qty: 6, weightPerBale: "20", pricePerBale: "0" },
        ],
      })
      .expect(200);
  }, 120_000);

  it("classifies every quantity outcome against the proforma", async () => {
    const response = await agent
      .get(`/api/suppliers/${supplierId}/containers/${containerId}/verification-summary`)
      .query({ proformaId });

    expect(response.status).toBe(200);
    expect(response.body.proforma.id).toBe(proformaId);
    expect(response.body.containerId).toBe(containerId);
    expect(response.body.supplierId).toBe(supplierId);

    const comparison = response.body.comparison as ComparisonRow[];
    // Two proforma lines share BC-MATCH, so the comparison has one row for it.
    expect(comparison).toHaveLength(5);

    const match = rowFor(comparison, "BC-MATCH");
    expect(match.expectedQty).toBe(12);
    expect(match.loadedQty).toBe(12);
    expect(match.statusQty).toBe("MATCH");

    const over = rowFor(comparison, "BC-OVER");
    expect(over.expectedQty).toBe(5);
    expect(over.loadedQty).toBe(9);
    expect(over.statusQty).toBe("OVER_LOADED");

    const under = rowFor(comparison, "BC-UNDER");
    expect(under.statusQty).toBe("UNDER_LOADED");

    const missing = rowFor(comparison, "BC-MISSING");
    expect(missing.loadedQty).toBe(0);
    expect(missing.statusQty).toBe("MISSING_FROM_LOADED");

    const extra = rowFor(comparison, "BC-EXTRA");
    expect(extra.expectedQty).toBe(0);
    expect(extra.statusQty).toBe("LOADED_NOT_IN_PROFORMA");
  }, 60_000);

  it("prices the difference the buyer would be invoiced for", async () => {
    const response = await agent
      .get(`/api/suppliers/${supplierId}/containers/${containerId}/verification-summary`)
      .query({ proformaId });
    expect(response.status).toBe(200);
    const comparison = response.body.comparison as ComparisonRow[];

    const match = rowFor(comparison, "BC-MATCH");
    expect(match.priceStatus).toBe("PRICE_MATCH");
    expect(match.priceDiffPerBale).toBeCloseTo(0, 6);
    expect(match.expectedTotalValue).toBeCloseTo(240, 6);
    expect(match.loadedTotalValue).toBeCloseTo(240, 6);
    expect(match.expectedWeightTotal).toBeCloseTo(600, 6);

    const over = rowFor(comparison, "BC-OVER");
    expect(over.priceStatus).toBe("PRICE_DIFF");
    expect(over.priceDiffPerBale).toBeCloseTo(1.5, 6);
    // 9 bales loaded at 1.50 over the agreed price.
    expect(over.totalPriceDiff).toBeCloseTo(13.5, 6);
    expect(over.loadedTotalValue).toBeCloseTo(148.5, 6);

    // No price on either side is not a zero difference, it is unknown.
    const extra = rowFor(comparison, "BC-EXTRA");
    expect(extra.priceStatus).toBe("PRICE_UNKNOWN");

    const missing = rowFor(comparison, "BC-MISSING");
    expect(missing.priceStatus).toBe("PRICE_UNKNOWN");
    // Nothing arrived, so the loaded weight and value are zero even though the
    // proforma priced the line.
    expect(missing.loadedWeightTotal).toBeCloseTo(0, 6);
    expect(missing.loadedTotalValue).toBeCloseTo(0, 6);
    expect(missing.expectedTotalValue).toBeCloseTo(36, 6);
  }, 60_000);

  it("requires a proforma and keeps the summary inside the tenant", async () => {
    const noProforma = await agent.get(`/api/suppliers/${supplierId}/containers/${containerId}/verification-summary`);
    expect(noProforma.status).toBe(400);

    const unknownProforma = await agent
      .get(`/api/suppliers/${supplierId}/containers/${containerId}/verification-summary`)
      .query({ proformaId: 2147481900 });
    expect(unknownProforma.status).toBe(404);

    // A proforma that exists, but in the other company.
    const crossTenantProforma = await agent
      .get(`/api/suppliers/${supplierId}/containers/${containerId}/verification-summary`)
      .query({ proformaId: foreignProformaId });
    expect(crossTenantProforma.status).toBe(404);

    const crossTenantContainer = await agent
      .get(`/api/suppliers/${supplierId}/containers/${foreignContainerId}/verification-summary`)
      .query({ proformaId });
    expect(crossTenantContainer.status).toBe(403);

    const badId = await agent
      .get(`/api/suppliers/${supplierId}/containers/not-a-number/verification-summary`)
      .query({ proformaId });
    expect(badId.status).toBe(400);
  }, 60_000);
});

describe("container verification exports", () => {
  it("returns a workbook for the line-by-line verification export", async () => {
    const response = await agent
      .get(`/api/suppliers/${supplierId}/containers/${containerId}/verification-export.xlsx`)
      .query({ proformaId })
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => callback(null, Buffer.concat(chunks)));
      });

    expect(response.status).toBe(200);
    expect(String(response.headers["content-type"])).toMatch(/spreadsheetml/);
    const body = response.body as Buffer;
    expect(body.length).toBeGreaterThan(1000);
    // Every xlsx file is a zip; "PK" is its local file header.
    expect(body.subarray(0, 2).toString("latin1")).toBe("PK");
  }, 120_000);

  it("returns a workbook for the verification summary export", async () => {
    const response = await agent
      .get(`/api/suppliers/${supplierId}/containers/${containerId}/verification-summary-export.xlsx`)
      .query({ proformaId })
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => callback(null, Buffer.concat(chunks)));
      });

    expect(response.status).toBe(200);
    const body = response.body as Buffer;
    expect(body.length).toBeGreaterThan(1000);
    expect(body.subarray(0, 2).toString("latin1")).toBe("PK");
  }, 120_000);

  it("keeps both exports behind the same proforma and tenant checks", async () => {
    for (const path of ["verification-export.xlsx", "verification-summary-export.xlsx"]) {
      const noProforma = await agent.get(`/api/suppliers/${supplierId}/containers/${containerId}/${path}`);
      expect(noProforma.status).toBe(400);

      const unknownProforma = await agent
        .get(`/api/suppliers/${supplierId}/containers/${containerId}/${path}`)
        .query({ proformaId: 2147481900 });
      expect(unknownProforma.status).toBe(404);

      const crossTenantContainer = await agent
        .get(`/api/suppliers/${supplierId}/containers/${foreignContainerId}/${path}`)
        .query({ proformaId });
      expect(crossTenantContainer.status).toBe(403);
    }
  }, 120_000);
});
