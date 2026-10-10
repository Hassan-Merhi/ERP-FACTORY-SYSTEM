/**
 * Wave 9 ledger safety (docs/accounting-audit-2026-10.md, section 7).
 *
 * Live paths that could commit an unbalanced active voucher, and the automatic
 * FX revaluation that posted wrong journals:
 *   - POST /api/exchange-rates only saves the rate (no FX-REVAL journal);
 *   - PATCH /api/voucher-entries/:id re-validates the voucher's stored lines;
 *   - PATCH /api/vouchers/:id/optional refuses to activate unbalanced lines;
 *   - POST /api/vouchers/:id/finalize is Admin/Owner only, validated and audited;
 *   - PUT /api/vouchers/:id/with-entries refuses re-typing a balanced voucher to
 *     an exempt type.
 */
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import * as schema from "../shared/schema";
import { db, pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "w9ledger";
const today = new Date().toISOString().slice(0, 10);
const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

let ctx: TestContext;
let admin: request.SuperAgentTest;
let manager: request.SuperAgentTest;
let sequence = 0;

/** A voucher with two lines (cash Dr / sales Cr) written straight to the database. */
async function seedVoucher(options: {
  voucherType?: string;
  optional: boolean;
  debit: string;
  credit: string;
}): Promise<{ voucherId: number; debitEntryId: number; creditEntryId: number }> {
  sequence += 1;
  const [voucher] = await db
    .insert(schema.vouchers)
    .values({
      companyId: ctx.companyId,
      voucherNumber: `${TEST_PREFIX.toUpperCase()}-${sequence}-${Date.now()}`,
      voucherType: options.voucherType ?? "Journal",
      voucherDate: today,
      description: "wave 9 ledger safety fixture",
      totalAmount: options.debit,
      currency: "USD",
      optional: options.optional,
    })
    .returning();
  const [debitLine, creditLine] = await db
    .insert(schema.voucherEntries)
    .values([
      { voucherId: voucher.id, ledgerAccountId: ctx.cashAccountId, debitAmount: options.debit, creditAmount: "0" },
      { voucherId: voucher.id, ledgerAccountId: ctx.salesAccountId, debitAmount: "0", creditAmount: options.credit },
    ])
    .returning();
  return { voucherId: voucher.id, debitEntryId: debitLine.id, creditEntryId: creditLine.id };
}

async function voucherRow(id: number) {
  const [row] = await db.select().from(schema.vouchers).where(eq(schema.vouchers.id, id));
  return row;
}

async function entryAmounts(voucherId: number) {
  const rows = await db
    .select({
      id: schema.voucherEntries.id,
      d: schema.voucherEntries.debitAmount,
      c: schema.voucherEntries.creditAmount,
    })
    .from(schema.voucherEntries)
    .where(eq(schema.voucherEntries.voucherId, voucherId))
    .orderBy(schema.voucherEntries.id);
  return rows.map((row) => [Number(row.d), Number(row.c)]);
}

async function auditRows(tableName: string, recordId: number) {
  return db
    .select()
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.companyId, ctx.companyId),
        eq(schema.auditLog.tableName, tableName),
        eq(schema.auditLog.recordId, recordId)
      )
    );
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  admin = request.agent(ctx.app);
  await admin.post("/api/auth/login").send({ username: `${TEST_PREFIX}_testuser`, password: "testpassword123" });
  await admin.post("/api/auth/set-company").send({ companyId: ctx.companyId });

  // A second user of the same company with the Manager role.
  const bcrypt = await import("bcryptjs");
  const [managerUser] = await db
    .insert(schema.users)
    .values({ username: `${TEST_PREFIX}_manager`, password: await bcrypt.hash("testpassword123", 10) })
    .returning();
  await db
    .insert(schema.userCompanyRoles)
    .values({ userId: managerUser.id, companyId: ctx.companyId, role: "Manager" });
  manager = request.agent(ctx.app);
  await manager.post("/api/auth/login").send({ username: `${TEST_PREFIX}_manager`, password: "testpassword123" });
  await manager.post("/api/auth/set-company").send({ companyId: ctx.companyId });
}, 60000);

