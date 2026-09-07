/**
 * Behavioural coverage for `server/routes/vouchers/voucherPurchaseUpdateRoutes.ts`.
 *
 * Both endpoints in that file rewrite documents that money and stock are read
 * back from, and neither had a test: `PATCH /api/vouchers/:id/purchase` replaces
 * a purchase order's lines and pushes the delta into the container it belongs
 * to, and `PATCH /api/vouchers/:id/adjustment` reverses a stock adjustment's
 * old lines out of inventory before applying the new ones.
 *
 * The properties worth holding:
 *
 *   - **A purchase edit re-totals the whole chain.** The PO's `items_total`, the
 *     container's `items_total` and `grand_total`, and the voucher's
 *     `total_amount` all have to move together. The container is updated by the
 *     *difference* against the PO's old total, so an edit that forgets the old
 *     total silently inflates the container.
 *   - **Line replacement is wholesale, not additive.** The route deletes every
 *     `po_line_items` row before inserting, so a partial replace would leave
 *     phantom lines that the container total no longer accounts for.
 *   - **An adjustment edit is inventory-neutral for what it removes.** Old lines
 *     are reversed out of the old location before the new lines are applied to
 *     the new one; moving the location must not leave stock behind.
 *   - **Mixed vouchers total signed, everything else absolute.** A Mixed voucher
 *     nets its lines; a Consumption or Production voucher reports magnitude.
 *   - **Editing is gated by role, tenant and document state.** A foreign
 *     company's voucher, a read-only migrated voucher, a Staff user, and a
 *     Manager reaching for anything but today are all refused before a write.
 */
import request from "supertest";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";

import { db, pool } from "../server/db";
import * as schema from "../shared/schema";
import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";

const TEST_PREFIX = "vpurchadj";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let supplierId: number;
let containerId: number;
let seq = 0;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function setRole(role: string): Promise<void> {
  await db.update(schema.userCompanyRoles).set({ role }).where(eq(schema.userCompanyRoles.userId, ctx.userId));
  // currentRole is copied into the session at company selection, so the session
  // has to be refreshed for a role change to take effect on the next request.
  const res = await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
  expect(res.status).toBe(200);
}

/** A Purchase voucher with its purchase order and one line, on a fresh container. */
async function seedPurchase(options: { voucherDate?: string; voucherNumber?: string } = {}) {
  seq += 1;
  const [container] = await db
    .insert(schema.containers)
    .values({
      companyId: ctx.companyId,
      containerNumber: `${TEST_PREFIX}-C${seq}`,
      supplierId,
      importDate: "2026-01-01",
      itemsTotal: "1000.00",
      chargesTotal: "250.00",
      grandTotal: "1250.00",
    })
    .returning();

  const [voucher] = await db
    .insert(schema.vouchers)
    .values({
      companyId: ctx.companyId,
      voucherType: "Purchase",
      voucherNumber: options.voucherNumber ?? `${TEST_PREFIX}-PV${seq}`,
      voucherDate: options.voucherDate ?? "2026-01-05",
      description: "Original purchase",
      totalAmount: "1000.00",
      currency: "USD",
    })
    .returning();

  const [po] = await db
    .insert(schema.purchaseOrders)
    .values({
      companyId: ctx.companyId,
      poNumber: `${TEST_PREFIX}-PO${seq}`,
      containerId: container.id,
      supplierId,
      voucherId: voucher.id,
      itemsTotal: "1000.00",
    })
    .returning();

  const [line] = await db
    .insert(schema.poLineItems)
    .values({
      poId: po.id,
      stockItemId: ctx.stockItemIds[0],
      itemName: "Original line",
      quantity: "10.000",
      rate: "100.00",
      lineTotal: "1000.00",
    })
    .returning();

  return { container, voucher, po, line };
}

