/**
 * Stock pricing and the bulk stock-item imports behind it.
 *
 * Two things matter here. A POS terminal must only ever see the price list for
 * a location its operator is assigned to, and a location's own price has to win
 * over the item's base price. And the bulk imports — items, barcodes,
 * categories — must report exactly what they did with each row rather than
 * failing the whole batch, because an operator fixes a spreadsheet from that
 * report.
 */
import ExcelJS from "exceljs";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "stkprice";
let ctx: TestContext;
let agent: request.SuperAgentTest;
let categoryId: number;

type PriceRow = {
  stockItemId: number;
  code: string;
  baseSellingPrice: string | null;
  sellingPrice: string | null;
  hasCustomPrice: boolean;
  quantity: string;
};

async function setRole(role: string): Promise<void> {
  await pool.query(`UPDATE user_company_roles SET role = $1 WHERE user_id = $2 AND company_id = $3`, [
    role,
    ctx.userId,
    ctx.companyId,
  ]);
  const selected = await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
  expect(selected.status).toBe(200);
}

function rowFor(rows: PriceRow[], code: string): PriceRow {
  const row = rows.find((entry) => entry.code === code);
  expect(row, `expected a price row for ${code}`).toBeDefined();
  return row as PriceRow;
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  agent = request.agent(ctx.app);

  const login = await agent.post("/api/auth/login").send({
    username: `${TEST_PREFIX}_testuser`,
    password: "testpassword123",
  });
  expect(login.status).toBe(200);
  await setRole("Admin");

  // Base price on the item, plus a location override on location 1 only.
  await pool.query(`UPDATE stock_items SET selling_price = '25.00' WHERE id = $1`, [ctx.stockItemIds[0]]);
  await pool.query(`UPDATE stock_items SET selling_price = '10.00' WHERE id = $1`, [ctx.stockItemIds[1]]);
  await pool.query(
    `INSERT INTO stock_item_location_prices (stock_item_id, location_id, selling_price)
     VALUES ($1, $2, '31.50')`,
    [ctx.stockItemIds[0], ctx.locationId]
  );

  const category = await pool.query<{ id: number }>(
    `INSERT INTO stock_categories (company_id, name, active) VALUES ($1, $2, true) RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX} Category A`]
  );
  categoryId = category.rows[0].id;
}, 120_000);

