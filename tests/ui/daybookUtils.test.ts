/**
 * Unit tests for the Factory Daybook pure helpers.
 *
 * These were unreachable while they lived inside a 3,228-line page component:
 * exercising `expandBaleEntries` meant mounting the whole Daybook. Extracting
 * them in Phase 4 is what makes this file possible, so the tests are added in
 * the same change rather than left as a follow-up.
 */
import { describe, expect, it } from "vitest";

import {
  parseBalesMeta,
  mergeBaleEntries,
  expandBaleEntries,
  formatDaybookDescription,
  currencySymbol,
  formatTxType,
  getFactoryTxTypeBadge,
} from "@/pages/factory/daybook/daybookUtils";
import type { DaybookEntry } from "@/pages/factory/daybook/types";
import { formatFactoryBaleRemovalDescription } from "@shared/factoryBaleRemovalDescription";

function entry(overrides: Partial<DaybookEntry> = {}): DaybookEntry {
  return {
    id: 1,
    companyId: 1,
    txDate: "2026-01-01",
    txType: "PAYMENT",
    referenceId: null,
    referenceTable: null,
    description: "A payment",
    metaJson: null,
    currencyCode: "USD",
    amountCurrency: "100.00",
    fxRateToUsd: "1",
    amountUsd: "100.00",
    createdAt: "2026-01-01T00:00:00Z",
    createdBy: null,
    ...overrides,
  };
}

const bales = (...names: string[]) =>
  JSON.stringify({
    bales: names.map((productName, index) => ({
      id: index + 1,
      ref: `REF${index + 1}`,
      productName,
      weightKg: "10",
      status: "IN_STOCK",
    })),
  });

describe("parseBalesMeta", () => {
  it("returns an empty list when there is no metadata", () => {
    expect(parseBalesMeta(entry())).toEqual([]);
  });

  it("returns an empty list rather than throwing on malformed JSON", () => {
    // Daybook rows are written by several code paths; a bad payload must not
    // take the page down.
    expect(parseBalesMeta(entry({ metaJson: "{not json" }))).toEqual([]);
  });

  it("returns an empty list when the payload has no bales array", () => {
    expect(parseBalesMeta(entry({ metaJson: '{"other":1}' }))).toEqual([]);
  });

  it("reads the bales array", () => {
    const parsed = parseBalesMeta(entry({ metaJson: bales("Cotton", "Denim") }));
    expect(parsed.map((b) => b.productName)).toEqual(["Cotton", "Denim"]);
  });
});

describe("mergeBaleEntries", () => {
  it("returns the single entry unchanged", () => {
    const only = entry({ id: 7 });
    expect(mergeBaleEntries([only])).toBe(only);
  });

  it("sums amounts and concatenates bales across entries", () => {
    const merged = mergeBaleEntries([
      entry({ id: 1, amountCurrency: "10.50", amountUsd: "10.50", metaJson: bales("Cotton") }),
      entry({ id: 2, amountCurrency: "4.25", amountUsd: "4.25", metaJson: bales("Denim") }),
    ]);

    expect(merged.amountCurrency).toBe("14.75");
    expect(merged.amountUsd).toBe("14.75");
    expect(parseBalesMeta(merged)).toHaveLength(2);
    expect(merged.description).toBe("2 bales - Cotton | Denim");
  });

  it("deduplicates product names in the summary description", () => {
    const merged = mergeBaleEntries([
      entry({ id: 1, metaJson: bales("Cotton") }),
      entry({ id: 2, metaJson: bales("Cotton") }),
    ]);
    expect(merged.description).toBe("2 bales - Cotton");
  });
});

describe("expandBaleEntries", () => {
  it("leaves non-bale rows alone and keys them by id", () => {
    const rows = expandBaleEntries([entry({ id: 42 })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]._vKey).toBe("42");
    expect(rows[0]._source.id).toBe(42);
  });

  it("does not split a single-bale entry", () => {
    const rows = expandBaleEntries([entry({ id: 5, txType: "BALE_STOCK_ENTRY", metaJson: bales("Cotton") })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]._vKey).toBe("5");
  });

  it("splits a multi-bale entry into one row per bale, dividing the cost", () => {
    const rows = expandBaleEntries([
      entry({
        id: 9,
        txType: "BALE_STOCK_ENTRY",
        amountCurrency: "30.00",
        amountUsd: "30.00",
        metaJson: bales("Cotton", "Denim", "Wool"),
      }),
    ]);

    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r._vKey)).toEqual(["9_b0", "9_b1", "9_b2"]);
    expect(rows.map((r) => r.amountCurrency)).toEqual(["10.00", "10.00", "10.00"]);
    // Every virtual row must still point at the original entry, because the
    // detail panel shows all bales, not just the one on the clicked row.
    expect(rows.every((r) => r._source.id === 9)).toBe(true);
  });
});

