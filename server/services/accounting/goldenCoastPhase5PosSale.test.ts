import { describe, expect, it } from "vitest";
import {
  GOLDEN_COAST_PHASE5_SOURCE_TYPE,
  GOLDEN_COAST_POST_CUTOVER_FIFO_SOURCES,
  GoldenCoastPhase5SaleError,
  buildGoldenCoastPhase5SalePostings,
  goldenCoastPhase5IdempotencyKey,
  goldenCoastPhase5SaleDigest,
  goldenCoastPhase5SourceId,
  parseGoldenCoastPhase5SaleInput,
  planGoldenCoastPhase5Sale,
  type GoldenCoastFifoLot,
  type GoldenCoastPhase5RoleAccounts,
} from "./goldenCoastPosSale";

const COMPANY_ID = 7;
const LOCATION_ID = 3;
const STOCK_ITEM_ID = 101;

const ACCOUNTS: GoldenCoastPhase5RoleAccounts = {
  saleSideAccountId: 501,
  salesRevenueAccountId: 502,
  cogsAccountId: 503,
  stockInHandAccountId: 504,
};

function lot(overrides: Partial<GoldenCoastFifoLot> & { id: number }): GoldenCoastFifoLot {
  return {
    companyId: COMPANY_ID,
    locationId: LOCATION_ID,
    stockItemId: STOCK_ITEM_ID,
    articleCode: "GC-BAG",
    description: "Golden Coast bag",
    sourceType: "golden_coast_cutover",
    qtyRemaining: "0",
    finalUnitCostUsd: "22",
    createdAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function saleBody(overrides: Record<string, unknown> = {}) {
  return {
    locationId: LOCATION_ID,
    saleDate: "2026-09-05",
    customerName: "Golden Coast Customer",
    clientRequestId: "gc-phase5-req-1",
    lines: [{ stockItemId: STOCK_ITEM_ID, qty: "30", unitPriceUsd: "60" }],
    ...overrides,
  };
}

function parsed(overrides: Record<string, unknown> = {}) {
  return parseGoldenCoastPhase5SaleInput({ companyId: COMPANY_ID, body: saleBody(overrides) });
}

describe("Golden Coast Phase 5 sale request parsing", () => {
  it("normalizes a well-formed sale request", () => {
    const sale = parsed();
    expect(sale.companyId).toBe(COMPANY_ID);
    expect(sale.locationId).toBe(LOCATION_ID);
    expect(sale.lines).toEqual([{ stockItemId: STOCK_ITEM_ID, qty: "30", unitPriceUsd: "60", description: null }]);
  });

  it("rejects a missing location, an empty line list and a bad sale date", () => {
    expect(() => parsed({ locationId: 0 })).toThrow(/locationId/);
    expect(() => parsed({ lines: [] })).toThrow(/at least one sale line/);
    expect(() => parsed({ saleDate: "05-09-2026" })).toThrow(/ISO calendar date/);
  });

  it("rejects non-positive quantities, negative prices and repeated stock items", () => {
    expect(() => parsed({ lines: [{ stockItemId: STOCK_ITEM_ID, qty: "0", unitPriceUsd: "60" }] })).toThrow(
      /greater than zero/
    );
    expect(() => parsed({ lines: [{ stockItemId: STOCK_ITEM_ID, qty: "1", unitPriceUsd: "-1" }] })).toThrow(
      /cannot be negative/
    );
    expect(() =>
      parsed({
        lines: [
          { stockItemId: STOCK_ITEM_ID, qty: "1", unitPriceUsd: "60" },
          { stockItemId: STOCK_ITEM_ID, qty: "2", unitPriceUsd: "60" },
        ],
      })
    ).toThrow(/repeats stock item/);
  });

  it("accepts sale dates without a Golden Coast cutover prerequisite", () => {
    expect(parsed({ saleDate: "2026-01-15" }).saleDate).toBe("2026-01-15");
    expect(parsed({ saleDate: "2026-08-31" }).saleDate).toBe("2026-08-31");
  });

  it("rejects an unusable client request id", () => {
    expect(() => parsed({ clientRequestId: "  " })).toThrow(/clientRequestId is required/);
    expect(() => parsed({ clientRequestId: "bad id!" })).toThrow(/unsupported characters/);
    expect(() => parsed({ clientRequestId: "x".repeat(65) })).toThrow(/at most 64 characters/);
  });
});

describe("Golden Coast Phase 5 FIFO consumption", () => {
  it("derives COGS from the consumed lots: 30 bags at $60 with a $22 FIFO cost", () => {
    const plan = planGoldenCoastPhase5Sale({
      sale: parsed(),
      lots: [lot({ id: 1, qtyRemaining: "100", finalUnitCostUsd: "22" })],
    });

    expect(plan.revenueUsd).toBe("1800.00");
    expect(plan.cogsUsd).toBe("660.00");
    expect(plan.grossProfitUsd).toBe("1140.00");
    expect(plan.allocations).toHaveLength(1);
    expect(plan.allocations[0]).toMatchObject({
      lotId: 1,
      qty: "30.0000",
      unitCostUsd: "22.000000",
      costUsd: "660.00",
      qtyRemainingBefore: "100.0000",
      qtyRemainingAfter: "70.0000",
    });
  });

  it("consumes multiple lots oldest first and blends their real costs", () => {
    const plan = planGoldenCoastPhase5Sale({
      sale: parsed(),
      lots: [
        lot({ id: 9, qtyRemaining: "10", finalUnitCostUsd: "30", createdAt: "2026-09-03T00:00:00.000Z" }),
        lot({ id: 2, qtyRemaining: "20", finalUnitCostUsd: "22", createdAt: "2026-09-01T00:00:00.000Z" }),
      ],
    });

    // 20 @ 22 = 440, then 10 @ 30 = 300 → 740.
    expect(plan.allocations.map((allocation) => allocation.lotId)).toEqual([2, 9]);
    expect(plan.allocations[0].qty).toBe("20.0000");
    expect(plan.allocations[1].qty).toBe("10.0000");
    expect(plan.cogsUsd).toBe("740.00");
    expect(plan.grossProfitUsd).toBe("1060.00");
  });

  it("breaks a created-at tie by lot id so replays consume the same lots", () => {
    const plan = planGoldenCoastPhase5Sale({
      sale: parsed({ lines: [{ stockItemId: STOCK_ITEM_ID, qty: "5", unitPriceUsd: "60" }] }),
      lots: [
        lot({ id: 40, qtyRemaining: "10", finalUnitCostUsd: "30" }),
        lot({ id: 12, qtyRemaining: "10", finalUnitCostUsd: "22" }),
      ],
    });
    expect(plan.allocations.map((allocation) => allocation.lotId)).toEqual([12]);
    expect(plan.cogsUsd).toBe("110.00");
  });

  it("supports exact FIFO depletion down to a zero remainder", () => {
    const plan = planGoldenCoastPhase5Sale({
      sale: parsed(),
      lots: [
        lot({ id: 1, qtyRemaining: "18", finalUnitCostUsd: "22", createdAt: "2026-09-01T00:00:00.000Z" }),
        lot({ id: 2, qtyRemaining: "12", finalUnitCostUsd: "22", createdAt: "2026-09-02T00:00:00.000Z" }),
      ],
    });
    expect(plan.allocations.map((allocation) => allocation.qtyRemainingAfter)).toEqual(["0.0000", "0.0000"]);
    expect(plan.cogsUsd).toBe("660.00");
  });

  it("fails closed when the FIFO quantity is short, with no tolerance", () => {
    expect(() =>
      planGoldenCoastPhase5Sale({
        sale: parsed(),
        lots: [lot({ id: 1, qtyRemaining: "29.9999", finalUnitCostUsd: "22" })],
      })
    ).toThrow(/Insufficient Golden Coast FIFO stock/);

    try {
      planGoldenCoastPhase5Sale({ sale: parsed(), lots: [] });
      expect.unreachable("a sale with no FIFO lots must not plan");
    } catch (error) {
      expect(error).toBeInstanceOf(GoldenCoastPhase5SaleError);
      expect((error as GoldenCoastPhase5SaleError).code).toBe("GC_PHASE5_FIFO_INSUFFICIENT");
    }
  });

  it("fails closed on invalid FIFO cost data", () => {
    for (const finalUnitCostUsd of ["0", "-22", "not-a-number"]) {
      try {
        planGoldenCoastPhase5Sale({
          sale: parsed(),
          lots: [lot({ id: 1, qtyRemaining: "100", finalUnitCostUsd })],
        });
        expect.unreachable(`unit cost ${finalUnitCostUsd} must not plan`);
      } catch (error) {
        expect((error as GoldenCoastPhase5SaleError).code).toBe("GC_PHASE5_FIFO_COST_INVALID");
      }
    }
  });

  it("fails closed on a negative remaining quantity", () => {
    expect(() =>
      planGoldenCoastPhase5Sale({
        sale: parsed(),
        lots: [lot({ id: 1, qtyRemaining: "-1", finalUnitCostUsd: "22" })],
      })
    ).toThrow(/negative remaining quantity/);
  });

  it("fails closed when a lot belongs to another company or another location", () => {
    for (const override of [{ companyId: COMPANY_ID + 1 }, { locationId: LOCATION_ID + 1 }, { locationId: null }]) {
      try {
        planGoldenCoastPhase5Sale({
          sale: parsed(),
          lots: [lot({ id: 1, qtyRemaining: "100", ...override })],
        });
        expect.unreachable(`lot override ${JSON.stringify(override)} must not plan`);
      } catch (error) {
        expect((error as GoldenCoastPhase5SaleError).code).toBe("GC_PHASE5_SCOPE_MISMATCH");
      }
    }
  });

  it("fails closed when a lot has no stock item link", () => {
    expect(() =>
      planGoldenCoastPhase5Sale({
        sale: parsed(),
        lots: [lot({ id: 1, qtyRemaining: "100", stockItemId: null })],
      })
    ).toThrow(/not linked to a stock item/);
  });

  it("refuses to consume a legacy pre-cutover movement row", () => {
    // Phase 4 leaves legacy rows in place and they sort first by created_at, so
    // this guard is what keeps a sale off unreconciled pre-cutover cost.
    expect(GOLDEN_COAST_POST_CUTOVER_FIFO_SOURCES).toEqual([
      "golden_coast_cutover",
      "golden_coast_phase8_offload",
      "golden-coast-current-inventory",
    ]);
    for (const sourceType of ["offload", "opening_stock", null]) {
      try {
        planGoldenCoastPhase5Sale({
          sale: parsed(),
          lots: [lot({ id: 1, qtyRemaining: "100", sourceType })],
        });
        expect.unreachable(`source ${String(sourceType)} must not back a Golden Coast sale`);
      } catch (error) {
        expect((error as GoldenCoastPhase5SaleError).code).toBe("GC_PHASE5_SCOPE_MISMATCH");
      }
    }
  });

  it("never consumes a lot for a different stock item", () => {
    expect(() =>
      planGoldenCoastPhase5Sale({
        sale: parsed(),
        lots: [lot({ id: 1, qtyRemaining: "100", stockItemId: STOCK_ITEM_ID + 1 })],
      })
    ).toThrow(/Insufficient Golden Coast FIFO stock/);
  });
});

describe("Golden Coast Phase 5 sale postings", () => {
  const plan = planGoldenCoastPhase5Sale({
    sale: parsed(),
    lots: [lot({ id: 1, qtyRemaining: "100", finalUnitCostUsd: "22" })],
  });

  const saleSideAccount = { kind: "ledger", id: ACCOUNTS.saleSideAccountId } as const;
  const saleDigest = goldenCoastPhase5SaleDigest({ sale: parsed(), saleSideAccount });

  const batch = buildGoldenCoastPhase5SalePostings({
    plan,
    accounts: ACCOUNTS,
    saleSideAccount,
    saleDigest,
    exchangeRate: null,
  });

  it("posts Dr sale-side / Cr Sales and Dr COGS / Cr Stock in Hand as two vouchers", () => {
    expect(batch.postings.map((posting) => posting.role)).toEqual(["revenue", "cogs"]);

    const [revenue, cogs] = batch.postings;
    expect(revenue.request.voucher.voucherType).toBe("Sales");
    expect(revenue.request.voucher.totalAmount).toBe("1800.00");
    expect(revenue.request.entries).toEqual([
      expect.objectContaining({
        ledgerAccountId: ACCOUNTS.saleSideAccountId,
        debitAmount: "1800",
        creditAmount: "0",
      }),
      expect.objectContaining({
        ledgerAccountId: ACCOUNTS.salesRevenueAccountId,
        debitAmount: "0",
        creditAmount: "1800",
      }),
    ]);

    expect(cogs.request.voucher.voucherType).toBe("Journal");
    expect(cogs.request.voucher.totalAmount).toBe("660.00");
    expect(cogs.request.entries).toEqual([
      expect.objectContaining({ ledgerAccountId: ACCOUNTS.cogsAccountId, debitAmount: "660", creditAmount: "0" }),
      expect.objectContaining({
        ledgerAccountId: ACCOUNTS.stockInHandAccountId,
        debitAmount: "0",
        creditAmount: "660",
      }),
    ]);
  });

  it("carries the sale location on both vouchers", () => {
    for (const posting of batch.postings) {
      expect(posting.request.voucher.locationId).toBe(LOCATION_ID);
    }
  });

  it("tags deterministic, company-scoped idempotency keys per posting role", () => {
    expect(batch.postings.map((posting) => posting.request.source)).toEqual([
      {
        sourceType: GOLDEN_COAST_PHASE5_SOURCE_TYPE,
        sourceId: goldenCoastPhase5SourceId("gc-phase5-req-1", saleDigest, "revenue"),
        idempotencyKey: goldenCoastPhase5IdempotencyKey(COMPANY_ID, "gc-phase5-req-1", "revenue"),
      },
      {
        sourceType: GOLDEN_COAST_PHASE5_SOURCE_TYPE,
        sourceId: goldenCoastPhase5SourceId("gc-phase5-req-1", saleDigest, "cogs"),
        idempotencyKey: goldenCoastPhase5IdempotencyKey(COMPANY_ID, "gc-phase5-req-1", "cogs"),
      },
    ]);
    expect(batch.revenueVoucherNumber).toBe(`GC-POS-C${COMPANY_ID}-gc-phase5-req-1`);
    expect(batch.cogsVoucherNumber).toBe(`GC-POS-C${COMPANY_ID}-gc-phase5-req-1-COGS`);
    expect(batch.cogsVoucherNumber.length).toBeLessThanOrEqual(100);
  });

  it("supports a bank sale-side account without touching the accounting shape", () => {
    const bankBatch = buildGoldenCoastPhase5SalePostings({
      plan,
      accounts: ACCOUNTS,
      saleSideAccount: { kind: "bank", id: 88 },
      saleDigest: goldenCoastPhase5SaleDigest({ sale: parsed(), saleSideAccount: { kind: "bank", id: 88 } }),
      exchangeRate: null,
    });
    expect(bankBatch.postings[0].request.entries[0]).toEqual(
      expect.objectContaining({ bankAccountId: 88, debitAmount: "1800" })
    );
    expect(bankBatch.postings[0].request.entries[0].ledgerAccountId).toBeUndefined();
  });

  it("digests everything that makes two submissions the same sale", () => {
    const base = { sale: parsed(), saleSideAccount } as const;
    expect(goldenCoastPhase5SaleDigest(base)).toBe(saleDigest);

    // Any change to the accounting meaning of the request changes the digest,
    // so a reused clientRequestId cannot silently replay a different sale.
    const variants = [
      { locationId: LOCATION_ID + 1 },
      { saleDate: "2026-09-06" },
      { customerName: "Another Customer" },
      { notes: "changed" },
      { lines: [{ stockItemId: STOCK_ITEM_ID, qty: "31", unitPriceUsd: "60" }] },
      { lines: [{ stockItemId: STOCK_ITEM_ID, qty: "30", unitPriceUsd: "61" }] },
      { lines: [{ stockItemId: STOCK_ITEM_ID + 1, qty: "30", unitPriceUsd: "60" }] },
    ];
    for (const variant of variants) {
      expect(goldenCoastPhase5SaleDigest({ sale: parsed(variant), saleSideAccount })).not.toBe(saleDigest);
    }

    // Including a different line mix that happens to total the same revenue.
    expect(
      goldenCoastPhase5SaleDigest({
        sale: parsed({ lines: [{ stockItemId: STOCK_ITEM_ID, qty: "60", unitPriceUsd: "30" }] }),
        saleSideAccount,
      })
    ).not.toBe(saleDigest);

    // And a different settlement account.
    expect(goldenCoastPhase5SaleDigest({ sale: parsed(), saleSideAccount: { kind: "bank", id: 88 } })).not.toBe(
      saleDigest
    );
  });

  it("requires a sale digest to tag a posting", () => {
    expect(() =>
      buildGoldenCoastPhase5SalePostings({
        plan,
        accounts: ACCOUNTS,
        saleSideAccount,
        saleDigest: "  ",
        exchangeRate: null,
      })
    ).toThrow(/saleDigest is required/);
  });

  it("never posts the retired Phase 1 single-voucher or payable-only sale shape", () => {
    const allEntries = batch.postings.flatMap((posting) => posting.request.entries);
    // Four entries across two vouchers: no combined Sales+COGS voucher, and no
    // voucher that credits a payable instead of Sales revenue.
    expect(allEntries).toHaveLength(4);
    expect(batch.postings[0].request.entries).toHaveLength(2);
    expect(batch.postings[0].request.entries.some((entry) => entry.ledgerAccountId === ACCOUNTS.cogsAccountId)).toBe(
      false
    );
    expect(
      batch.postings[0].request.entries.some((entry) => entry.ledgerAccountId === ACCOUNTS.salesRevenueAccountId)
    ).toBe(true);
  });
});