afterAll(async () => {
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60_000);

describe("POS price list", () => {
  it("requires a location and rejects one that is not the caller's", async () => {
    await setRole("Admin");

    expect((await agent.get("/api/pos/price-list")).status).toBe(400);
    expect((await agent.get("/api/pos/price-list").query({ locationId: "not-a-number" })).status).toBe(400);

    const unknownLocation = await agent.get("/api/pos/price-list").query({ locationId: 2147481900 });
    expect(unknownLocation.status).toBe(403);
    expect(unknownLocation.body.message).toMatch(/not found/i);
  }, 60_000);

  it("lets a location price override the item's base price", async () => {
    await setRole("Admin");

    const response = await agent.get("/api/pos/price-list").query({ locationId: ctx.locationId });
    expect(response.status).toBe(200);
    const rows = response.body as PriceRow[];

    const overridden = rowFor(rows, `${TEST_PREFIX}-ITEM1`);
    expect(overridden.baseSellingPrice).toBe("25.00");
    expect(overridden.sellingPrice).toBe("31.50");
    expect(overridden.hasCustomPrice).toBe(true);

    // Item 2 has no override, so it falls back to its own base price.
    const fallback = rowFor(rows, `${TEST_PREFIX}-ITEM2`);
    expect(fallback.sellingPrice).toBe("10.00");
    expect(fallback.hasCustomPrice).toBe(false);
  }, 60_000);

  it("reports the second location's price list without the first location's override", async () => {
    await setRole("Admin");

    const response = await agent.get("/api/pos/price-list").query({ locationId: ctx.location2Id });
    expect(response.status).toBe(200);
    const rows = response.body as PriceRow[];

    const item1 = rowFor(rows, `${TEST_PREFIX}-ITEM1`);
    expect(item1.hasCustomPrice).toBe(false);
    expect(item1.sellingPrice).toBe("25.00");
  }, 60_000);

  it("serves the whole catalogue to a privileged role and refuses it to POS", async () => {
    await setRole("Admin");
    const all = await agent.get("/api/pos/price-list").query({ locationId: "all" });
    expect(all.status).toBe(200);
    const rows = all.body as PriceRow[];
    expect(rows.length).toBeGreaterThanOrEqual(3);
    // The catalogue-wide view carries no location, so no quantity and no
    // location override.
    expect(rows.every((row) => row.quantity === "0")).toBe(true);
    expect(rows.every((row) => row.hasCustomPrice === false)).toBe(true);

    await setRole("POS");
    const posAll = await agent.get("/api/pos/price-list").query({ locationId: "all" });
    expect(posAll.status).toBe(403);
  }, 60_000);

  it("refuses a POS operator a location they are not assigned to", async () => {
    await setRole("POS");
    await pool.query(`DELETE FROM user_locations WHERE user_id = $1 AND company_id = $2`, [ctx.userId, ctx.companyId]);

    const unassigned = await agent.get("/api/pos/price-list").query({ locationId: ctx.locationId });
    expect(unassigned.status).toBe(403);
    expect(unassigned.body.message).toMatch(/not assigned/i);

    await pool.query(
      `INSERT INTO user_locations (user_id, company_id, location_id) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [ctx.userId, ctx.companyId, ctx.locationId]
    );
    const assigned = await agent.get("/api/pos/price-list").query({ locationId: ctx.locationId });
    expect(assigned.status).toBe(200);

    await setRole("Admin");
  }, 60_000);
});

describe("location price groups", () => {
  it("replaces the stored grouping wholesale and reads it back", async () => {
    await setRole("Admin");

    const saved = await agent
      .put("/api/location-price-groups")
      .send({ groups: [{ masterLocationId: ctx.locationId, followerLocationIds: [ctx.location2Id] }] });
    expect(saved.status).toBe(200);

    const listed = await agent.get("/api/location-price-groups");
    expect(listed.status).toBe(200);
    const groups = listed.body as Array<{ masterLocationId: number; followerLocationIds: number[] }>;
    const group = groups.find((entry) => entry.masterLocationId === ctx.locationId);
    expect(group?.followerLocationIds).toEqual([ctx.location2Id]);

    // Saving an empty set clears it rather than merging.
    const cleared = await agent.put("/api/location-price-groups").send({ groups: [] });
    expect(cleared.status).toBe(200);
    const afterClear = await agent.get("/api/location-price-groups");
    expect(afterClear.body).toEqual([]);
  }, 60_000);

  it("rejects a grouping payload that is not a list", async () => {
    await setRole("Admin");
    const response = await agent.put("/api/location-price-groups").send({ groups: "everything" });
    expect(response.status).toBe(400);
  }, 60_000);

  it("prices the catalogue against each configured master location", async () => {
    await setRole("Admin");
    await agent
      .put("/api/location-price-groups")
      .send({ groups: [{ masterLocationId: ctx.locationId, followerLocationIds: [ctx.location2Id] }] })
      .expect(200);

    const response = await agent.get("/api/pos/price-list-by-masters");
    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.masters)).toBe(true);
    expect(response.body.masters.map((master: { id: number }) => master.id)).toContain(ctx.locationId);

    type MasterRow = {
      code: string;
      masterPrices: Record<string, string>;
      costPrice?: string | null;
      offloadingCost?: string | null;
    };
    const items = response.body.items as MasterRow[];

    const overridden = items.find((entry) => entry.code === `${TEST_PREFIX}-ITEM1`);
    expect(overridden).toBeDefined();
    // The master location carries the override, so that is the price shown.
    expect(overridden?.masterPrices[String(ctx.locationId)]).toBe("31.50");

    // An item with no master-location price falls back to its base price.
    const fallback = items.find((entry) => entry.code === `${TEST_PREFIX}-ITEM2`);
    expect(fallback?.masterPrices[String(ctx.locationId)]).toBe("10.00");

    // A privileged role also gets the cost side of each line.
    expect(overridden).toHaveProperty("costPrice");
    expect(overridden).toHaveProperty("offloadingCost");

    await agent.put("/api/location-price-groups").send({ groups: [] }).expect(200);
  }, 60_000);
});

describe("stock item import", () => {
  it("separates created rows from duplicates and from rows it cannot accept", async () => {
    await setRole("Admin");

    const response = await agent.post("/api/stock-items/import").send({
      items: [
        {
          code: `${TEST_PREFIX}-NEW1`,
          name: "Imported item one",
          uom: "PCS",
          stockGroupId: ctx.stockGroupId,
        },
        // Already exists from the fixture: skipped, not an error.
        {
          code: `${TEST_PREFIX}-ITEM1`,
          name: "Duplicate of a fixture item",
          uom: "PCS",
          stockGroupId: ctx.stockGroupId,
        },
        // A stock group from no company at all.
        {
          code: `${TEST_PREFIX}-BADGROUP`,
          name: "Wrong group",
          uom: "PCS",
          stockGroupId: 2147481900,
        },
        // No group at all.
        { code: `${TEST_PREFIX}-NOGROUP`, name: "No group", uom: "PCS" },
      ],
    });

    expect(response.status).toBe(200);
    const results = response.body.results;
    expect(results.created.map((item: { code: string }) => item.code)).toEqual([`${TEST_PREFIX}-NEW1`]);
    expect(results.skipped).toHaveLength(1);
    expect(results.skipped[0].reason).toMatch(/already exists/i);
    expect(results.errors).toHaveLength(2);
    expect(results.errors.every((error: { error: string }) => /stock group/i.test(error.error))).toBe(true);

    // The one good row really landed.
    const stored = await pool.query(`SELECT id FROM stock_items WHERE company_id = $1 AND code = $2`, [
      ctx.companyId,
      `${TEST_PREFIX}-NEW1`,
    ]);
    expect(stored.rowCount).toBe(1);
  }, 60_000);

  it("rejects an import body that is not a list of items", async () => {
    await setRole("Admin");
    const response = await agent.post("/api/stock-items/import").send({ items: "one item" });
    expect(response.status).toBe(400);
  }, 60_000);
});

describe("barcode alias import", () => {
  it("assigns new aliases and explains every row it did not assign", async () => {
    await setRole("Admin");
    await pool.query(`DELETE FROM stock_item_code_aliases WHERE company_id = $1`, [ctx.companyId]);

    const response = await agent.post("/api/stock-items/import-barcodes").send({
      rows: [
        { itemCode: `${TEST_PREFIX}-ITEM1`, barcode: "ALIAS-0001" },
        // Second alias for the same item is fine.
        { itemCode: `${TEST_PREFIX}-ITEM1`, barcode: "ALIAS-0002" },
        // Same barcode again, now already taken.
        { itemCode: `${TEST_PREFIX}-ITEM2`, barcode: "ALIAS-0001" },
        // A barcode equal to the item's own code is not an alias.
        { itemCode: `${TEST_PREFIX}-ITEM2`, barcode: `${TEST_PREFIX}-ITEM2` },
        // Blank halves are skipped.
        { itemCode: "", barcode: "ALIAS-0003" },
        { itemCode: `${TEST_PREFIX}-ITEM2`, barcode: "  " },
        // No such item.
        { itemCode: `${TEST_PREFIX}-NOSUCHCODE`, barcode: "ALIAS-0004" },
      ],
    });

    expect(response.status).toBe(200);
    expect(response.body.imported).toBe(2);
    expect(response.body.skipped).toBe(4);
    expect(response.body.notFound).toBe(1);
    expect(response.body.notFoundCodes).toEqual([`${TEST_PREFIX}-NOSUCHCODE`]);

    const stored = await pool.query<{ alias_code: string }>(
      `SELECT alias_code FROM stock_item_code_aliases WHERE company_id = $1 ORDER BY alias_code`,
      [ctx.companyId]
    );
    expect(stored.rows.map((row) => row.alias_code)).toEqual(["ALIAS-0001", "ALIAS-0002"]);

    await pool.query(`DELETE FROM stock_item_code_aliases WHERE company_id = $1`, [ctx.companyId]);
  }, 60_000);

  it("rejects an empty barcode batch", async () => {
    await setRole("Admin");
    expect((await agent.post("/api/stock-items/import-barcodes").send({ rows: [] })).status).toBe(400);
    expect((await agent.post("/api/stock-items/import-barcodes").send({})).status).toBe(400);
  }, 60_000);
});

describe("bulk category update", () => {
  it("moves the items it can find and names the ones it cannot", async () => {
    await setRole("Admin");

    const response = await agent.post("/api/stock-items/update-categories").send({
      rows: [
        { itemCode: `${TEST_PREFIX}-ITEM1`, categoryName: `${TEST_PREFIX} Category A` },
        // Category name matching ignores case and surrounding space.
        { itemCode: `${TEST_PREFIX}-ITEM2`, categoryName: `  ${TEST_PREFIX.toUpperCase()} CATEGORY A ` },
        { itemCode: `${TEST_PREFIX}-NOSUCHCODE`, categoryName: `${TEST_PREFIX} Category A` },
        { itemCode: `${TEST_PREFIX}-ITEM3`, categoryName: "No such category" },
        // Blank rows are ignored entirely, not counted as failures.
        { itemCode: "", categoryName: "" },
      ],
    });

    expect(response.status).toBe(200);
    expect(response.body.updated).toBe(2);
    expect(response.body.notFound).toBe(1);
    expect(response.body.notFoundCodes).toEqual([`${TEST_PREFIX}-NOSUCHCODE`]);
    expect(response.body.categoryNotFound).toBe(1);
    expect(response.body.categoryNotFoundNames).toEqual(["No such category"]);

    const moved = await pool.query<{ code: string }>(
      `SELECT code FROM stock_items WHERE company_id = $1 AND category_id = $2 ORDER BY code`,
      [ctx.companyId, categoryId]
    );
    expect(moved.rows.map((row) => row.code)).toEqual([`${TEST_PREFIX}-ITEM1`, `${TEST_PREFIX}-ITEM2`]);

    await pool.query(`UPDATE stock_items SET category_id = NULL WHERE company_id = $1`, [ctx.companyId]);
  }, 60_000);

  it("rejects an empty category batch", async () => {
    await setRole("Admin");
    expect((await agent.post("/api/stock-items/update-categories").send({ rows: [] })).status).toBe(400);
  }, 60_000);
});

describe("grade and category template import", () => {
  it("requires a file", async () => {
    await setRole("Admin");
    const response = await agent.post("/api/stock-items/import-grade-category-template");
    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/no file/i);
  }, 60_000);

  it("creates the grades and categories the sheet names and reports every skipped row", async () => {
    await setRole("Admin");
    await pool.query(`UPDATE stock_items SET grade_id = NULL, category_id = NULL WHERE company_id = $1`, [
      ctx.companyId,
    ]);
    // An existing but deactivated grade: the import has to bring it back rather
    // than create a second one with the same name.
    await pool.query(`INSERT INTO stock_grades (company_id, name, active) VALUES ($1, $2, false)`, [
      ctx.companyId,
      `${TEST_PREFIX} Grade Dormant`,
    ]);

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Template");
    sheet.addRow(["Item Code", "Current Grade", "Current Category"]);
    // Row 2: a brand new grade and the category seeded in beforeAll.
    sheet.addRow([`${TEST_PREFIX}-ITEM1`, `${TEST_PREFIX} Grade New`, `${TEST_PREFIX} Category A`]);
    // Row 3: the dormant grade, matched case-insensitively, and a new category.
    sheet.addRow([`${TEST_PREFIX}-ITEM2`, `${TEST_PREFIX.toUpperCase()} GRADE DORMANT`, `${TEST_PREFIX} Category New`]);
    // Row 4: no item code at all.
    sheet.addRow(["", `${TEST_PREFIX} Grade New`, ""]);
    // Row 5: an item code from no company.
    sheet.addRow([`${TEST_PREFIX}-NOSUCHCODE`, "", ""]);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

    const response = await agent
      .post("/api/stock-items/import-grade-category-template")
      .attach("file", buffer, "template.xlsx");

    expect(response.status).toBe(200);
    expect(response.body.rowsProcessed).toBe(4);
    expect(response.body.itemsUpdated).toBe(2);
    expect(response.body.gradesCreated).toBe(1);
    expect(response.body.categoriesCreated).toBe(1);
    expect(response.body.skipped).toBe(2);
    expect(response.body.errors.map((error: { row: number }) => error.row)).toEqual([4, 5]);
    expect(response.body.errors[0].reason).toMatch(/item code is empty/i);
    expect(response.body.errors[1].reason).toMatch(/not found in this company/i);

    // The dormant grade was reactivated in place, not duplicated.
    const grades = await pool.query<{ name: string; active: boolean }>(
      `SELECT name, active FROM stock_grades WHERE company_id = $1 AND name ILIKE $2`,
      [ctx.companyId, `${TEST_PREFIX} Grade Dormant`]
    );
    expect(grades.rowCount).toBe(1);
    expect(grades.rows[0].active).toBe(true);

    const assigned = await pool.query<{ code: string; grade_name: string; category_name: string }>(
      `SELECT si.code, g.name AS grade_name, c.name AS category_name
         FROM stock_items si
         JOIN stock_grades g ON g.id = si.grade_id
         JOIN stock_categories c ON c.id = si.category_id
        WHERE si.company_id = $1
        ORDER BY si.code`,
      [ctx.companyId]
    );
    expect(assigned.rows).toHaveLength(2);
    expect(assigned.rows[0].grade_name).toBe(`${TEST_PREFIX} Grade New`);
    expect(assigned.rows[1].category_name).toBe(`${TEST_PREFIX} Category New`);

    await pool.query(`UPDATE stock_items SET grade_id = NULL, category_id = NULL WHERE company_id = $1`, [
      ctx.companyId,
    ]);
  }, 120_000);
});