describe("formatDaybookDescription", () => {
  it("passes non-bale descriptions through untouched", () => {
    expect(formatDaybookDescription(entry({ description: "Freight payment" }))).toBe("Freight payment");
  });

  it("uses the product name for a single bale", () => {
    expect(formatDaybookDescription(entry({ txType: "BALE_STOCK_ENTRY", metaJson: bales("Cotton") }))).toBe("Cotton");
  });

  it("summarises a multi-bale entry by count", () => {
    expect(formatDaybookDescription(entry({ txType: "BALE_STOCK_ENTRY", metaJson: bales("Cotton", "Denim") }))).toBe(
      "2 bales"
    );
  });

  it("strips the legacy prefix and reference codes when metadata is missing", () => {
    expect(
      formatDaybookDescription(
        entry({ txType: "BALE_STOCK_ENTRY", description: "Stock entry: 3 bales - Cotton, REFAB12" })
      )
    ).toBe("Cotton");
  });
});

describe("factory bale removal descriptions", () => {
  it("shows the exact bale reference and removing username", () => {
    expect(
      formatFactoryBaleRemovalDescription({
        references: ["AB123"],
        username: "Ahmad Ramadan",
        reason: "Bale damaged",
      })
    ).toBe("Removed bale #AB123 by Ahmad Ramadan. Reason: Bale damaged.");
  });

  it("lists every reference for multi-bale removals", () => {
    expect(
      formatFactoryBaleRemovalDescription({
        references: ["B1", "B2", "B3"],
        username: "admin",
        reason: "",
      })
    ).toBe("Removed bales #B1, #B2, and #B3 by admin.");
  });

  it("omits the reason label when no explanation was provided", () => {
    expect(
      formatFactoryBaleRemovalDescription({
        references: ["X5"],
        username: "admin",
        reason: "   ",
      })
    ).toBe("Removed bale #X5 by admin.");
  });

  it("hides automatic system reasons while keeping custom reason punctuation", () => {
    expect(
      formatFactoryBaleRemovalDescription({
        references: ["X5"],
        username: "admin",
        reason: "Bale deleted everywhere from Barcode Lookup",
      })
    ).toBe("Removed bale #X5 by admin.");
    expect(
      formatFactoryBaleRemovalDescription({
        references: ["X5"],
        username: "admin",
        reason: "Damaged!",
      })
    ).toBe("Removed bale #X5 by admin. Reason: Damaged!");
  });

  it("updates existing daybook rows from audit metadata without a database migration", () => {
    expect(
      formatDaybookDescription(
        entry({
          txType: "BALE_REMOVAL",
          description: "Removed 1 bale(s) from factory stock. Supervisor: admin. Reason: Factory bale stock removal",
          metaJson: JSON.stringify({
            bales: [{ id: 7, ref: "REF100", productName: "Denim" }],
            actorName: "admin",
            reason: "Factory bale stock removal",
          }),
        })
      )
    ).toBe("Removed bale #REF100 by admin.");
  });

  it("keeps old descriptions intact when bale metadata is unavailable", () => {
    expect(
      formatDaybookDescription(
        entry({ txType: "BALE_REMOVAL", description: "Legacy bale removal", metaJson: "{bad" })
      )
    ).toBe("Legacy bale removal");
  });
});

describe("currencySymbol", () => {
  it("maps known currencies to their symbol", () => {
    expect(currencySymbol("USD")).toBe("$");
    expect(currencySymbol("LBP")).toBe("LL");
  });

  it("falls back to the code with a trailing space so amounts stay readable", () => {
    expect(currencySymbol("XYZ")).toBe("XYZ ");
  });
});

describe("formatTxType and getFactoryTxTypeBadge", () => {
  it("returns a label for every transaction type it knows", () => {
    expect(formatTxType("PAYMENT")).not.toBe("");
  });

  it("always returns a usable badge variant, including for unknown types", () => {
    const known = getFactoryTxTypeBadge("PAYMENT");
    const unknown = getFactoryTxTypeBadge("SOMETHING_NEW");
    for (const badge of [known, unknown]) {
      expect(["default", "secondary", "destructive", "outline"]).toContain(badge.variant);
    }
  });
});