afterAll(async () => {
  if (ctx) {
    await pool.query("DELETE FROM exchange_rates WHERE company_id = $1", [ctx.companyId]);
    await cleanupTestData(TEST_PREFIX);
  }
  closeTestServer();
}, 30000);

describe("POST /api/exchange-rates only saves the rate", () => {
  it("posts no FX-REVAL journal when a rate changes with a cash balance on the books", async () => {
    // Before wave 9 this setup (a previous rate, a cash balance, a changed rate)
    // auto-posted an "FX-REVAL-*" Journal treating the cash account as CFA.
    await seedVoucher({ optional: false, debit: "1000.00", credit: "1000.00" });
    const countVouchers = async () =>
      Number(
        (await pool.query("SELECT count(*)::int AS n FROM vouchers WHERE company_id = $1", [ctx.companyId])).rows[0].n
      );
    const before = await countVouchers();

    const first = await admin
      .post("/api/exchange-rates")
      .send({ fromCurrency: "USD", toCurrency: "CFA", rate: "600", effectiveDate: yesterday });
    expect(first.status).toBe(200);
    const second = await admin
      .post("/api/exchange-rates")
      .send({ fromCurrency: "USD", toCurrency: "CFA", rate: "650", effectiveDate: today });
    expect(second.status).toBe(200);
    expect(Number(second.body.rate)).toBeCloseTo(650, 4);
    // Re-saving the same day's rate is an update, still with no journal.
    const resave = await admin
      .post("/api/exchange-rates")
      .send({ fromCurrency: "USD", toCurrency: "CFA", rate: "640", effectiveDate: today });
    expect(resave.status).toBe(200);

    expect(await countVouchers()).toBe(before);
    const reval = await pool.query(
      "SELECT count(*)::int AS n FROM vouchers WHERE company_id = $1 AND voucher_number LIKE 'FX-REVAL%'",
      [ctx.companyId]
    );
    expect(reval.rows[0].n).toBe(0);
  }, 30000);
});

describe("PATCH /api/voucher-entries/:id (live currency-aware handler)", () => {
  it("refuses an amount edit that would leave an active Journal unbalanced", async () => {
    const { voucherId, debitEntryId } = await seedVoucher({ optional: false, debit: "100.00", credit: "100.00" });
    const res = await admin.patch(`/api/voucher-entries/${debitEntryId}`).send({ debitAmount: "150" });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Total debits must equal total credits/);
    expect(await entryAmounts(voucherId)).toEqual([
      [100, 0],
      [0, 100],
    ]);
    expect(await auditRows("voucher_entries", debitEntryId)).toHaveLength(0);
  }, 30000);

  it("accepts the edit on an optional voucher and audits the before/after amounts", async () => {
    const { voucherId, debitEntryId } = await seedVoucher({ optional: true, debit: "100.00", credit: "100.00" });
    const res = await admin.patch(`/api/voucher-entries/${debitEntryId}`).send({ debitAmount: "150" });
    expect(res.status).toBe(200);
    expect(await entryAmounts(voucherId)).toEqual([
      [150, 0],
      [0, 100],
    ]);
    const audit = await auditRows("voucher_entries", debitEntryId);
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe("update");
    const changes = audit[0].changes as Record<string, { old?: unknown; new?: unknown }>;
    expect(Number(changes.debitAmount.old)).toBe(100);
    expect(Number(changes.debitAmount.new)).toBe(150);
  }, 30000);
});

