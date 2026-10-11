/**
 * Intercompany POS mirror (server/routes/helpers/intercompanyHelpers.ts).
 *
 * Phase 22 (B), D7: each cash POS sale in a source company is mirrored as ONE
 * journal per sale in each company (source: Dr interco / Cr cash; destination:
 * Dr the configured destination cash account / Cr interco), posted through the
 * central engine with the sale as posting identity. The daily running-total
 * journals (INTERCO-SRC / INTERCO-DST) are no longer written. The properties
 * held here:
 *
 *   - **No lost or doubled postings.** Concurrent sales each post their own
 *     journal; the same sale mirrored twice posts once.
 *   - **All or nothing.** If the destination side cannot be written, the
 *     source side is rolled back with it.
 *   - **Recalculation rebuilds exactly** from the day's cash sales, and only
 *     touches the recalculating source's journals: a second source feeding the
 *     same destination keeps its own journals.
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

const companyName = async (ctx: TestContext) =>
  (
    await db
      .select({ name: schema.companies.name })
      .from(schema.companies)
      .where(eq(schema.companies.id, ctx.companyId))
  )[0].name;

/**
 * The live mirror journals of `date` in `companyId` whose description starts
 * with `prefix`, with their lines totalled per ledger account.
 */
async function mirrorJournals(companyId: number, date: string, prefix: string) {
  const found = await db
    .select()
    .from(schema.vouchers)
    .where(
      and(
        eq(schema.vouchers.companyId, companyId),
        eq(schema.vouchers.voucherType, "Journal"),
        eq(schema.vouchers.voucherDate, date),
        like(schema.vouchers.description, `${prefix}%`),
        isNull(schema.vouchers.deletedAt)
      )
    );
  const lines = new Map<number, { debit: number; credit: number }>();
  if (found.length > 0) {
    const entries = await db
      .select()
      .from(schema.voucherEntries)
      .where(
        inArray(
          schema.voucherEntries.voucherId,
          found.map((voucher) => voucher.id)
        )
      );
    for (const entry of entries) {
      const line = lines.get(entry.ledgerAccountId!) ?? { debit: 0, credit: 0 };
      line.debit += Number(entry.debitAmount);
      line.credit += Number(entry.creditAmount);
      lines.set(entry.ledgerAccountId!, line);
    }
  }
  const total = found.reduce((sum, voucher) => sum + Number(voucher.totalAmount), 0).toFixed(2);
  return { vouchers: found, lines, total };
}

/** Source-side mirror journals of `ctx` on `date`. */
async function sourceMirror(ctx: TestContext, date: string) {
  return mirrorJournals(ctx.companyId, date, `Cash transferred to ${await companyName(dest)}`);
}

