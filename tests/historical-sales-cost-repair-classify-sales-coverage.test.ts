/**
 * Pure classification of a company's sales for the historical sales-cost repair
 * dry run (classifyCompanySales): canonical evidence without a priced issue,
 * quantity drift, multi-rate issues, lifecycle corrections (priced, live-rate
 * and unproven), POS lifecycle normalisation (priced, unpriced, deleted sale),
 * rates outside the journaled range, canonical sales without a rate, missing
 * locations, missing post-cutover evidence and legacy sales before cutover.
 */
import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";

import { movement } from "./helpers/historicalSalesCostRepairMovement";
import { classifyCompanySales } from "../server/services/inventory/historicalSalesCostRepairSales";
import type { CanonicalSaleEvidence } from "../server/services/inventory/proposalFromRecordedRate";
import type { HistoricalSalesRepairMovement } from "../server/services/inventory/historicalSalesCostRepairEngine";
import type { RepairCheck, SaleRow } from "../server/services/inventory/historicalSalesCostRepairTypes";

const T0 = "2026-03-01T10:00:00.000Z";

function sale(id: number, overrides: Partial<SaleRow> = {}): SaleRow {
  return {
    sales_item_id: id,
    voucher_id: id * 10,
    location_id: 10,
    stock_item_id: 100,
    quantity: "2.000",
    total_sales: "20.00",
    cost_price: "4.00",
    total_cost: "8.00",
    profit: "12.00",
    created_at: new Date("2026-02-01T00:00:00.000Z"),
    ...overrides,
  };
}

function evidence(overrides: Partial<CanonicalSaleEvidence> = {}): CanonicalSaleEvidence {
  return {
    movements: [],
    latestMutationAt: Date.parse(T0),
    latestNegativeMovements: [],
    latestPositiveMovements: [],
    latestNegativeRates: new Set<string>(),
    latestNegativeQuantity: new Decimal(2),
    latestNegativeValue: new Decimal(10),
    latestNegativeRate: new Decimal(5),
    latestPositiveRate: null,
    totalSignedQuantity: new Decimal(-2),
    anchorCanonicalId: 7,
    ...overrides,
  };
}

const issue = (
  id: string,
  quantity: string,
  unitCost: string | null,
  extra: Partial<HistoricalSalesRepairMovement> = {}
) =>
  movement({
    movementId: id,
    quantityDelta: quantity,
    unitCost,
    occurredAt: T0,
    createdAt: T0,
    evidence: "canonical",
    ...extra,
  });

function run(
  sales: SaleRow[],
  entries: Array<[string, CanonicalSaleEvidence]>,
  options: { canonicalStart?: Date | null; canonical?: HistoricalSalesRepairMovement[] } = {}
) {
  const checks: RepairCheck[] = [];
  const legacyMovements: HistoricalSalesRepairMovement[] = [];
  const result = classifyCompanySales({
    companyId: 1,
    sales,
    canonicalStart: options.canonicalStart === undefined ? null : options.canonicalStart,
    canonical: options.canonical ?? [],
    checks,
    canonicalSaleEvidence: new Map(entries),
    canonicalSaleKeys: new Set(entries.map(([key]) => key)),
    legacyMovements,
  });
  return { ...result, checks, legacyMovements, codes: checks.map((check) => check.code) };
}

describe("canonical evidence checks", () => {
  it("blocks evidence without a priced issue and falls back to the original sale cost", () => {
    const out = run([sale(1)], [["10:10:100", evidence({ latestNegativeRate: null })]]);
    expect(out.codes).toContain("CANONICAL_SALE_RATE_MISSING");
    expect(out.directCanonicalProposals.has(1)).toBe(true);
    expect(out.legacySales).toEqual([]);
  });

  it("ignores evidence for vouchers that are no longer sold", () => {
    const out = run([], [["99:10:100", evidence({ latestNegativeRate: null })]]);
    expect(out.checks).toEqual([]);
  });

  it("warns about quantity drift and multiple recorded rates, and blocks rates outside them", () => {
    const anchor = issue("a", "-3.000", "5.00");
    const out = run(
      [sale(1)],
      [
        [
          "10:10:100",
          evidence({
            latestNegativeQuantity: new Decimal(3),
            latestNegativeRates: new Set(["4.00", "4.50"]),
            latestNegativeMovements: [anchor],
            movements: [anchor],
          }),
        ],
      ]
    );
    expect(out.codes).toEqual(
      expect.arrayContaining([
        "CANONICAL_SALE_QUANTITY_DRIFT",
        "CANONICAL_SALE_MULTI_RATE_RECONCILED",
        "CANONICAL_SALE_RATE_OUTSIDE_RECORDED",
      ])
    );
    expect(out.directCanonicalProposals.get(1)).toBeDefined();
  });
});

