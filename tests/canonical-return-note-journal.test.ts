/**
 * Canonical journal evidence for returns.
 *
 * A credit note takes a customer's goods back into a location; a debit note
 * sends goods back out to a supplier. Both move stock and neither recorded
 * anything the reconciliation could read.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";
import { db, pool } from "../server/db";
import * as schema from "../shared/schema";

const TEST_PREFIX = "canonret";

let ctx: TestContext;
let agent: request.SuperAgentTest;

async function noteJournalRows(sourceType: string) {
  const { rows } = await pool.query(
    `SELECT quantity_delta, unit_cost, movement_kind, location_id, source_id, source_type, idempotency_key
       FROM canonical_stock_movements
      WHERE company_id = $1 AND source_type = $2
      ORDER BY id`,
    [ctx.companyId, sourceType]
  );
  return rows;
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  agent = request.agent(ctx.app);
  await agent.post("/api/auth/login").send({
    username: `${TEST_PREFIX}_testuser`,
    password: "testpassword123",
  });
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });

  await db
    .insert(schema.inventory)
    .values({
      companyId: ctx.companyId,
      locationId: ctx.locationId,
      stockItemId: ctx.stockItemIds[0],
      quantity: "100.000",
      averageRate: "6.00",
      totalValue: "600.00",
    })
    .onConflictDoNothing();
}, 60000);

afterAll(async () => {
  await pool.query(`DELETE FROM canonical_stock_movement_audit WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM canonical_stock_movement_requests WHERE company_id = $1`, [ctx.companyId]);
  await pool.query(`DELETE FROM canonical_stock_movements WHERE company_id = $1`, [ctx.companyId]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 30000);

describe("canonical journal for return notes", () => {
  it("records a receipt when a credit note takes goods back", async () => {
    const res = await agent.post("/api/credit-notes").send({
      noteType: "Credit Note",
      voucherDate: new Date().toISOString().split("T")[0],
      cashAccountType: "ledger",
      cashAccountId: ctx.cashAccountId,
      description: "canonical journal credit note",
      items: [
        {
          stockItemId: ctx.stockItemIds[0],
          locationId: ctx.locationId,
          quantity: "4",
          refundRate: "9.00",
          inventoryCost: "6.00",
        },
      ],
    });
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);

    const rows = await noteJournalRows("credit-note");
    expect(rows).toHaveLength(1);
    expect(rows[0].movement_kind).toBe("receipt");
    // Goods came back in, at the inventory cost the note carries.
    expect(Number(rows[0].quantity_delta)).toBe(4);
    expect(Number(rows[0].unit_cost)).toBeCloseTo(6, 2);
    expect(Number(rows[0].location_id)).toBe(ctx.locationId);
  }, 60000);

  it("posts the exact $0.01 variance so a credit note commits with balanced entries", async () => {
    const res = await agent.post("/api/credit-notes").send({
      noteType: "Credit Note",
      voucherDate: new Date().toISOString().split("T")[0],
      cashAccountType: "ledger",
      cashAccountId: ctx.cashAccountId,
      description: "one-cent credit-note create regression",
      items: [{
        stockItemId: ctx.stockItemIds[0],
        locationId: ctx.locationId,
        quantity: "1",
        refundRate: "100.00",
        inventoryCost: "99.99",
      }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const { rows } = await pool.query(
      `SELECT ROUND(COALESCE(SUM(debit_amount), 0), 2)::text AS debits,
              ROUND(COALESCE(SUM(credit_amount), 0), 2)::text AS credits,
              ROUND(COALESCE(SUM(debit_amount) FILTER
                (WHERE narration = 'Variance between refund and inventory cost'), 0), 2)::text AS variance_debit
         FROM voucher_entries WHERE voucher_id = $1`,
      [res.body.voucherId]
    );
    expect(Number(rows[0].debits)).toBe(100);
    expect(Number(rows[0].credits)).toBe(100);
    expect(Number(rows[0].variance_debit)).toBe(0.01);
  }, 60000);

  it("also posts the exact $0.01 variance when editing a credit note", async () => {
    const voucherDate = new Date().toISOString().split("T")[0];
    const base = {
      voucherDate,
      cashAccountType: "ledger",
      cashAccountId: ctx.cashAccountId,
      description: "one-cent credit-note edit regression",
    };
    const item = {
      stockItemId: ctx.stockItemIds[0],
      locationId: ctx.locationId,
      quantity: "1",
      refundRate: "100.00",
      inventoryCost: "100.00",
    };
    const created = await agent.post("/api/credit-notes").send({
      ...base,
      noteType: "Credit Note",
      items: [item],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const voucherId = created.body.voucherId;
    const edited = await agent.patch(`/api/credit-notes/${voucherId}`).send({
      ...base,
      items: [{ ...item, inventoryCost: "99.99" }],
    });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    const { rows } = await pool.query(
      `SELECT ROUND(COALESCE(SUM(debit_amount), 0), 2)::text AS debits,
              ROUND(COALESCE(SUM(credit_amount), 0), 2)::text AS credits,
              ROUND(COALESCE(SUM(debit_amount) FILTER
                (WHERE narration = 'Variance between refund and inventory cost'), 0), 2)::text AS variance_debit
         FROM voucher_entries WHERE voucher_id = $1`,
      [voucherId]
    );
    expect(Number(rows[0].debits)).toBe(100);
    expect(Number(rows[0].credits)).toBe(100);
    expect(Number(rows[0].variance_debit)).toBe(0.01);
  }, 60000);

  it("records an issue when a debit note sends goods back to a supplier", async () => {
    const res = await agent.post("/api/credit-notes").send({
      noteType: "Debit Note",
      voucherDate: new Date().toISOString().split("T")[0],
      cashAccountType: "ledger",
      cashAccountId: ctx.cashAccountId,
      description: "canonical journal debit note",
      items: [
        {
          stockItemId: ctx.stockItemIds[0],
          locationId: ctx.locationId,
          quantity: "3",
          refundRate: "9.00",
          inventoryCost: "6.00",
        },
      ],
    });
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);

    const rows = await noteJournalRows("debit-note");
    expect(rows).toHaveLength(1);
    expect(rows[0].movement_kind).toBe("issue");
    // Goods went back out, so the delta is negative.
    expect(Number(rows[0].quantity_delta)).toBe(-3);
    expect(Number(rows[0].location_id)).toBe(ctx.locationId);

    // The two note types are separate document families, never sharing a key.
    const creditRows = await noteJournalRows("credit-note");
    const keys = new Set([...creditRows, ...rows].map((row) => row.idempotency_key));
    expect(keys.size).toBe(creditRows.length + rows.length);
  }, 60000);
});

describe("canonical journal for waste dispatch", () => {
  it("records the waste consumption through the adjustment path it already uses", async () => {
    const before = await noteJournalRows("stock-adjustment");

    const res = await agent.post("/api/waste-dispatches").send({
      locationId: ctx.locationId,
      dispatchDate: new Date().toISOString().split("T")[0],
      notes: "canonical journal waste",
      items: [{ stockItemId: ctx.stockItemIds[0], quantity: "2" }],
    });
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);

    // Waste is dispatched through storage.createStockAdjustment, so it needs no
    // wiring of its own — but that has to be verified rather than assumed, or a
    // future change to the waste route could quietly stop recording evidence.
    const after = await noteJournalRows("stock-adjustment");
    const written = after.slice(before.length);
    expect(written).toHaveLength(1);
    expect(written[0].movement_kind).toBe("issue");
    expect(Number(written[0].quantity_delta)).toBe(-2);
    expect(Number(written[0].location_id)).toBe(ctx.locationId);
  }, 60000);
});