/** Destination-side mirror journals fed by `ctx` on `date`. */
async function destMirror(ctx: TestContext, date: string) {
  return mirrorJournals(dest.companyId, date, `Cash received from ${await companyName(ctx)}`);
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

async function cleanupConfigs() {
  const companyIds = [a, b, dest].filter(Boolean).map((ctx) => ctx.companyId);
  if (companyIds.length > 0) {
    await db
      .delete(schema.intercompanyPosConfigs)
      .where(inArray(schema.intercompanyPosConfigs.sourceCompanyId, companyIds));
    await db
      .delete(schema.intercompanyAccountLinks)
      .where(inArray(schema.intercompanyAccountLinks.sourceCompanyId, companyIds));
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
    // Phase 22 (B), D7: the destination cash account is the configured link.
    await db.insert(schema.intercompanyAccountLinks).values({
      label: `${prefix} cash`,
      sourceCompanyId: source.companyId,
      sourceLedgerAccountId: source.cashAccountId,
      destCompanyId: dest.companyId,
      destLedgerAccountId: dest.cashAccountId,
      active: true,
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
  it("posts one journal per concurrent sale and never mirrors a sale twice", async () => {
    const date = "2026-04-01";
    const sales = await Promise.all(
      Array.from({ length: 20 }, (_, index) => postCashSale(a, `${SOURCE_A}-C${index}`, date, "1.10"))
    );
    const results = await Promise.all(
      sales.map((sale) => runIntercompanyPosTransfer(a.companyId, a.cashAccountId, "1.10", date, sale))
    );
    expect(results.every(Boolean)).toBe(true);
    // The same sale mirrored again (a retry) posts nothing more.
    expect(
      (
        await Promise.all(
          Array.from({ length: 3 }, () =>
            runIntercompanyPosTransfer(a.companyId, a.cashAccountId, "1.10", date, sales[0])
          )
        )
      ).every(Boolean)
    ).toBe(true);

    const src = await sourceMirror(a, date);
    expect(src.vouchers).toHaveLength(20);
    expect(src.total).toBe("22.00");
    expect(src.lines.get(a.cashAccountId)!.credit).toBeCloseTo(22, 2);

    const dst = await destMirror(a, date);
    expect(dst.vouchers).toHaveLength(20);
    expect(dst.total).toBe("22.00");
    expect(dst.lines.get(dest.cashAccountId)!.debit).toBeCloseTo(22, 2);
    expect(dst.lines.get(destIntercoId)!.credit).toBeCloseTo(22, 2);
    // No running-total journal is written any more.
    const runningTotals = await db
      .select({ id: schema.vouchers.id })
      .from(schema.vouchers)
      .where(
        and(
          inArray(schema.vouchers.companyId, [a.companyId, dest.companyId]),
          like(schema.vouchers.voucherNumber, "INTERCO-%")
        )
      );
    expect(runningTotals).toEqual([]);
  });

  it("rebuilds a date exactly from its cash sales and leaves another source's journal alone", async () => {
    const date = "2026-04-02";
    await postCashSale(a, `${SOURCE_A}-S1`, date, "30.00");
    await postCashSale(a, `${SOURCE_A}-S2`, date, "20.00");
    // A stale mirror that disagrees with the sales.
    const stale = await postCashSale(a, `${SOURCE_A}-S3`, date, "0.01");
    await runIntercompanyPosTransfer(a.companyId, a.cashAccountId, "999.00", date, stale);
    await db.update(schema.vouchers).set({ deletedAt: new Date() }).where(eq(schema.vouchers.id, stale));
    // Source B feeds the same destination on the same date.
    const otherSale = await postCashSale(b, `${SOURCE_B}-S1`, date, "7.00");
    await runIntercompanyPosTransfer(b.companyId, b.cashAccountId, "7.00", date, otherSale);

    expect(await recalculateIntercompanyForDate(a.companyId, date)).toBe(true);

    const src = await sourceMirror(a, date);
    expect(src.vouchers).toHaveLength(2);
    expect(src.total).toBe("50.00");
    const dst = await destMirror(a, date);
    expect(dst.vouchers).toHaveLength(2);
    expect(dst.total).toBe("50.00");

    const otherSource = await destMirror(b, date);
    expect(otherSource.total).toBe("7.00");
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
      const sale = await postCashSale(a, `${SOURCE_A}-X1`, date, "12.50");
      expect(await runIntercompanyPosTransfer(a.companyId, a.cashAccountId, "12.50", date, sale)).toBe(false);
      expect((await sourceMirror(a, date)).vouchers).toEqual([]);
    } finally {
      await db.delete(schema.fiscalPeriodClosures).where(eq(schema.fiscalPeriodClosures.companyId, dest.companyId));
    }
  });

  it("drops a deleted sale from the mirror", async () => {
    const date = "2026-04-03";
    await postCashSale(a, `${SOURCE_A}-D1`, date, "40.00");
    const deletedSaleId = await postCashSale(a, `${SOURCE_A}-D2`, date, "15.00");
    expect(await recalculateIntercompanyForDate(a.companyId, date)).toBe(true);
    expect((await destMirror(a, date)).total).toBe("55.00");

    const agent = request.agent(a.app);
    expect(
      (await agent.post("/api/auth/login").send({ username: `${SOURCE_A}_testuser`, password: "testpassword123" }))
        .status
    ).toBe(200);
    expect((await agent.post("/api/auth/set-company").send({ companyId: a.companyId })).status).toBe(200);
    const response = await agent.delete(`/api/vouchers/${deletedSaleId}`);
    expect(response.status).toBe(200);

    expect((await sourceMirror(a, date)).total).toBe("40.00");
    expect((await destMirror(a, date)).total).toBe("40.00");
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

  it("restores a missing mirror for every sales date in the range", async () => {
    const date = "2026-04-10";
    // The pre-fix state: the sale was never mirrored.
    await postCashSale(a, `${SOURCE_A}-R1`, date, "25.00");
    expect((await destMirror(a, date)).vouchers).toEqual([]);

    const agent = await adminAgent();
    const response = await agent
      .post("/api/intercompany-pos-config/rebuild")
      .send({ fromDate: "2026-04-09", toDate: "2026-04-11" });
    expect(response.status).toBe(200);
    expect(response.body.failedDates).toEqual([]);
    expect(response.body.datesRebuilt).toBe(response.body.datesChecked);
    expect((await destMirror(a, date)).total).toBe("25.00");
    expect((await sourceMirror(a, date)).total).toBe("25.00");
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
