import { describe, expect, it } from "vitest";

import { buildGoldenCoastPhase1PostingBatch } from "./goldenCoastPostingBatch";

const ledger = (id: number) => ({ kind: "ledger" as const, id });
const bank = (id: number) => ({ kind: "bank" as const, id });

function buildLocationSale(clientRequestId: string, salePricePerUnitUsd = 60) {
  return buildGoldenCoastPhase1PostingBatch({
    companyId: 7,
    clientRequestId,
    voucherNumber: "GC-SALE-C-001",
    voucherDate: "2026-08-26",
    exchangeRate: null,
    event: {
      type: "location_sale",
      quantity: 30,
      salePricePerUnitUsd,
      inventoryCostPerUnitUsd: 22,
      locationId: 3,
      cashOrReceivableAccount: bank(1),
      salesRevenueAccount: ledger(401),
      cogsAccount: ledger(501),
      inventoryAccount: ledger(202),
    },
  });
}

describe("Golden Coast Phase 1 posting batch", () => {
  it("splits the 30-bag sale into an $1,800 Sales voucher and $660 COGS journal", () => {
    const batch = buildLocationSale("gc-sale-c-001");

    expect(batch.postings).toHaveLength(2);
    expect(batch.postings[0].role).toBe("primary");
    expect(batch.postings[0].request.voucher.totalAmount).toBe("1800.00");
    expect(batch.postings[0].request.voucher.voucherType).toBe("Sales");
    expect(batch.postings[1].role).toBe("cogs");
    expect(batch.postings[1].request.voucher.totalAmount).toBe("660.00");
    expect(batch.postings[1].request.voucher.voucherType).toBe("Journal");
    expect(batch.postings[0].request.source.idempotencyKey).toBe("golden-coast-phase1:gc-sale-c-001:primary");
    expect(batch.postings[1].request.source.idempotencyKey).toBe("golden-coast-phase1:gc-sale-c-001:cogs");
  });

  it("keeps idempotency keys stable when a retry changes the financial payload", () => {
    const original = buildLocationSale("gc-sale-stable", 60);
    const changed = buildLocationSale("gc-sale-stable", 61);

    expect(changed.postings[0].request.source.idempotencyKey).toBe(original.postings[0].request.source.idempotencyKey);
    expect(changed.postings[1].request.source.idempotencyKey).toBe(original.postings[1].request.source.idempotencyKey);
  });

  it("accepts a 128-character root request ID without extending it for COGS", () => {
    const clientRequestId = "x".repeat(128);
    const batch = buildLocationSale(clientRequestId);

    expect(batch.clientRequestId).toBe(clientRequestId);
    expect(batch.postings).toHaveLength(2);
    expect(batch.postings[1].request.source.idempotencyKey).toBe(`golden-coast-phase1:${clientRequestId}:cogs`);
  });
});