/** A stock adjustment voucher of the given type, with one existing line. */
async function seedAdjustment(voucherType: "Consumption" | "Production" | "Mixed") {
  seq += 1;
  const [voucher] = await db
    .insert(schema.vouchers)
    .values({
      companyId: ctx.companyId,
      voucherType,
      voucherNumber: `${TEST_PREFIX}-AV${seq}`,
      voucherDate: "2026-01-05",
      description: "Original adjustment",
      totalAmount: "0",
      currency: "USD",
      locationId: ctx.locationId,
    })
    .returning();
  return { voucher };
}

async function poLines(poId: number) {
  return db.select().from(schema.poLineItems).where(eq(schema.poLineItems.poId, poId));
}

async function containerRow(id: number) {
  const [row] = await db.select().from(schema.containers).where(eq(schema.containers.id, id));
  return row;
}

async function voucherRow(id: number) {
  const [row] = await db.select().from(schema.vouchers).where(eq(schema.vouchers.id, id));
  return row;
}

async function inventoryQty(locationId: number, stockItemId: number): Promise<number> {
  const result = await pool.query<{ quantity: string }>(
    `SELECT quantity FROM inventory WHERE company_id = $1 AND location_id = $2 AND stock_item_id = $3`,
    [ctx.companyId, locationId, stockItemId]
  );
  return result.rows[0] ? Number(result.rows[0].quantity) : 0;
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

  const [supplier] = await db
    .insert(schema.suppliers)
    .values({
      code: `${TEST_PREFIX.toUpperCase()}SUP`,
      legalName: `${TEST_PREFIX} Supplier`,
      email: `${TEST_PREFIX}@example.test`,
    })
    .returning();
  supplierId = supplier.id;
  await pool.query("UPDATE suppliers SET company_id = $1 WHERE id = $2", [ctx.companyId, supplierId]);
  containerId = 0;
}, 90000);

