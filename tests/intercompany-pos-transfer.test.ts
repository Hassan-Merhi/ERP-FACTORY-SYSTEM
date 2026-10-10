/**
 * Intercompany POS mirror (server/routes/helpers/intercompanyHelpers.ts).
 *
 * Each cash POS sale in a source company is mirrored into two daily
 * running-total journals: INTERCO-SRC in the source company and INTERCO-DST in
 * the destination. The properties held here:
 *
 *   - **No lost updates.** Concurrent sales serialize on a per-source lock; the
 *     old read-modify-write let parallel sales overwrite each other's totals.
 *   - **All or nothing.** If the destination side cannot be written, the
 *     source side is rolled back with it.
 *   - **Recalculation rebuilds exactly** from the day's cash sales, and only
 *     touches the recalculating source's journals: a second source feeding the
 *     same destination keeps its own DST voucher.
 *   - **Deleting a sale removes it from the mirror.**
 */
import request from "supertest";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, inArray, isNull, like } from "drizzle-orm";

import { db, pool } from "../server/db";
import * as schema from "../shared/schema";
import {
  recalculateIntercompanyForDate,
  runIntercompanyPosTransfer,
} from "../server/routes/helpers/intercompanyHelpers";
import { ensureClosedPeriodGuard } from "../server/services/accounting/closedPeriodGuard";
import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";

const SOURCE_A = "icsrcaa";
const SOURCE_B = "icsrcbb";
const DEST = "icdestt";

let a: TestContext;
let b: TestContext;
let dest: TestContext;
let destIntercoId: number;

async function interco(companyId: number, prefix: string, label: string) {
  const [account] = await db
    .insert(schema.ledgerAccounts)
    .values({
      companyId,
      code: `${prefix}_${label}`,
      name: `Intercompany ${label}`,
      accountType: "Asset",
      openingBalance: "0",
      openingBalanceSide: "Dr",
    })
    .returning();
  return account.id;
}

/** Debit and credit totals per ledger account for one voucher, as strings. */
async function journalByNumber(companyId: number, voucherNumber: string) {
  const [voucher] = await db
    .select()
    .from(schema.vouchers)
    .where(and(eq(schema.vouchers.companyId, companyId), eq(schema.vouchers.voucherNumber, voucherNumber)));
  if (!voucher) return null;
  const entries = await db.select().from(schema.voucherEntries).where(eq(schema.voucherEntries.voucherId, voucher.id));
  const lines = new Map<number, { debit: number; credit: number }>();
  for (const entry of entries) {
    const line = lines.get(entry.ledgerAccountId!) ?? { debit: 0, credit: 0 };
    line.debit += Number(entry.debitAmount);
    line.credit += Number(entry.creditAmount);
    lines.set(entry.ledgerAccountId!, line);
  }
  return { voucher, lines };
}

async function postCashSale(ctx: TestContext, number: string, date: string, amount: string) {
  const [voucher] = await db
    .insert(schema.vouchers)
    .values({
      companyId: ctx.companyId,
      voucherNumber: number,
      voucherType: "Sales",
      voucherDate: date,
      totalAmount: amount,
    })
    .returning();
  await db.insert(schema.voucherEntries).values([
    { voucherId: voucher.id, ledgerAccountId: ctx.cashAccountId, debitAmount: amount, creditAmount: "0" },
    { voucherId: voucher.id, ledgerAccountId: ctx.salesAccountId, debitAmount: "0", creditAmount: amount },
  ]);
  return voucher.id;
}

const srcNumber = (ctx: TestContext, date: string) => `INTERCO-SRC-${ctx.companyId}-${date}`;
const dstNumber = (ctx: TestContext, date: string) => `INTERCO-DST-${dest.companyId}-${date}-S${ctx.companyId}`;

async function cleanupConfigs() {
  const companyIds = [a, b, dest].filter(Boolean).map((ctx) => ctx.companyId);
  if (companyIds.length > 0) {
    await db
      .delete(schema.intercompanyPosConfigs)
      .where(inArray(schema.intercompanyPosConfigs.sourceCompanyId, companyIds));
  }
}

