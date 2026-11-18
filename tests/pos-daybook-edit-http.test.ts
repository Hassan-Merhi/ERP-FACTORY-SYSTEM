import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, getInventoryQty, seedTestData, type TestContext } from "./setup";

const PREFIX = `p3pos${Date.now().toString(36)}`;
let ctx: TestContext;
let cashier: request.SuperAgentTest;
let cashierId = "";
let voucherId = 0;
let shiftId = 0;
const today = new Date().toISOString().slice(0, 10);
const oldDate = new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10);

const editBody = () => ({
  voucherDate: today,
  locationId: ctx.locationId,
  description: "Edited in Daybook popup",
  isCreditSale: false,
  items: [{ stockItemId: ctx.stockItemIds[0], quantity: "3", sellingPrice: "24" }],
});

beforeAll(async () => {
  ctx = await seedTestData(PREFIX);
  const bcrypt = await import("bcryptjs");
  const username = `${PREFIX}_cashier`;
  const hashed = await bcrypt.hash("testpassword123", 10);
  const user = await pool.query<{ id: string }>(
    "INSERT INTO users (username, password, active) VALUES ($1, $2, true) RETURNING id",
    [username, hashed]
  );
  cashierId = user.rows[0].id;
  await pool.query(
    `INSERT INTO user_company_roles
       (user_id, company_id, role, assigned_location_id, cash_account_id, daybook_edit_days)
       VALUES ($1, $2, 'POS', $3, $4, 2)`,
    [cashierId, ctx.companyId, ctx.locationId, ctx.cashAccountId]
  );
  await pool.query(
    "INSERT INTO user_locations (user_id, company_id, location_id) VALUES ($1, $2, $3)",
    [cashierId, ctx.companyId, ctx.locationId]
  );

  cashier = request.agent(ctx.app) as request.SuperAgentTest;
  const login = await cashier.post("/api/auth/login").send({ username, password: "testpassword123" });
  expect(login.status, login.text).toBe(200);
  const selected = await cashier.post("/api/auth/set-company").send({ companyId: ctx.companyId });
  expect(selected.status, selected.text).toBe(200);

  const opened = await cashier.post("/api/pos/shifts/open").send({
    locationId: ctx.locationId,
    cashAccountId: ctx.cashAccountId,
    openingCash: "0",
    posStation: 1,
  });
  expect(opened.status, opened.text).toBe(200);
  shiftId = Number(opened.body.id);

  const sale = await cashier.post("/api/pos/sales").send({
    locationId: ctx.locationId,
    shiftId,
    clientSaleId: randomUUID(),
    voucherDate: today,
    paymentAccountType: "cash",
    paymentAccountId: ctx.cashAccountId,
    isCreditSale: false,
    items: [{ stockItemId: ctx.stockItemIds[0], quantity: "2", rate: "20" }],
  });
  expect(sale.status, sale.text).toBe(200);
  voucherId = Number(sale.body.voucher.id);
}, 120_000);

afterAll(async () => {
  if (ctx) await cleanupTestData(PREFIX);
  closeTestServer();
}, 120_000);