afterAll(async () => {
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

beforeEach(async () => {
  await setRole("Admin");
});

describe("PATCH /api/vouchers/:id/purchase", () => {
  it("replaces the purchase order lines and re-totals the PO, container and voucher", async () => {
    const { container, voucher, po } = await seedPurchase();

    const response = await agent.patch(`/api/vouchers/${voucher.id}/purchase`).send({
      voucherDate: "2026-02-09",
      description: "Edited purchase",
      items: [
        { stockItemId: ctx.stockItemIds[0], itemName: "Line A", quantity: "4", rate: "150.25" },
        { stockItemId: ctx.stockItemIds[1], itemName: "Line B", quantity: "2", rate: "300" },
      ],
    });

    expect(response.status).toBe(200);
    // 4 * 150.25 + 2 * 300 = 1201.00, against an old PO total of 1000.00.
    expect(response.body.totalAmount).toBe("1201.00");
    expect(response.body.description).toBe("Edited purchase");

    const lines = await poLines(po.id);
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => line.itemName).sort()).toEqual(["Line A", "Line B"]);
    expect(lines.find((line) => line.itemName === "Line A")?.lineTotal).toBe("601.00");
    expect(lines.find((line) => line.itemName === "Line B")?.lineTotal).toBe("600.00");

    const [poRow] = await db.select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, po.id));
    expect(poRow.itemsTotal).toBe("1201.00");

    // The container moves by the difference (+201.00), and its grand total is
    // recomputed as the new items total plus the untouched charges total.
    const updatedContainer = await containerRow(container.id);
    expect(updatedContainer.itemsTotal).toBe("1201.00");
    expect(updatedContainer.chargesTotal).toBe("250.00");
    expect(updatedContainer.grandTotal).toBe("1451.00");

    const updatedVoucher = await voucherRow(voucher.id);
    expect(updatedVoucher.totalAmount).toBe("1201.00");
    expect(String(updatedVoucher.voucherDate).slice(0, 10)).toBe("2026-02-09");
  });

  it("lowers the container total when the edit reduces the purchase", async () => {
    const { container, voucher } = await seedPurchase();

    const response = await agent
      .patch(`/api/vouchers/${voucher.id}/purchase`)
      .send({ items: [{ stockItemId: ctx.stockItemIds[0], itemName: "Smaller", quantity: "3", rate: "100" }] });

    expect(response.status).toBe(200);
    const updatedContainer = await containerRow(container.id);
    // 300 - 1000 = -700 against a 1000.00 container items total.
    expect(updatedContainer.itemsTotal).toBe("300.00");
    expect(updatedContainer.grandTotal).toBe("550.00");
  });

  it("leaves the date and description untouched when the request omits them", async () => {
    const { voucher } = await seedPurchase();

    const response = await agent
      .patch(`/api/vouchers/${voucher.id}/purchase`)
      .send({ items: [{ stockItemId: ctx.stockItemIds[0], itemName: "Same", quantity: "1", rate: "5" }] });

    expect(response.status).toBe(200);
    const updated = await voucherRow(voucher.id);
    expect(updated.description).toBe("Original purchase");
    expect(String(updated.voucherDate).slice(0, 10)).toBe("2026-01-05");
    expect(updated.totalAmount).toBe("5.00");
  });

  it("writes an audit row naming the edited voucher", async () => {
    const { voucher } = await seedPurchase();

    await agent
      .patch(`/api/vouchers/${voucher.id}/purchase`)
      .send({ items: [{ stockItemId: ctx.stockItemIds[0], itemName: "Audited", quantity: "2", rate: "50" }] });

    const audit = await pool.query<{ action: string; table_name: string; record_id: number }>(
      `SELECT action, table_name, record_id FROM audit_log
        WHERE company_id = $1 AND table_name = 'vouchers' AND record_id = $2`,
      [ctx.companyId, voucher.id]
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].action).toBe("update");
  });

  it("rejects a non-numeric voucher id", async () => {
    const response = await agent
      .patch("/api/vouchers/not-a-number/purchase")
      .send({ items: [{ stockItemId: ctx.stockItemIds[0], itemName: "X", quantity: "1", rate: "1" }] });
    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/Invalid voucher ID/i);
  });

  it("requires at least one item", async () => {
    const { voucher, po } = await seedPurchase();

    for (const body of [{}, { items: [] }, { items: "nope" }]) {
      const response = await agent.patch(`/api/vouchers/${voucher.id}/purchase`).send(body);
      expect(response.status).toBe(400);
      expect(response.body.message).toMatch(/At least one item/i);
    }

    // Nothing was written: the original line is still the only one.
    expect(await poLines(po.id)).toHaveLength(1);
  });

  it("returns 404 for a voucher that does not exist", async () => {
    const response = await agent
      .patch("/api/vouchers/99999999/purchase")
      .send({ items: [{ stockItemId: ctx.stockItemIds[0], itemName: "X", quantity: "1", rate: "1" }] });
    expect(response.status).toBe(404);
  });

  it("refuses a voucher that is not a Purchase", async () => {
    const { voucher } = await seedAdjustment("Consumption");

    const response = await agent
      .patch(`/api/vouchers/${voucher.id}/purchase`)
      .send({ items: [{ stockItemId: ctx.stockItemIds[0], itemName: "X", quantity: "1", rate: "1" }] });

    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/only updates Purchase vouchers/i);
  });

  it("refuses a purchase voucher owned by another company at the tenant boundary", async () => {
    const [foreignCompany] = await db
      .insert(schema.companies)
      .values({
        code: `${TEST_PREFIX.slice(0, 4).toUpperCase()}FGN`,
        name: `${TEST_PREFIX}_ForeignCompany`,
        baseCurrency: "USD",
      })
      .returning();
    const [foreignVoucher] = await db
      .insert(schema.vouchers)
      .values({
        companyId: foreignCompany.id,
        voucherType: "Purchase",
        voucherNumber: `${TEST_PREFIX}-FGN1`,
        voucherDate: "2026-01-05",
        totalAmount: "10.00",
        currency: "USD",
      })
      .returning();

    try {
      const response = await agent
        .patch(`/api/vouchers/${foreignVoucher.id}/purchase`)
        .send({ items: [{ stockItemId: ctx.stockItemIds[0], itemName: "X", quantity: "1", rate: "1" }] });

      // The tenant-isolation boundary refuses before the route's own company
      // check, and answers 404 rather than confirming the row exists.
      expect(response.status).toBe(404);
      expect(response.body.code).toBe("CROSS_COMPANY_ACCESS_DENIED");

      // The foreign voucher is untouched.
      const after = await voucherRow(foreignVoucher.id);
      expect(after.totalAmount).toBe("10.00");
    } finally {
      await db.delete(schema.vouchers).where(eq(schema.vouchers.id, foreignVoucher.id));
      await db.delete(schema.companies).where(eq(schema.companies.id, foreignCompany.id));
    }
  });

  it("refuses a read-only migrated voucher", async () => {
    const { voucher, po } = await seedPurchase({ voucherNumber: `MIG-${TEST_PREFIX}-1` });

    const response = await agent
      .patch(`/api/vouchers/${voucher.id}/purchase`)
      .send({ items: [{ stockItemId: ctx.stockItemIds[0], itemName: "X", quantity: "1", rate: "1" }] });

    expect(response.status).toBe(403);
    expect(await poLines(po.id)).toHaveLength(1);
  });

  it("returns 404 when the voucher has no purchase order", async () => {
    seq += 1;
    const [orphan] = await db
      .insert(schema.vouchers)
      .values({
        companyId: ctx.companyId,
        voucherType: "Purchase",
        voucherNumber: `${TEST_PREFIX}-ORPH${seq}`,
        voucherDate: "2026-01-05",
        totalAmount: "0",
        currency: "USD",
      })
      .returning();

    const response = await agent
      .patch(`/api/vouchers/${orphan.id}/purchase`)
      .send({ items: [{ stockItemId: ctx.stockItemIds[0], itemName: "X", quantity: "1", rate: "1" }] });

    expect(response.status).toBe(404);
    expect(response.body.message).toMatch(/purchase order not found/i);
  });

  it("lets a Manager edit today's purchase but not an older one", async () => {
    const stale = await seedPurchase({ voucherDate: "2026-01-05" });
    const current = await seedPurchase({ voucherDate: today() });
    await setRole("Manager");

    const refused = await agent
      .patch(`/api/vouchers/${stale.voucher.id}/purchase`)
      .send({ items: [{ stockItemId: ctx.stockItemIds[0], itemName: "X", quantity: "1", rate: "1" }] });
    expect(refused.status).toBe(403);
    expect(refused.body.message).toMatch(/only edit today's vouchers/i);
    expect(await poLines(stale.po.id)).toHaveLength(1);

    const allowed = await agent
      .patch(`/api/vouchers/${current.voucher.id}/purchase`)
      .send({ items: [{ stockItemId: ctx.stockItemIds[0], itemName: "Manager line", quantity: "2", rate: "7" }] });
    expect(allowed.status).toBe(200);
    expect(allowed.body.totalAmount).toBe("14.00");
  });

  it("refuses a Normal User at the accounting module gate, before the route runs", async () => {
    const { voucher, po } = await seedPurchase({ voucherDate: today() });
    await setRole("Normal User");

    const response = await agent
      .patch(`/api/vouchers/${voucher.id}/purchase`)
      .send({ items: [{ stockItemId: ctx.stockItemIds[0], itemName: "X", quantity: "1", rate: "1" }] });

    // Normal User is deny-by-default, so `mod_accounting` refuses first and the
    // route never sees the request.
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ key: "mod_accounting", permType: "module" });
    expect(await poLines(po.id)).toHaveLength(1);
  });

  it("refuses a View Only user in the route's own role check, even for today's purchase", async () => {
    const { voucher, po } = await seedPurchase({ voucherDate: today() });
    // View Only is allow-by-default at the module gate, so it reaches the
    // handler and is stopped by the editing-role check itself.
    await setRole("View Only");

    const response = await agent
      .patch(`/api/vouchers/${voucher.id}/purchase`)
      .send({ items: [{ stockItemId: ctx.stockItemIds[0], itemName: "X", quantity: "1", rate: "1" }] });

    expect(response.status).toBe(403);
    expect(response.body.message).toMatch(/Insufficient permissions to edit vouchers/i);
    expect(await poLines(po.id)).toHaveLength(1);
  });
});