describe("lifecycle corrections", () => {
  it("adds a priced correction at the latest negative rate when stock was under-issued", () => {
    const anchor = issue("n", "-1.000", "5.00");
    const out = run(
      [sale(1)],
      [
        [
          "10:10:100",
          evidence({ totalSignedQuantity: new Decimal(-1), latestNegativeMovements: [anchor], movements: [anchor] }),
        ],
      ]
    );
    expect(out.codes).toContain("CANONICAL_SALE_LIFECYCLE_CORRECTION");
    const correction = out.canonicalForReplay.find((m) => m.sourceType === "canonical-sale-lifecycle-correction");
    expect(correction).toMatchObject({ quantityDelta: "-1.000", unitCost: "5.00", sequence: 79 });
  });

  it("returns over-issued stock at the latest positive rate, or the negative rate without one", () => {
    const back = issue("p", "1.000", "6.00");
    const withPositive = run(
      [sale(1)],
      [
        [
          "10:10:100",
          evidence({
            totalSignedQuantity: new Decimal(-3),
            latestPositiveRate: new Decimal(6),
            latestPositiveMovements: [back],
            movements: [back],
          }),
        ],
      ]
    );
    const fixed = withPositive.canonicalForReplay.find((m) => m.sourceType === "canonical-sale-lifecycle-correction");
    expect(fixed).toMatchObject({ quantityDelta: "1.000", unitCost: "6.00" });

    const negativeOnly = issue("n2", "-3.000", "5.00");
    const withoutPositive = run(
      [sale(1)],
      [
        [
          "10:10:100",
          evidence({
            totalSignedQuantity: new Decimal(-3),
            latestNegativeMovements: [negativeOnly],
            movements: [negativeOnly],
          }),
        ],
      ]
    );
    expect(withoutPositive.canonicalForReplay.at(-1)).toMatchObject({ quantityDelta: "1.000", unitCost: "5.00" });
  });

  it("leaves the correction unpriced when the only rate source is a POS edit leg", () => {
    const leg = issue("e", "-1.000", "5.00", { sourceType: "pos-sale", canonicalPosRole: "edit-issue" });
    const out = run(
      [sale(1)],
      [
        [
          "10:10:100",
          evidence({ totalSignedQuantity: new Decimal(-1), latestNegativeMovements: [leg], movements: [leg] }),
        ],
      ]
    );
    expect(
      out.canonicalForReplay.find((m) => m.sourceType === "canonical-sale-lifecycle-correction")?.unitCost
    ).toBeNull();
  });

  it("blocks a correction without a rate anchor", () => {
    const out = run(
      [sale(1)],
      [
        [
          "10:10:100",
          evidence({
            totalSignedQuantity: new Decimal(-1),
            anchorCanonicalId: 0,
            movements: [issue("m", "-1.000", "5.00")],
          }),
        ],
      ]
    );
    expect(out.codes).toContain("CANONICAL_SALE_LIFECYCLE_CORRECTION_UNPROVEN");
  });
});

describe("POS lifecycle normalisation", () => {
  it("collapses a priced POS lifecycle into one normalized issue and keeps non-POS rows", () => {
    const other = issue("x", "5.000", "3.00", { sourceType: "purchase" });
    const reversal = issue("r", "2.000", "4.00", { sourceType: "pos-sale", createdAt: "2026-03-01T09:00:00.000Z" });
    const first = issue("i1", "-1.000", "4.00", { sourceType: "pos-sale", sequence: 1 });
    const second = issue("i2", "-1.000", "6.00", { sourceType: "pos-sale", sequence: 2 });
    const out = run(
      [sale(1)],
      [["10:10:100", evidence({ movements: [reversal, first, second], latestNegativeMovements: [first, second] })]],
      { canonical: [other, reversal, first, second] }
    );
    expect(out.normalizedCanonicalPosReplay[0]).toBe(other);
    expect(out.normalizedCanonicalPosReplay[1]).toMatchObject({
      movementId: "i2",
      sourceType: "pos-sale-normalized",
      quantityDelta: "-2.000",
      unitCost: "5.00",
      sourceId: "10",
    });
  });

  it("keeps unpriced POS lifecycles as recorded and drops deleted sales' lifecycles", () => {
    const unpriced = issue("u", "-2.000", null, { sourceType: "pos-sale" });
    const deleted = issue("d", "-1.000", "4.00", { sourceType: "pos-sale" });
    const out = run(
      [sale(1)],
      [
        ["10:10:100", evidence({ movements: [unpriced] })],
        ["55:10:100", evidence({ movements: [deleted] })],
      ]
    );
    expect(out.normalizedCanonicalPosReplay).toEqual([unpriced]);
  });
});

describe("sales without canonical evidence", () => {
  it("blocks sales without a location and sales after cutover without evidence", () => {
    const out = run([sale(1, { location_id: null }), sale(2, { created_at: new Date("2026-04-01T00:00:00Z") })], [], {
      canonicalStart: new Date("2026-03-15T00:00:00Z"),
    });
    expect(out.codes).toEqual(expect.arrayContaining(["SALE_LOCATION_MISSING", "CANONICAL_SALE_EVIDENCE_MISSING"]));
    expect(out.legacySales).toEqual([]);
  });

  it("re-costs legacy sales before cutover through an unpriced replay marker", () => {
    const legacy = sale(3);
    const out = run([legacy], [], { canonicalStart: new Date("2026-03-15T00:00:00Z") });
    expect(out.legacySales).toEqual([legacy]);
    expect(out.legacyMovements).toEqual([
      expect.objectContaining({
        movementId: "sale-marker:3",
        quantityDelta: "-2.000",
        unitCost: null,
        sequence: 35,
        sourceType: "legacy-sale",
        sale: expect.objectContaining({ salesItemId: 3, voucherId: 30, originalCostPrice: "4.00" }),
      }),
    ]);
  });
});
