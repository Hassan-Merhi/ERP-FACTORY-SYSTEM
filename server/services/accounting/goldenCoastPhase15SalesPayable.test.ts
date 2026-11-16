import { describe, expect, it } from "vitest";
import {
  GOLDEN_COAST_PHASE15_POSTING_ROLE,
  GOLDEN_COAST_PHASE15_SOURCE_TYPE,
  buildGoldenCoastPhase15SalesPayablePosting,
  goldenCoastPhase15IdempotencyKey,
  goldenCoastPhase15SalesPayableDigest,
  type GoldenCoastPhase15SalesPayableInput,
} from "./goldenCoastSalesPayable";

function sale(overrides: Partial<GoldenCoastPhase15SalesPayableInput> = {}): GoldenCoastPhase15SalesPayableInput {
  return {
    companyId: 7,
    saleDate: "2026-09-05",
    amountUsd: "1000.00",
    clientRequestId: "phase15-sale-1",
    saleDigest: "abc123",
    freshStartEquityAccountId: 101,
    gcSalesCashAccountId: 104,
    ...overrides,
  };
}

function netDebit(
  entries: Array<{ ledgerAccountId?: number | null; debitAmount: string; creditAmount: string }>,
  id: number
) {
  return entries
    .filter((entry) => entry.ledgerAccountId === id)
    .reduce((sum, entry) => sum + Number(entry.debitAmount) - Number(entry.creditAmount), 0);
}

describe("Golden Coast Phase 15 sales payable", () => {
  it("reclassifies the gross Fresh Start claim into a credit GC Sales Cash payable", () => {
    const input = sale();
    const digest = goldenCoastPhase15SalesPayableDigest(input);
    const posting = buildGoldenCoastPhase15SalesPayablePosting({ sale: input, digest, exchangeRate: "1" });

    expect(netDebit(posting.entries, input.freshStartEquityAccountId)).toBe(1000);
    expect(netDebit(posting.entries, input.gcSalesCashAccountId)).toBe(-1000);
    expect(posting.entries.reduce((sum, entry) => sum + Number(entry.debitAmount), 0)).toBe(1000);
    expect(posting.entries.reduce((sum, entry) => sum + Number(entry.creditAmount), 0)).toBe(1000);
    expect(posting.source).toMatchObject({
      sourceType: GOLDEN_COAST_PHASE15_SOURCE_TYPE,
      idempotencyKey: goldenCoastPhase15IdempotencyKey(input.companyId, input.clientRequestId),
    });
    expect(posting.source?.sourceId).toContain(GOLDEN_COAST_PHASE15_POSTING_ROLE);
  });

  it("binds replay identity to the sale amount, sale digest and account routing", () => {
    const base = sale();
    const first = goldenCoastPhase15SalesPayableDigest(base);
    expect(goldenCoastPhase15SalesPayableDigest(sale({ amountUsd: "999.00" }))).not.toBe(first);
    expect(goldenCoastPhase15SalesPayableDigest(sale({ saleDigest: "changed" }))).not.toBe(first);
    expect(goldenCoastPhase15SalesPayableDigest(sale({ freshStartEquityAccountId: 102 }))).not.toBe(first);
    expect(goldenCoastPhase15SalesPayableDigest(sale({ gcSalesCashAccountId: 105 }))).not.toBe(first);
  });

  it("rejects invalid amounts and account self-posting", () => {
    expect(() => goldenCoastPhase15SalesPayableDigest(sale({ amountUsd: "0" }))).toThrow(/greater than zero/);
    expect(() => goldenCoastPhase15SalesPayableDigest(sale({ amountUsd: "1.001" }))).toThrow(/2 decimal places/);
    expect(() =>
      goldenCoastPhase15SalesPayableDigest(sale({ freshStartEquityAccountId: 104, gcSalesCashAccountId: 104 }))
    ).toThrow(/different accounts/);
  });
});