describe("PATCH /api/vouchers/:id/adjustment", () => {
  it("creates the adjustment header on first edit and applies the lines to inventory", async () => {
    const { voucher } = await seedAdjustment("Production");
    const before = await inventoryQty(ctx.locationId, ctx.stockItemIds[0]);

    const response = await agent.patch(`/api/vouchers/${voucher.id}/adjustment`).send({
      locationId: ctx.locationId,
      description: "Produced goods",
      items: [{ stockItemId: ctx.stockItemIds[0], quantity: "6", rate: "12.50" }],
    });

    expect(response.status).toBe(200);
    expect(response.body.totalAmount).toBe("75.00");

    const header = await pool.query<{ id: number; adjustment_type: string; notes: string; location_id: number }>(
      `SELECT id, adjustment_type, notes, location_id FROM stock_adjustment_vouchers WHERE voucher_id = $1`,
      [voucher.id]
    );
    expect(header.rows).toHaveLength(1);
    expect(header.rows[0].adjustment_type).toBe("production");
    expect(header.rows[0].notes).toBe("Produced goods");

    const items = await pool.query<{ quantity: string; total_amount: string }>(
      `SELECT quantity, total_amount FROM stock_adjustment_items WHERE adjustment_id = $1`,
      [header.rows[0].id]
    );
    expect(items.rows).toHaveLength(1);
    expect(Number(items.rows[0].total_amount)).toBe(75);

    expect(await inventoryQty(ctx.locationId, ctx.stockItemIds[0])).toBeCloseTo(before + 6, 3);
  });

  it("labels a Consumption voucher's header and reports an absolute total for negative lines", async () => {
    const { voucher } = await seedAdjustment("Consumption");
    const before = await inventoryQty(ctx.locationId, ctx.stockItemIds[1]);

    const response = await agent.patch(`/api/vouchers/${voucher.id}/adjustment`).send({
      locationId: ctx.locationId,
      items: [{ stockItemId: ctx.stockItemIds[1], quantity: "-4", rate: "10" }],
    });

    expect(response.status).toBe(200);
    // Signed total is -40; a Consumption voucher reports magnitude.
    expect(response.body.totalAmount).toBe("40.00");

    const header = await pool.query<{ adjustment_type: string }>(
      `SELECT adjustment_type FROM stock_adjustment_vouchers WHERE voucher_id = $1`,
      [voucher.id]
    );
    expect(header.rows[0].adjustment_type).toBe("consumption");
    expect(await inventoryQty(ctx.locationId, ctx.stockItemIds[1])).toBeCloseTo(before - 4, 3);
  });

  it("nets a Mixed voucher's lines instead of taking their magnitude", async () => {
    const { voucher } = await seedAdjustment("Mixed");

    const response = await agent.patch(`/api/vouchers/${voucher.id}/adjustment`).send({
      locationId: ctx.locationId,
      items: [
        { stockItemId: ctx.stockItemIds[0], quantity: "10", rate: "10" },
        { stockItemId: ctx.stockItemIds[1], quantity: "-3", rate: "10" },
      ],
    });

    expect(response.status).toBe(200);
    // Signed: 100 - 30 = 70. Magnitude would have been 130.
    expect(response.body.totalAmount).toBe("70.00");

    const header = await pool.query<{ id: number; adjustment_type: string }>(
      `SELECT id, adjustment_type FROM stock_adjustment_vouchers WHERE voucher_id = $1`,
      [voucher.id]
    );
    expect(header.rows[0].adjustment_type).toBe("mixed");

    // Each line stores its own magnitude regardless of the header's netting.
    const items = await pool.query<{ total_amount: string }>(
      `SELECT total_amount FROM stock_adjustment_items WHERE adjustment_id = $1 ORDER BY total_amount`,
      [header.rows[0].id]
    );
    expect(items.rows.map((row) => Number(row.total_amount))).toEqual([30, 100]);
  });

  it("reverses the previous lines out of the old location before applying the new ones", async () => {
    const { voucher } = await seedAdjustment("Production");
    const item = ctx.stockItemIds[2];
    const startLocation1 = await inventoryQty(ctx.locationId, item);
    const startLocation2 = await inventoryQty(ctx.location2Id, item);

    const first = await agent.patch(`/api/vouchers/${voucher.id}/adjustment`).send({
      locationId: ctx.locationId,
      items: [{ stockItemId: item, quantity: "9", rate: "5" }],
    });
    expect(first.status).toBe(200);
    expect(await inventoryQty(ctx.locationId, item)).toBeCloseTo(startLocation1 + 9, 3);

    // Re-edit onto the second location: the 9 must come back out of location 1.
    const second = await agent.patch(`/api/vouchers/${voucher.id}/adjustment`).send({
      locationId: ctx.location2Id,
      items: [{ stockItemId: item, quantity: "4", rate: "5" }],
    });
    expect(second.status).toBe(200);

    expect(await inventoryQty(ctx.locationId, item)).toBeCloseTo(startLocation1, 3);
    expect(await inventoryQty(ctx.location2Id, item)).toBeCloseTo(startLocation2 + 4, 3);

    const updated = await voucherRow(voucher.id);
    expect(updated.locationId).toBe(ctx.location2Id);

    // The old line is gone rather than kept alongside the new one.
    const items = await pool.query<{ quantity: string }>(
      `SELECT sai.quantity FROM stock_adjustment_items sai
         JOIN stock_adjustment_vouchers sav ON sav.id = sai.adjustment_id
        WHERE sav.voucher_id = $1`,
      [voucher.id]
    );
    expect(items.rows).toHaveLength(1);
    expect(Number(items.rows[0].quantity)).toBe(4);
  });

  it("requires a location and at least one item", async () => {
    const { voucher } = await seedAdjustment("Production");

    const noItems = await agent
      .patch(`/api/vouchers/${voucher.id}/adjustment`)
      .send({ locationId: ctx.locationId, items: [] });
    expect(noItems.status).toBe(400);
    expect(noItems.body.message).toMatch(/At least one item/i);

    const noLocation = await agent
      .patch(`/api/vouchers/${voucher.id}/adjustment`)
      .send({ items: [{ stockItemId: ctx.stockItemIds[0], quantity: "1", rate: "1" }] });
    expect(noLocation.status).toBe(400);
    expect(noLocation.body.message).toMatch(/Location ID is required/i);

    const header = await pool.query(`SELECT id FROM stock_adjustment_vouchers WHERE voucher_id = $1`, [voucher.id]);
    expect(header.rows).toHaveLength(0);
  });

  it("rejects a non-numeric voucher id", async () => {
    const response = await agent
      .patch("/api/vouchers/nope/adjustment")
      .send({ locationId: ctx.locationId, items: [{ stockItemId: ctx.stockItemIds[0], quantity: "1", rate: "1" }] });
    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/Invalid voucher ID/i);
  });

  it("returns 404 for an unknown voucher and 400 for a voucher of the wrong type", async () => {
    const missing = await agent
      .patch("/api/vouchers/99999999/adjustment")
      .send({ locationId: ctx.locationId, items: [{ stockItemId: ctx.stockItemIds[0], quantity: "1", rate: "1" }] });
    expect(missing.status).toBe(404);

    const { voucher } = await seedPurchase();
    const wrongType = await agent
      .patch(`/api/vouchers/${voucher.id}/adjustment`)
      .send({ locationId: ctx.locationId, items: [{ stockItemId: ctx.stockItemIds[0], quantity: "1", rate: "1" }] });
    expect(wrongType.status).toBe(400);
    expect(wrongType.body.message).toMatch(/Consumption, Production, or Mixed/i);
  });

  it("refuses a foreign adjustment voucher at the tenant boundary without touching inventory", async () => {
    const [foreignCompany] = await db
      .insert(schema.companies)
      .values({
        code: `${TEST_PREFIX.slice(0, 4).toUpperCase()}FGA`,
        name: `${TEST_PREFIX}_ForeignAdjCompany`,
        baseCurrency: "USD",
      })
      .returning();
    const [foreignVoucher] = await db
      .insert(schema.vouchers)
      .values({
        companyId: foreignCompany.id,
        voucherType: "Production",
        voucherNumber: `${TEST_PREFIX}-FGA1`,
        voucherDate: "2026-01-05",
        totalAmount: "0",
        currency: "USD",
      })
      .returning();
    const before = await inventoryQty(ctx.locationId, ctx.stockItemIds[0]);

    try {
      const response = await agent
        .patch(`/api/vouchers/${foreignVoucher.id}/adjustment`)
        .send({ locationId: ctx.locationId, items: [{ stockItemId: ctx.stockItemIds[0], quantity: "5", rate: "1" }] });

      expect(response.status).toBe(404);
      expect(response.body.code).toBe("CROSS_COMPANY_ACCESS_DENIED");
      expect(await inventoryQty(ctx.locationId, ctx.stockItemIds[0])).toBeCloseTo(before, 3);
    } finally {
      await db.delete(schema.vouchers).where(eq(schema.vouchers.id, foreignVoucher.id));
      await db.delete(schema.companies).where(eq(schema.companies.id, foreignCompany.id));
    }
  });

  it("refuses View Only, Normal User and a Manager editing an older adjustment", async () => {
    const { voucher } = await seedAdjustment("Production");
    const before = await inventoryQty(ctx.locationId, ctx.stockItemIds[0]);

    await setRole("Normal User");
    const normalUser = await agent
      .patch(`/api/vouchers/${voucher.id}/adjustment`)
      .send({ locationId: ctx.locationId, items: [{ stockItemId: ctx.stockItemIds[0], quantity: "5", rate: "1" }] });
    expect(normalUser.status).toBe(403);
    expect(normalUser.body).toMatchObject({ key: "mod_accounting", permType: "module" });

    await setRole("View Only");
    const viewOnly = await agent
      .patch(`/api/vouchers/${voucher.id}/adjustment`)
      .send({ locationId: ctx.locationId, items: [{ stockItemId: ctx.stockItemIds[0], quantity: "5", rate: "1" }] });
    expect(viewOnly.status).toBe(403);
    expect(viewOnly.body.message).toMatch(/Insufficient permissions to edit vouchers/i);

    await setRole("Manager");
    const manager = await agent
      .patch(`/api/vouchers/${voucher.id}/adjustment`)
      .send({ locationId: ctx.locationId, items: [{ stockItemId: ctx.stockItemIds[0], quantity: "5", rate: "1" }] });
    expect(manager.status).toBe(403);
    expect(manager.body.message).toMatch(/only edit today's vouchers/i);

    expect(await inventoryQty(ctx.locationId, ctx.stockItemIds[0])).toBeCloseTo(before, 3);
    const header = await pool.query(`SELECT id FROM stock_adjustment_vouchers WHERE voucher_id = $1`, [voucher.id]);
    expect(header.rows).toHaveLength(0);
  });
});
