/**
 * tests/golden-coast-pos-sale.test.ts
 *
 * Golden Coast Phase 5 — FIFO consumption and sale accounting.
 *
 * POST /api/sp/golden-coast/phase5/pos-sale must consume the canonical Phase 4
 * FIFO lots oldest-first, derive COGS from the units actually consumed (never a
 * user estimate), and post Dr sale-side / Cr Sales alongside Dr COGS / Cr Stock
 * in Hand, both carrying the sale location.
 *
 * Idempotency, isolation and atomicity live in the companion safety suite. The
 * split keeps each file's privileged-mutation rate-limit budget comfortable.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { closeTestServer } from "./setup";
import {
  GOLDEN_COAST_PHASE5_SALE_DATE,
  GOLDEN_COAST_PHASE5_SALE_URL,
  goldenCoastPhase5SaleUrl,
  clearLots,
  inventoryQuantity,
  lotRemaining,
  seedCutoverLot,
  seedLegacyLot,
  setupGoldenCoastPhase5Fixture,
  teardownGoldenCoastPhase5Fixture,
  voucherEntriesFor,
  type GoldenCoastPhase5Fixture,
} from "./helpers/goldenCoastFixture";

const TEST_PREFIX = "gcphase5fifo";

let fixture: GoldenCoastPhase5Fixture;
let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `gc5-fifo-${requestCounter}`;
}

function saleBody(overrides: Record<string, unknown> = {}) {
  return {
    locationId: fixture.ctx.locationId,
    saleDate: GOLDEN_COAST_PHASE5_SALE_DATE,
    customerName: "Golden Coast Customer",
    clientRequestId: nextRequestId(),
    lines: [{ stockItemId: fixture.goldenCoastStockItemId, qty: "30", unitPriceUsd: "60" }],
    ...overrides,
  };
}

function postSale(body: Record<string, unknown>) {
  return fixture.agent.post(goldenCoastPhase5SaleUrl(fixture)).send(body);
}

function seedLot(input: { qty: string; unitCost: string; locationId?: number; createdAt?: string }) {
  return seedCutoverLot({
    prefix: TEST_PREFIX,
    companyId: fixture.ctx.companyId,
    locationId: input.locationId ?? fixture.ctx.locationId,
    stockItemId: fixture.goldenCoastStockItemId,
    qty: input.qty,
    unitCost: input.unitCost,
    createdAt: input.createdAt,
  });
}

beforeAll(async () => {
  fixture = await setupGoldenCoastPhase5Fixture(TEST_PREFIX);
}, 90000);

afterAll(async () => {
  await teardownGoldenCoastPhase5Fixture(fixture);
  closeTestServer();
}, 60000);

describe("Golden Coast Phase 5 — FIFO sale accounting", () => {
  it("posts 30 bags at $60 with a $22 FIFO cost as Sales 1800 / COGS 660 / gross profit 1140", async () => {
    await clearLots(fixture.ctx.companyId);
    const lotId = await seedLot({ qty: "100", unitCost: "22" });
    const inventoryBefore = await inventoryQuantity(
      fixture.ctx.companyId,
      fixture.ctx.locationId,
      fixture.goldenCoastStockItemId
    );

    const res = await postSale(saleBody());
    expect(res.status).toBe(200);
    expect(res.body.replayed).toBe(false);
    expect(res.body.revenueUsd).toBe("1800.00");
    expect(res.body.cogsUsd).toBe("660.00");
    expect(res.body.grossProfitUsd).toBe("1140.00");

    const [revenue, cogs] = res.body.postings;
    expect(revenue.role).toBe("revenue");
    expect(cogs.role).toBe("cogs");

    const revenueEntries = await voucherEntriesFor(revenue.voucher.id);
    expect(revenueEntries).toHaveLength(2);
    const saleSideEntry = revenueEntries.find((entry) => entry.ledgerAccountId === fixture.saleSideAccountId);
    const salesEntry = revenueEntries.find((entry) => entry.ledgerAccountId === fixture.salesAccountId);
    expect(Number(saleSideEntry?.debitAmount)).toBeCloseTo(1800, 2);
    expect(Number(saleSideEntry?.creditAmount)).toBeCloseTo(0, 2);
    expect(Number(salesEntry?.creditAmount)).toBeCloseTo(1800, 2);
    expect(Number(salesEntry?.debitAmount)).toBeCloseTo(0, 2);

    const cogsEntries = await voucherEntriesFor(cogs.voucher.id);
    expect(cogsEntries).toHaveLength(2);
    expect(
      Number(cogsEntries.find((entry) => entry.ledgerAccountId === fixture.cogsAccountId)?.debitAmount)
    ).toBeCloseTo(660, 2);
    expect(
      Number(cogsEntries.find((entry) => entry.ledgerAccountId === fixture.stockInHandAccountId)?.creditAmount)
    ).toBeCloseTo(660, 2);

    // Location attribution on both vouchers.
    expect(revenue.voucher.locationId).toBe(fixture.ctx.locationId);
    expect(cogs.voucher.locationId).toBe(fixture.ctx.locationId);

    // Stock in Hand reduction: FIFO lot and ERP inventory both fall by 30.
    expect(await lotRemaining(lotId)).toBeCloseTo(70, 4);
    expect(
      await inventoryQuantity(fixture.ctx.companyId, fixture.ctx.locationId, fixture.goldenCoastStockItemId)
    ).toBeCloseTo(inventoryBefore - 30, 4);
  });

  it("consumes multiple FIFO lots oldest-first and blends their real costs", async () => {
    await clearLots(fixture.ctx.companyId);
    const olderLotId = await seedLot({ qty: "20", unitCost: "22", createdAt: "2026-09-01 00:00:00" });
    const newerLotId = await seedLot({ qty: "20", unitCost: "30", createdAt: "2026-09-03 00:00:00" });

    const res = await postSale(saleBody());
    expect(res.status).toBe(200);
    // 20 @ 22 = 440 then 10 @ 30 = 300 → 740.
    expect(res.body.cogsUsd).toBe("740.00");
    expect(res.body.grossProfitUsd).toBe("1060.00");
    expect(res.body.allocations.map((allocation: { lotId: number }) => allocation.lotId)).toEqual([
      olderLotId,
      newerLotId,
    ]);
    expect(await lotRemaining(olderLotId)).toBeCloseTo(0, 4);
    expect(await lotRemaining(newerLotId)).toBeCloseTo(10, 4);
  });

  it("supports exact FIFO depletion", async () => {
    await clearLots(fixture.ctx.companyId);
    const lotId = await seedLot({ qty: "30", unitCost: "22" });

    const res = await postSale(saleBody());
    expect(res.status).toBe(200);
    expect(res.body.cogsUsd).toBe("660.00");
    expect(await lotRemaining(lotId)).toBeCloseTo(0, 4);
  });

  it("fails closed on insufficient FIFO stock without posting or consuming anything", async () => {
    await clearLots(fixture.ctx.companyId);
    const lotId = await seedLot({ qty: "29", unitCost: "22" });
    const inventoryBefore = await inventoryQuantity(
      fixture.ctx.companyId,
      fixture.ctx.locationId,
      fixture.goldenCoastStockItemId
    );

    const res = await postSale(saleBody());
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("GC_PHASE5_FIFO_INSUFFICIENT");
    expect(await lotRemaining(lotId)).toBeCloseTo(29, 4);
    expect(
      await inventoryQuantity(fixture.ctx.companyId, fixture.ctx.locationId, fixture.goldenCoastStockItemId)
    ).toBeCloseTo(inventoryBefore, 4);
  });

  it("fails closed on invalid FIFO cost data", async () => {
    await clearLots(fixture.ctx.companyId);
    const lotId = await seedLot({ qty: "100", unitCost: "0" });

    const res = await postSale(saleBody());
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("GC_PHASE5_FIFO_COST_INVALID");
    expect(await lotRemaining(lotId)).toBeCloseTo(100, 4);
  });

  it("creates a current-inventory cost lot when no cutover bridge exists", async () => {
    await clearLots(fixture.ctx.companyId);
    const res = await postSale(saleBody());
    expect(res.status).toBe(200);
    expect(res.body.cogsUsd).toBe("300.00");
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

  it("never consumes legacy pre-cutover movement rows", async () => {
    await clearLots(fixture.ctx.companyId);
    // The legacy row is older, so it would sort first and cost the sale at an
    // unreconciled pre-cutover rate if Phase 5 read it.
    const legacyLotId = await seedLegacyLot({
      prefix: TEST_PREFIX,
      companyId: fixture.ctx.companyId,
      locationId: fixture.ctx.locationId,
      stockItemId: fixture.goldenCoastStockItemId,
      qty: "100",
      unitCost: "5",
    });
    const cutoverLotId = await seedLot({ qty: "100", unitCost: "22" });

    const res = await postSale(saleBody());
    expect(res.status).toBe(200);
    // $22 from the Phase 4 bridge, not $5 from the legacy row.
    expect(res.body.cogsUsd).toBe("660.00");
    expect(res.body.allocations.map((allocation: { lotId: number }) => allocation.lotId)).toEqual([cutoverLotId]);
    expect(await lotRemaining(legacyLotId)).toBeCloseTo(100, 4);
    expect(await lotRemaining(cutoverLotId)).toBeCloseTo(70, 4);
  });

  it("does not count legacy rows toward the available FIFO quantity", async () => {
    await clearLots(fixture.ctx.companyId);
    const legacyLotId = await seedLegacyLot({
      prefix: TEST_PREFIX,
      companyId: fixture.ctx.companyId,
      locationId: fixture.ctx.locationId,
      stockItemId: fixture.goldenCoastStockItemId,
      qty: "100",
      unitCost: "5",
    });
    await seedLot({ qty: "10", unitCost: "22" });

    // 10 post-cutover units against a 30-unit sale: the 100 legacy units must
    // not make this look like sufficient stock.
    const res = await postSale(saleBody());
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("GC_PHASE5_FIFO_INSUFFICIENT");
    expect(res.body.message).toMatch(/available 10\.0000/);
    expect(await lotRemaining(legacyLotId)).toBeCloseTo(100, 4);
  });

  it("accepts a sale dated before the removed Golden Coast cutover", async () => {
    await clearLots(fixture.ctx.companyId);

    const res = await postSale(saleBody({ saleDate: "2026-08-31" }));
    expect(res.status).toBe(200);
    expect(res.body.cogsUsd).toBe("300.00");
  });

  it("attributes stock to the selling location and will not sell from an empty one", async () => {
    await clearLots(fixture.ctx.companyId);
    await seedLot({ qty: "100", unitCost: "22" });

    const otherLocation = await postSale(saleBody({ locationId: fixture.ctx.location2Id }));
    expect(otherLocation.status).toBe(409);
    expect(otherLocation.body.code).toBe("GC_PHASE5_FIFO_INSUFFICIENT");
  });

  it("uses current inventory cost for stocked items without a cutover lot", async () => {
    await clearLots(fixture.ctx.companyId);
    await seedLot({ qty: "100", unitCost: "22" });

    const res = await postSale(
      saleBody({
        lines: [
          { stockItemId: fixture.goldenCoastStockItemId, qty: "1", unitPriceUsd: "60" },
          { stockItemId: fixture.secondStockItemId, qty: "1", unitPriceUsd: "60" },
        ],
      })
    );
    expect(res.status).toBe(200);
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

  it("exposes readiness for the Golden Coast company", async () => {
    await clearLots(fixture.ctx.companyId);
    await seedLot({ qty: "100", unitCost: "22" });

    const res = await fixture.agent.get(`${GOLDEN_COAST_PHASE5_SALE_URL}/readiness`);
    expect(res.status).toBe(200);
    expect(res.body.canPost).toBe(true);
    expect(res.body.costLotCount).toBeGreaterThan(0);
    expect(res.body.accounts).toMatchObject({
      saleSideAccountId: fixture.saleSideAccountId,
      salesRevenueAccountId: fixture.salesAccountId,
      cogsAccountId: fixture.cogsAccountId,
      stockInHandAccountId: fixture.stockInHandAccountId,
    });
  });
});