beforeAll(async () => {
  a = await seedTestData(SOURCE_A);
  b = await seedTestData(SOURCE_B);
  dest = await seedTestData(DEST);
  await ensureClosedPeriodGuard(pool);
  await cleanupConfigs();

  destIntercoId = await interco(dest.companyId, DEST, "IN");
  for (const source of [a, b]) {
    const prefix = source === a ? SOURCE_A : SOURCE_B;
    await db.insert(schema.intercompanyPosConfigs).values({
      sourceCompanyId: source.companyId,
      destCompanyId: dest.companyId,
      sourceIntercoAccountId: await interco(source.companyId, prefix, "OUT"),
      destIntercoAccountId: destIntercoId,
      enabled: true,
    });
  }
}, 180000);

afterAll(async () => {
  await cleanupConfigs();
  await cleanupTestData(SOURCE_A);
  await cleanupTestData(SOURCE_B);
  await cleanupTestData(DEST);
  closeTestServer();
}, 90000);

describe("intercompany POS mirror", () => {
  it("keeps every concurrent sale in the running totals", async () => {
    const date = "2026-04-01";
    const results = await Promise.all(
      Array.from({ length: 20 }, () => runIntercompanyPosTransfer(a.companyId, a.cashAccountId, 1.1, date))
    );
    expect(results.every(Boolean)).toBe(true);

    const src = await journalByNumber(a.companyId, srcNumber(a, date));
    expect(src!.voucher.totalAmount).toBe("22.00");
    expect(src!.lines.get(a.cashAccountId)!.credit).toBeCloseTo(22, 2);

    const dst = await journalByNumber(dest.companyId, dstNumber(a, date));
    expect(dst!.voucher.totalAmount).toBe("22.00");
    expect(dst!.lines.get(dest.cashAccountId)!.debit).toBeCloseTo(22, 2);
    expect(dst!.lines.get(destIntercoId)!.credit).toBeCloseTo(22, 2);
  });

  it("rebuilds a date exactly from its cash sales and leaves another source's journal alone", async () => {
    const date = "2026-04-02";
    await postCashSale(a, `${SOURCE_A}-S1`, date, "30.00");
    await postCashSale(a, `${SOURCE_A}-S2`, date, "20.00");
    // A stale mirror that disagrees with the sales.
    await runIntercompanyPosTransfer(a.companyId, a.cashAccountId, 999, date);
    // Source B feeds the same destination on the same date.
    await runIntercompanyPosTransfer(b.companyId, b.cashAccountId, 7, date);

    expect(await recalculateIntercompanyForDate(a.companyId, date)).toBe(true);

    const src = await journalByNumber(a.companyId, srcNumber(a, date));
    expect(src!.voucher.totalAmount).toBe("50.00");
    const dst = await journalByNumber(dest.companyId, dstNumber(a, date));
    expect(dst!.voucher.totalAmount).toBe("50.00");

    const otherSource = await journalByNumber(dest.companyId, dstNumber(b, date));
    expect(otherSource!.voucher.totalAmount).toBe("7.00");
  });

  it("writes neither side when the destination side is refused", async () => {
    const date = "2026-03-15";
    // Close the destination's books through the sale date.
    const [closingVoucher] = await db
      .insert(schema.vouchers)
      .values({
        companyId: dest.companyId,
        voucherNumber: `${DEST}-CLOSE`,
        voucherType: "Journal",
        voucherDate: "2026-03-31",
        totalAmount: "0",
      })
      .returning();
    await db.insert(schema.fiscalPeriodClosures).values({
      companyId: dest.companyId,
      periodStartDate: "2026-01-01",
      periodEndDate: "2026-03-31",
      closedByUserId: dest.userId,
      closingVoucherId: closingVoucher.id,
      retainedEarningsAccountId: destIntercoId,
      totalIncome: "0",
      totalExpense: "0",
      netIncome: "0",
    });

    try {
      expect(await runIntercompanyPosTransfer(a.companyId, a.cashAccountId, 12.5, date)).toBe(false);
      expect(await journalByNumber(a.companyId, srcNumber(a, date))).toBeNull();
    } finally {
      await db.delete(schema.fiscalPeriodClosures).where(eq(schema.fiscalPeriodClosures.companyId, dest.companyId));
    }
  });

  it("drops a deleted sale from the mirror", async () => {
    const date = "2026-04-03";
    await postCashSale(a, `${SOURCE_A}-D1`, date, "40.00");
    const deletedSaleId = await postCashSale(a, `${SOURCE_A}-D2`, date, "15.00");
    expect(await recalculateIntercompanyForDate(a.companyId, date)).toBe(true);
    expect((await journalByNumber(dest.companyId, dstNumber(a, date)))!.voucher.totalAmount).toBe("55.00");

    const agent = request.agent(a.app);
    expect(
      (await agent.post("/api/auth/login").send({ username: `${SOURCE_A}_testuser`, password: "testpassword123" }))
        .status
    ).toBe(200);
    expect((await agent.post("/api/auth/set-company").send({ companyId: a.companyId })).status).toBe(200);
    const response = await agent.delete(`/api/vouchers/${deletedSaleId}`);
    expect(response.status).toBe(200);

    expect((await journalByNumber(a.companyId, srcNumber(a, date)))!.voucher.totalAmount).toBe("40.00");
    expect((await journalByNumber(dest.companyId, dstNumber(a, date)))!.voucher.totalAmount).toBe("40.00");
  });

  it("names destination journals per source company", async () => {
    const shared = await db
      .select({ number: schema.vouchers.voucherNumber })
      .from(schema.vouchers)
      .where(
        and(
          eq(schema.vouchers.companyId, dest.companyId),
          like(schema.vouchers.voucherNumber, `INTERCO-DST-${dest.companyId}-2026-04-02%`),
          // Wave 16 (A): a rebuild retires the old journal (soft delete, renumbered).
          isNull(schema.vouchers.deletedAt)
        )
      );
    expect(shared.map((row) => row.number).sort()).toEqual(
      [dstNumber(a, "2026-04-02"), dstNumber(b, "2026-04-02")].sort()
    );
  });
});

