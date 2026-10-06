/**
 * Golden Coast Phase 6 — special-location accounting integration.
 *
 * The Phase 5 FIFO/revenue/COGS database suites now call the canonical
 * Phase 6 route. This suite adds assertions unique to Hassan Savings and
 * proves that the third posting shares the same durable transaction.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db, pool } from "../server/db";
import * as schema from "../shared/schema";
import { closeTestServer } from "./setup";
import {
  GOLDEN_COAST_PHASE5_SALE_DATE,
  GOLDEN_COAST_PHASE5_SALE_URL,
  goldenCoastPhase5SaleUrl,
  clearLots,
  inventoryQuantity,
  lotRemaining,
  seedCutoverLot,
  setupGoldenCoastPhase5Fixture,
  teardownGoldenCoastPhase5Fixture,
  voucherEntriesFor,
  type GoldenCoastPhase5Fixture,
} from "./helpers/goldenCoastPhase5Fixture";

const TEST_PREFIX = "gcphase6special";
let fixture: GoldenCoastPhase5Fixture;
let hassanSavingsAccountId: number;
let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `gc6-special-${requestCounter}`;
}

function saleBody(overrides: Record<string, unknown> = {}) {
  return {
    locationId: fixture.ctx.locationId,
    saleDate: GOLDEN_COAST_PHASE5_SALE_DATE,
    customerName: "Golden Coast Special Customer",
    clientRequestId: nextRequestId(),
    lines: [{ stockItemId: fixture.goldenCoastStockItemId, qty: "30", unitPriceUsd: "60" }],
    ...overrides,
  };
}

function postSale(body: Record<string, unknown>) {
  return fixture.agent.post(goldenCoastPhase5SaleUrl(fixture)).send(body);
}

async function setDeduction(locationId: number, rate: string): Promise<void> {
  await pool.query(
    `UPDATE locations
     SET supplier_partner_payable_deduction_per_qty = $1
     WHERE id = $2 AND company_id = $3`,
    [rate, locationId, fixture.ctx.companyId]
  );
}

function seedLot(qty = "100", unitCost = "22") {
  return seedCutoverLot({
    prefix: TEST_PREFIX,
    companyId: fixture.ctx.companyId,
    locationId: fixture.ctx.locationId,
    stockItemId: fixture.goldenCoastStockItemId,
    qty,
    unitCost,
  });
}

beforeAll(async () => {
  fixture = await setupGoldenCoastPhase5Fixture(TEST_PREFIX);
  const [account] = await db
    .select({ id: schema.ledgerAccounts.id })
    .from(schema.ledgerAccounts)
    .where(
      and(
        eq(schema.ledgerAccounts.companyId, fixture.ctx.companyId),
        eq(schema.ledgerAccounts.subType, "gc_hassan_savings"),
        isNull(schema.ledgerAccounts.deletedAt)
      )
    )
    .limit(1);
  expect(account).toBeTruthy();
  hassanSavingsAccountId = account!.id;
}, 90000);

afterAll(async () => {
  await teardownGoldenCoastPhase5Fixture(fixture);
  closeTestServer();
}, 60000);

describe("Golden Coast Phase 6 special-location allocation", () => {
  it("posts the configured Hassan deduction while preserving 1800 revenue, 660 COGS, and 1140 gross profit", async () => {
    await clearLots(fixture.ctx.companyId);
    await setDeduction(fixture.ctx.locationId, "2.5000");
    const lotId = await seedLot();

    const res = await postSale(saleBody());
    expect(res.status).toBe(200);
    expect(res.body.revenueUsd).toBe("1800.00");
    expect(res.body.cogsUsd).toBe("660.00");
    expect(res.body.grossProfitUsd).toBe("1140.00");
    expect(res.body.specialLocationDeductionUsd).toBe("75.00");
    expect(res.body.deductionPerQtyUsd).toBe("2.5000");
    // The Hassan Savings deduction stays on Golden Coast's books; only the sale
    // cash is collected via HADI.
    expect(res.body.postings.map((posting: { role: string }) => posting.role)).toEqual([
      "revenue",
      "cogs",
      "special_deduction",
      "hadi_collection_golden_coast",
      "hadi_collection_hadi",
      // Phase 15 posts the Fresh Start capital-to-payable bridge alongside the
      // collection, so every automatically routed sale carries a third leg.
      "hadi_collection_sales_payable",
    ]);

    const deductionPosting = res.body.postings.find(
      (posting: { role: string }) => posting.role === "special_deduction"
    );
    const entries = await voucherEntriesFor(deductionPosting.voucher.id);
    expect(
      Number(entries.find((entry) => entry.ledgerAccountId === fixture.saleSideAccountId)?.debitAmount)
    ).toBeCloseTo(75, 2);
    expect(Number(entries.find((entry) => entry.ledgerAccountId === hassanSavingsAccountId)?.creditAmount)).toBeCloseTo(
      75,
      2
    );
    expect(await lotRemaining(lotId)).toBeCloseTo(70, 4);
  });

  it("leaves a normal zero-deduction location on revenue and COGS only", async () => {
    await clearLots(fixture.ctx.companyId);
    await setDeduction(fixture.ctx.locationId, "0");
    await seedLot();

    const res = await postSale(saleBody());
    expect(res.status).toBe(200);
    expect(res.body.specialLocationDeductionUsd).toBe("0.00");
    expect(res.body.postings.map((posting: { role: string }) => posting.role)).toEqual([
      "revenue",
      "cogs",
      "hadi_collection_golden_coast",
      "hadi_collection_hadi",
      // Phase 15 posts the Fresh Start capital-to-payable bridge alongside the
      // collection, so every automatically routed sale carries a third leg.
      "hadi_collection_sales_payable",
    ]);
  });

  it("replays once and rejects the same sale identity after deduction configuration changes", async () => {
    await clearLots(fixture.ctx.companyId);
    await setDeduction(fixture.ctx.locationId, "2.5000");
    const lotId = await seedLot();
    const body = saleBody();

    const first = await postSale(body);
    expect(first.status).toBe(200);
    const remainingAfterFirst = await lotRemaining(lotId);

    const replay = await fixture.agent
      .post(goldenCoastPhase5SaleUrl(fixture))
      .set("X-Idempotency-Key", `${body.clientRequestId}-handler-replay`)
      .send(body);
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.postings.map((posting: { voucher: { id: number } }) => posting.voucher.id)).toEqual(
      first.body.postings.map((posting: { voucher: { id: number } }) => posting.voucher.id)
    );
    expect(await lotRemaining(lotId)).toBeCloseTo(remainingAfterFirst, 4);

    await setDeduction(fixture.ctx.locationId, "3.0000");
    const conflict = await fixture.agent
      .post(goldenCoastPhase5SaleUrl(fixture))
      .set("X-Idempotency-Key", `${body.clientRequestId}-changed-config`)
      .send(body);
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe("GC_PHASE6_IDEMPOTENCY_CONFLICT");
    expect(await lotRemaining(lotId)).toBeCloseTo(remainingAfterFirst, 4);
  });

  it("fails readiness for wrong-type, inactive, deleted, or missing canonical Hassan Savings", async () => {
    await clearLots(fixture.ctx.companyId);
    await setDeduction(fixture.ctx.locationId, "2.5000");
    await seedLot();
    const readinessUrl = `${GOLDEN_COAST_PHASE5_SALE_URL}/readiness`;

    try {
      await db
        .update(schema.ledgerAccounts)
        .set({ accountType: "Equity" })
        .where(eq(schema.ledgerAccounts.id, hassanSavingsAccountId));
      let readiness = await fixture.agent.get(readinessUrl);
      expect(readiness.status).toBe(200);
      expect(readiness.body.canPost).toBe(false);
      expect(readiness.body.blockers.join(" ")).toMatch(/account type/i);

      await db
        .update(schema.ledgerAccounts)
        .set({ accountType: "Loans", active: false })
        .where(eq(schema.ledgerAccounts.id, hassanSavingsAccountId));
      readiness = await fixture.agent.get(readinessUrl);
      expect(readiness.body.canPost).toBe(false);
      expect(readiness.body.blockers.join(" ")).toMatch(/hassan_savings|Hassan Savings/i);

      // Recreates the legacy state (a deleted account that still carries a
      // balance); the ledger integrity guard refuses it outside a reviewed repair.
      await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.ledger_integrity_bypass', 'on', true)`);
        await tx
          .update(schema.ledgerAccounts)
          .set({ active: true, deletedAt: new Date() })
          .where(eq(schema.ledgerAccounts.id, hassanSavingsAccountId));
      });
      readiness = await fixture.agent.get(readinessUrl);
      expect(readiness.body.canPost).toBe(false);

      await db
        .update(schema.ledgerAccounts)
        .set({ deletedAt: null, subType: null })
        .where(eq(schema.ledgerAccounts.id, hassanSavingsAccountId));
      readiness = await fixture.agent.get(readinessUrl);
      expect(readiness.body.canPost).toBe(false);
      expect(readiness.body.blockers.join(" ")).toMatch(/hassan_savings|Hassan Savings/i);
    } finally {
      await db
        .update(schema.ledgerAccounts)
        .set({ accountType: "Loans", active: true, deletedAt: null, subType: "gc_hassan_savings" })
        .where(eq(schema.ledgerAccounts.id, hassanSavingsAccountId));
    }
  });

  it("rolls back FIFO, inventory, revenue, and COGS if the final Hassan voucher cannot post", async () => {
    await clearLots(fixture.ctx.companyId);
    await setDeduction(fixture.ctx.locationId, "2.5000");
    const lotId = await seedLot();
    const inventoryBefore = await inventoryQuantity(
      fixture.ctx.companyId,
      fixture.ctx.locationId,
      fixture.goldenCoastStockItemId
    );
    const body = saleBody();
    const baseNumber = `GC-POS-C${fixture.ctx.companyId}-${body.clientRequestId}`;

    await db.insert(schema.vouchers).values({
      companyId: fixture.ctx.companyId,
      voucherType: "Journal",
      voucherNumber: `${baseNumber}-DED`,
      voucherDate: GOLDEN_COAST_PHASE5_SALE_DATE,
      description: "Phase 6 final-post collision fixture",
      totalAmount: "0",
      currency: "USD",
    });

    const res = await postSale(body);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await lotRemaining(lotId)).toBeCloseTo(100, 4);
    expect(
      await inventoryQuantity(fixture.ctx.companyId, fixture.ctx.locationId, fixture.goldenCoastStockItemId)
    ).toBeCloseTo(inventoryBefore, 4);

    const { rows } = await pool.query(
      `SELECT voucher_number
       FROM vouchers
       WHERE company_id = $1 AND voucher_number IN ($2, $3)`,
      [fixture.ctx.companyId, baseNumber, `${baseNumber}-COGS`]
    );
    expect(rows).toHaveLength(0);
  });
});