describe("PATCH /api/vouchers/:id/optional", () => {
  it("refuses to activate an optional voucher whose lines do not balance", async () => {
    const { voucherId } = await seedVoucher({ optional: true, debit: "100.00", credit: "90.00" });
    const res = await admin.patch(`/api/vouchers/${voucherId}/optional`).send({ optional: false });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Total debits must equal total credits/);
    expect((await voucherRow(voucherId)).optional).toBe(true);
  }, 30000);

  it("activates an optional voucher whose lines balance", async () => {
    const { voucherId } = await seedVoucher({ optional: true, debit: "100.00", credit: "100.00" });
    const res = await admin.patch(`/api/vouchers/${voucherId}/optional`).send({ optional: false });
    expect(res.status).toBe(200);
    expect((await voucherRow(voucherId)).optional).toBe(false);
  }, 30000);
});

describe("POST /api/vouchers/:id/finalize", () => {
  it("is refused for a non-admin role", async () => {
    const { voucherId } = await seedVoucher({ optional: true, debit: "100.00", credit: "100.00" });
    const res = await manager.post(`/api/vouchers/${voucherId}/finalize`).send({});
    expect(res.status).toBe(403);
    expect((await voucherRow(voucherId)).optional).toBe(true);
  }, 30000);

  it("is refused for an unbalanced voucher", async () => {
    const { voucherId } = await seedVoucher({ optional: true, debit: "100.00", credit: "90.00" });
    const res = await admin.post(`/api/vouchers/${voucherId}/finalize`).send({});
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Total debits must equal total credits/);
    expect((await voucherRow(voucherId)).optional).toBe(true);
    expect(await auditRows("vouchers", voucherId)).toHaveLength(0);
  }, 30000);

  it("finalizes a balanced voucher for an Admin and audits it", async () => {
    const { voucherId } = await seedVoucher({ optional: true, debit: "100.00", credit: "100.00" });
    const res = await admin.post(`/api/vouchers/${voucherId}/finalize`).send({});
    expect(res.status).toBe(200);
    expect((await voucherRow(voucherId)).optional).toBe(false);
    const audit = await auditRows("vouchers", voucherId);
    expect(audit).toHaveLength(1);
    expect(audit[0].changes).toMatchObject({ optional: { old: true, new: false } });
  }, 30000);
});

describe("PUT /api/vouchers/:id/with-entries type changes", () => {
  const unbalancedEntries = () => [
    { ledgerAccountId: ctx.cashAccountId, debitAmount: "100", creditAmount: "0" },
    { ledgerAccountId: ctx.salesAccountId, debitAmount: "0", creditAmount: "40" },
  ];

  it("refuses re-typing an active Journal to an exempt type with unbalanced lines", async () => {
    const { voucherId } = await seedVoucher({ optional: false, debit: "100.00", credit: "100.00" });
    for (const voucherType of ["Transfer", "Mixed", "Stock Adjustment"]) {
      const res = await admin.put(`/api/vouchers/${voucherId}/with-entries`).send({
        voucher: { voucherType, voucherDate: today, optional: false },
        entries: unbalancedEntries(),
      });
      expect(res.status, voucherType).toBe(400);
      // Wave 12: stock adjustment types are refused outright on the generic route.
      expect(res.body.message, voucherType).toMatch(
        /exempt from balancing|can only be created and edited from the stock adjustment form/
      );
    }
    expect((await voucherRow(voucherId)).voucherType).toBe("Journal");
    expect(await entryAmounts(voucherId)).toEqual([
      [100, 0],
      [0, 100],
    ]);
  }, 30000);

  it("keeps a same-class type change working when the lines balance", async () => {
    const { voucherId } = await seedVoucher({ optional: false, debit: "100.00", credit: "100.00" });
    const res = await admin.put(`/api/vouchers/${voucherId}/with-entries`).send({
      voucher: { voucherType: "Payment", voucherDate: today, optional: false },
      entries: [
        { ledgerAccountId: ctx.salesAccountId, debitAmount: "75", creditAmount: "0" },
        { ledgerAccountId: ctx.cashAccountId, debitAmount: "0", creditAmount: "75" },
      ],
    });
    expect(res.status).toBe(200);
    expect((await voucherRow(voucherId)).voucherType).toBe("Payment");
  }, 30000);
});