describe("intercompany POS rebuild endpoint", () => {
  async function adminAgent() {
    const agent = request.agent(a.app);
    expect(
      (await agent.post("/api/auth/login").send({ username: `${SOURCE_A}_testuser`, password: "testpassword123" }))
        .status
    ).toBe(200);
    expect((await agent.post("/api/auth/set-company").send({ companyId: a.companyId })).status).toBe(200);
    return agent;
  }

  it("restores a missing destination journal for every sales date in the range", async () => {
    const date = "2026-04-10";
    await postCashSale(a, `${SOURCE_A}-R1`, date, "25.00");
    expect(await recalculateIntercompanyForDate(a.companyId, date)).toBe(true);
    // Simulate the pre-fix state: the destination side was never written.
    const dst = await journalByNumber(dest.companyId, dstNumber(a, date));
    await db.delete(schema.voucherEntries).where(eq(schema.voucherEntries.voucherId, dst!.voucher.id));
    await db.delete(schema.vouchers).where(eq(schema.vouchers.id, dst!.voucher.id));

    const agent = await adminAgent();
    const response = await agent
      .post("/api/intercompany-pos-config/rebuild")
      .send({ fromDate: "2026-04-09", toDate: "2026-04-11" });
    expect(response.status).toBe(200);
    expect(response.body.failedDates).toEqual([]);
    expect(response.body.datesRebuilt).toBe(response.body.datesChecked);
    expect((await journalByNumber(dest.companyId, dstNumber(a, date)))!.voucher.totalAmount).toBe("25.00");
  });

  it("refuses malformed, backwards and oversized ranges", async () => {
    const agent = await adminAgent();
    for (const body of [
      { fromDate: "2026-4-1", toDate: "2026-04-02" },
      { fromDate: "2026-04-05", toDate: "2026-04-01" },
      { fromDate: "2025-01-01", toDate: "2026-04-01" },
    ]) {
      expect((await agent.post("/api/intercompany-pos-config/rebuild").send(body)).status).toBe(400);
    }
  });
});