describe("Phase 3 Zambia POS Daybook sale editing HTTP", () => {
  it("reads the active company editing window and business date from the server", async () => {
    const response = await cashier.get("/api/pos/daybook-edit-status");
    expect(response.status, response.text).toBe(200);
    expect(response.body).toMatchObject({
      role: "POS",
      daybookEditDays: 2,
      posViewOnly: false,
      businessDate: today,
    });
  });

  it("lists the shift owner's ID so their sale can open in the Daybook popup", async () => {
    const result = await cashier.get(`/api/vouchers?startDate=${today}&endDate=${today}`);
    expect(result.status, result.text).toBe(200);
    const row = result.body.find((voucher: { id: number }) => voucher.id === voucherId);
    expect(row).toMatchObject({ id: voucherId, userId: cashierId });
    expect((await cashier.get(`/api/vouchers/${voucherId}`)).status).toBe(200);
  });

  it("saves an in-window edit of items and notes with original payment unchanged", async () => {
    const initialStock = await getInventoryQty(ctx.locationId, ctx.stockItemIds[0]);
    const originalEntry = await pool.query<{ ledger_account_id: number }>(
      `SELECT ledger_account_id FROM voucher_entries WHERE voucher_id = $1 AND debit_amount > 0 LIMIT 1`,
      [voucherId]
    );
    const response = await cashier.put(`/api/vouchers/${voucherId}/sales`).send(editBody());
    expect(response.status, response.text).toBe(200);
    const updated = await pool.query<{ total_amount: string; description: string; voucher_date: string }>(
      "SELECT total_amount, description, voucher_date::text FROM vouchers WHERE id = $1",
      [voucherId]
    );
    expect(updated.rows[0]).toMatchObject({
      total_amount: "72.00",
      description: "Edited in Daybook popup",
      voucher_date: today,
    });
    expect(await getInventoryQty(ctx.locationId, ctx.stockItemIds[0])).toBe(initialStock - 1);
    const payment = await pool.query<{ ledger_account_id: number }>(
      `SELECT ledger_account_id FROM voucher_entries WHERE voucher_id = $1 AND debit_amount > 0 LIMIT 1`,
      [voucherId]
    );
    expect(payment.rows[0].ledger_account_id).toBe(originalEntry.rows[0].ledger_account_id);
  });

  it("rejects payment, credit-status, date and location changes from POS", async () => {
    const variants = [
      { ...editBody(), paymentAccountId: ctx.cashAccountId },
      { ...editBody(), isCreditSale: true },
      { ...editBody(), voucherDate: oldDate },
      { ...editBody(), locationId: ctx.location2Id },
    ];
    for (const variant of variants) {
      const result = await cashier.put(`/api/vouchers/${voucherId}/sales`).send(variant);
      expect(result.status, result.text).toBe(403);
    }
  });

  it("opens and edits a different shift's sale at an assigned location without exposing ERP costs", async () => {
    const wrongShift = await pool.query<{ id: number }>(
      `INSERT INTO pos_shifts (company_id, location_id, user_id, username)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [ctx.companyId, ctx.locationId, ctx.userId, "Admin"]
    );
    await pool.query("UPDATE vouchers SET shift_id = $1 WHERE id = $2", [wrongShift.rows[0].id, voucherId]);
    try {
      const listed = await cashier.get(`/api/vouchers?startDate=${today}&endDate=${today}`);
      expect(listed.status, listed.text).toBe(200);
      const row = listed.body.find((voucher: { id: number }) => voucher.id === voucherId);
      expect(row).toMatchObject({ id: voucherId, userId: ctx.userId });

      const details = await cashier.get(`/api/vouchers/${voucherId}`);
      expect(details.status, details.text).toBe(200);
      expect(details.body).toMatchObject({ id: voucherId, voucherType: "Sales", entries: [] });
      expect(details.body.salesItems.length).toBeGreaterThan(0);
      expect(details.body.salesItems[0]).toHaveProperty("sellingPrice");
      expect(details.body.salesItems[0]).not.toHaveProperty("costPrice");
      expect(details.body.salesItems[0]).not.toHaveProperty("profit");
      expect(details.body).not.toHaveProperty("purchaseOrder");
      expect(details.body).not.toHaveProperty("transferData");

      const edited = await cashier.put(`/api/vouchers/${voucherId}/sales`).send(editBody());
      expect(edited.status, edited.text).toBe(200);
      expect(edited.body.items[0]).not.toHaveProperty("costPrice");
      expect(edited.body.items[0]).not.toHaveProperty("totalCost");
      expect(edited.body.items[0]).not.toHaveProperty("profit");
      expect(edited.body.voucher).not.toHaveProperty("shiftId");
    } finally {
      await pool.query("UPDATE vouchers SET shift_id = $1 WHERE id = $2", [shiftId, voucherId]);
    }
  });

  it("denies viewing or editing a sale from an unassigned location", async () => {
    const otherSale = await pool.query<{ id: number }>(
      `INSERT INTO vouchers (company_id, location_id, voucher_number, voucher_type, voucher_date, total_amount)
       VALUES ($1, $2, $3, 'Sales', $4, '10') RETURNING id`,
      [ctx.companyId, ctx.location2Id, `${PREFIX}-OTHER-LOCATION`, today]
    );
    expect((await cashier.get(`/api/vouchers/${otherSale.rows[0].id}`)).status).toBe(404);
    const edit = await cashier.put(`/api/vouchers/${otherSale.rows[0].id}/sales`).send(editBody());
    expect(edit.status).toBe(403);
  });

  it("checks the original saved date when voucherDate is omitted and ignores forged client date headers", async () => {
    const oldSale = await pool.query<{ id: number }>(
      `INSERT INTO vouchers (company_id, location_id, voucher_number, voucher_type, voucher_date, total_amount, shift_id)
       VALUES ($1, $2, $3, 'Sales', $4, '10', $5) RETURNING id`,
      [ctx.companyId, ctx.locationId, `${PREFIX}-OLD`, oldDate, shiftId]
    );
    const result = await cashier
      .put(`/api/vouchers/${oldSale.rows[0].id}/sales`)
      .set("X-Client-Date", oldDate)
      .send({ isCreditSale: false, items: editBody().items });
    expect(result.status).toBe(403);
    expect(result.body.code).toBe("POS_SALE_EDIT_OUTSIDE_WINDOW");
  });

  it("revokes editing immediately for PUT and PATCH, even without another login", async () => {
    await pool.query(
      "UPDATE user_company_roles SET daybook_edit_days = 0 WHERE user_id = $1 AND company_id = $2",
      [cashierId, ctx.companyId]
    );
    const liveStatus = await cashier.get("/api/pos/daybook-edit-status");
    expect(liveStatus.status).toBe(200);
    expect(liveStatus.body.daybookEditDays).toBe(0);
    expect((await cashier.get(`/api/vouchers/${voucherId}`)).status).toBe(200);
    for (const method of ["put", "patch"] as const) {
      const result = await cashier[method](`/api/vouchers/${voucherId}/sales`).send(editBody());
      expect(result.status).toBe(403);
      expect(result.body.code).toBe("POS_SALE_EDIT_DISABLED");
    }
  });

  it("refuses view-only POS edits even with a previously enabled day window", async () => {
    await pool.query(
      "UPDATE user_company_roles SET daybook_edit_days = 2, pos_view_only = true WHERE user_id = $1 AND company_id = $2",
      [cashierId, ctx.companyId]
    );
    const liveStatus = await cashier.get("/api/pos/daybook-edit-status");
    expect(liveStatus.body.posViewOnly).toBe(true);
    expect((await cashier.get(`/api/vouchers/${voucherId}`)).status).toBe(200);
    const response = await cashier.put(`/api/vouchers/${voucherId}/sales`).send(editBody());
    expect(response.status).toBe(403);
  });
});
