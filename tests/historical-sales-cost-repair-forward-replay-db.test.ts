/**
 * The opening forward replay of the historical sales cost repair dry run,
 * against a real database: how a pinned item opening, location-import
 * openings and unapplied legacy transfers are reconciled to the immutable
 * Phase 3 checkpoint before a sale is priced. Each case seeds one disposable
 * company in a rolled-back transaction.
 */
import type { CompanyDryRun } from "../server/services/inventory/historicalSalesCostRepairTypes";
import { withHscrFixture, type HscrFixture } from "./helpers/historicalSalesCostRepairDbFixture";

type Outcome = {
  cost: Map<number, string>;
  codes: (status: "block" | "warning" | "pass") => string[];
  check: (code: string) => CompanyDryRun["checks"][number] | undefined;
};

async function dryRun(build: (fixture: HscrFixture) => Promise<void>): Promise<Outcome> {
  return withHscrFixture(async (fixture) => {
    await build(fixture);
    const result = await fixture.dryRun();
    return {
      cost: new Map(result.proposals.map((proposal) => [proposal.salesItemId, proposal.proposedCostPrice])),
      codes: (status) => result.checks.filter((check) => check.status === status).map((check) => check.code),
      check: (code) => result.checks.find((check) => check.code === code),
    };
  });
}

async function item(fixture: HscrFixture, opening: { qty: number; rate: number | null; value?: number }) {
  const id = await fixture.item();
  await fixture.client.query("UPDATE stock_items SET opening_qty=$2, opening_rate=$3, opening_value=$4 WHERE id=$1", [
    id,
    opening.qty,
    opening.rate,
    opening.value ?? (opening.rate === null ? null : opening.qty * opening.rate),
  ]);
  return id;
}

const CHECKPOINT = "2026-02-01T00:00:00Z";

describe("historical sales cost repair: opening forward replay", () => {
  it("reconciles a location import that differs from the item opening at the pinned rate", async () => {
    let sale = 0;
    const outcome = await dryRun(async (f) => {
      const l = await f.location();
      // The item says 5 opened, but the location import placed 8.
      const i = await item(f, { qty: 5, rate: 10 });
      sale = (await f.sale("2026-01-05T10:00:00Z", l, i, 2, 99)).salesItemId;
      await f.checkpoint(CHECKPOINT, [{ locationId: l, stockItemId: i, quantity: 6, rate: 10 }]);
    });
    expect(outcome.codes("warning")).toContain("OPENING_FORWARD_QTY_MISMATCH");
    expect(outcome.check("OPENING_FORWARD_QTY_MISMATCH")).toMatchObject({ expected: "5.000", actual: "8.000" });
    expect(outcome.check("OPENING_FORWARD_LOCATION_IMPORT_RECONCILED")).toMatchObject({
      status: "pass",
      expected: "5.000@10.00",
      actual: "8.000@10.00",
    });
    expect(outcome.check("OPENING_FORWARD_REPLAY_PROVEN")).toMatchObject({ actual: "8.000|80.00" });
    expect(outcome.cost.get(sale)).toBe("10.00");
  });

  it("reconciles a signed location import when one location went negative", async () => {
    let sale = 0;
    const outcome = await dryRun(async (f) => {
      const a = await f.location("A");
      const b = await f.location("B");
      const i = await item(f, { qty: 0, rate: 10 });
      // A received 5 it never shows in the checkpoint: its import was −5.
      await f.adjustment("2026-01-03T10:00:00Z", a, i, 5, 10);
      sale = (await f.sale("2026-01-05T10:00:00Z", b, i, 2, 99)).salesItemId;
      // A ends at zero and has no checkpoint row.
      await f.checkpoint(CHECKPOINT, [{ locationId: b, stockItemId: i, quantity: 3, rate: 10 }]);
    });
    expect(outcome.codes("warning")).toContain("OPENING_FORWARD_NEGATIVE_INFERRED_QTY");
    expect(outcome.check("OPENING_FORWARD_NEGATIVE_INFERRED_QTY")).toMatchObject({
      expected: "0.000",
      actual: "0.000",
    });
    expect(outcome.codes("pass")).toContain("OPENING_FORWARD_SIGNED_LOCATION_IMPORT_RECONCILED");
    expect(outcome.cost.get(sale)).toBe("10.00");
  });

  it("does not guess an opening rate for a negative or mismatched location import", async () => {
    for (const checkpointQty of [3, 9]) {
      const outcome = await dryRun(async (f) => {
        const a = await f.location("A");
        const b = await f.location("B");
        const i = await item(f, { qty: 0, rate: null });
        await f.adjustment("2026-01-03T10:00:00Z", a, i, 5, 10);
        await f.sale("2026-01-05T10:00:00Z", b, i, 2, 99);
        await f.checkpoint(CHECKPOINT, [
          { locationId: a, stockItemId: i, quantity: checkpointQty === 3 ? 0 : 5, rate: 10 },
          { locationId: b, stockItemId: i, quantity: checkpointQty, rate: 10 },
        ]);
      });
      expect(outcome.codes("pass")).not.toContain("OPENING_FORWARD_REPLAY_PROVEN");
      expect(outcome.codes("pass")).not.toContain("OPENING_FORWARD_LOCATION_IMPORT_RECONCILED");
      expect(outcome.codes("pass")).not.toContain("OPENING_FORWARD_SIGNED_LOCATION_IMPORT_RECONCILED");
    }
  });

  it("refuses a zero opening that still carries a value", async () => {
    const outcome = await dryRun(async (f) => {
      const l = await f.location();
      const i = await item(f, { qty: 0, rate: 10, value: 50 });
      await f.adjustment("2026-01-03T10:00:00Z", l, i, 5, 10);
      await f.sale("2026-01-05T10:00:00Z", l, i, 2, 99);
      await f.checkpoint(CHECKPOINT, [{ locationId: l, stockItemId: i, quantity: 3, rate: 10 }]);
    });
    expect(outcome.check("OPENING_FORWARD_ZERO_QTY_VALUE_MISMATCH")).toMatchObject({
      status: "warning",
      expected: "0.00",
      actual: "50.00",
    });
    expect(outcome.codes("pass")).not.toContain("OPENING_FORWARD_REPLAY_PROVEN");
  });

  it("refuses an opening split across locations that cannot reproduce its value", async () => {
    const outcome = await dryRun(async (f) => {
      const a = await f.location("A");
      const b = await f.location("B");
      const i = await item(f, { qty: 10, rate: 10, value: 105 });
      await f.sale("2026-01-05T10:00:00Z", b, i, 2, 99);
      await f.checkpoint(CHECKPOINT, [
        { locationId: a, stockItemId: i, quantity: 4, rate: 10 },
        { locationId: b, stockItemId: i, quantity: 4, rate: 10 },
      ]);
    });
    expect(outcome.check("OPENING_FORWARD_VALUE_ALLOCATION_MISMATCH")).toMatchObject({
      expected: "105.00",
      actual: "100.00",
    });
  });

  it("reports a replay that misses the checkpoint", async () => {
    const outcome = await dryRun(async (f) => {
      const l = await f.location();
      const i = await item(f, { qty: 5, rate: 10 });
      await f.sale("2026-01-05T10:00:00Z", l, i, 2, 99);
      await f.checkpoint(CHECKPOINT, [{ locationId: l, stockItemId: i, quantity: 3, rate: 12 }]);
    });
    const mismatch = outcome.check("OPENING_FORWARD_CHECKPOINT_MISMATCH");
    expect(mismatch?.status).toBe("warning");
    expect(mismatch?.detail).toMatch(
      /^location \d+ expected 3\.000\|12\.00\|36\.00 actual 3\.000\|10\.00\|30\.00 peakLayerQty 0\.000$/
    );
  });

  it("reports a location without a checkpoint row that does not end empty", async () => {
    const outcome = await dryRun(async (f) => {
      const a = await f.location("A");
      const b = await f.location("B");
      const i = await item(f, { qty: 0, rate: 10 });
      // A's signed import of −5 at 10 is refilled at 12: zero units, but 10.00 of value left.
      await f.adjustment("2026-01-03T10:00:00Z", a, i, 5, 12);
      await f.sale("2026-01-05T10:00:00Z", b, i, 2, 99);
      await f.checkpoint(CHECKPOINT, [{ locationId: b, stockItemId: i, quantity: 3, rate: 10 }]);
    });
    expect(outcome.check("OPENING_FORWARD_CHECKPOINT_MISMATCH")?.detail).toMatch(
      /^location \d+ has no checkpoint row but replay ends 0\.000\|[\d.]+\|10\.00 peakLayerQty /
    );
  });

  it("proves a sale through an unapplied legacy transfer when the trusted history cannot", async () => {
    let sale = 0;
    const outcome = await dryRun(async (f) => {
      const a = await f.location("A");
      const b = await f.location("B");
      const i = await item(f, { qty: 5, rate: 10 });
      // The transfer was never applied to inventory, but the checkpoint rate at B
      // (12) only makes sense if those 5 units arrived there at 12.
      await f.transfer("2026-01-04T10:00:00Z", a, b, i, 5, 12, false);
      sale = (await f.sale("2026-01-05T10:00:00Z", b, i, 2, 99)).salesItemId;
      await f.checkpoint(CHECKPOINT, [{ locationId: b, stockItemId: i, quantity: 3, rate: 12 }]);
    });
    expect(outcome.check("LEGACY_TRANSFER_FLAG_FALLBACK_REPLAY_PROVEN")).toMatchObject({ status: "pass", actual: "2" });
    expect(outcome.codes("warning")).not.toContain("LEGACY_TRANSFER_FLAG_FALLBACK_IGNORED");
    expect(outcome.codes("warning")).not.toContain("OPENING_FORWARD_CHECKPOINT_MISMATCH");
    expect(outcome.cost.get(sale)).toBe("12.00");
  });

  it("ignores an unapplied legacy transfer that does not reproduce the checkpoint either", async () => {
    const outcome = await dryRun(async (f) => {
      const a = await f.location("A");
      const b = await f.location("B");
      const i = await item(f, { qty: 5, rate: 10 });
      await f.transfer("2026-01-04T10:00:00Z", a, b, i, 5, 11, false);
      await f.sale("2026-01-05T10:00:00Z", b, i, 2, 99);
      await f.checkpoint(CHECKPOINT, [{ locationId: b, stockItemId: i, quantity: 3, rate: 12 }]);
    });
    expect(outcome.codes("warning")).toEqual(
      expect.arrayContaining(["OPENING_FORWARD_CHECKPOINT_MISMATCH", "LEGACY_TRANSFER_FLAG_FALLBACK_IGNORED"])
    );
    expect(outcome.check("LEGACY_TRANSFER_FLAG_FALLBACK_IGNORED")?.actual).toBe("1");
    expect(outcome.codes("pass")).not.toContain("LEGACY_TRANSFER_FLAG_FALLBACK_REPLAY_PROVEN");
  });

  it("keeps the trusted history when it already reproduces the checkpoint", async () => {
    const outcome = await dryRun(async (f) => {
      const a = await f.location("A");
      const b = await f.location("B");
      const i = await item(f, { qty: 5, rate: 10 });
      await f.transfer("2026-01-04T10:00:00Z", a, b, i, 5, 10, false);
      await f.sale("2026-01-05T10:00:00Z", b, i, 2, 99);
      await f.checkpoint(CHECKPOINT, [{ locationId: b, stockItemId: i, quantity: 3, rate: 10 }]);
    });
    expect(outcome.codes("pass")).toContain("OPENING_FORWARD_REPLAY_PROVEN");
    expect(outcome.codes("pass")).not.toContain("LEGACY_TRANSFER_FLAG_FALLBACK_REPLAY_PROVEN");
    // The fallback rows were not needed, so they are reported as ignored.
    expect(outcome.codes("warning")).toContain("LEGACY_TRANSFER_FLAG_FALLBACK_IGNORED");
  });

  it("proves a fallback history that starts from a location import", async () => {
    let sale = 0;
    const outcome = await dryRun(async (f) => {
      const a = await f.location("A");
      const b = await f.location("B");
      // Item opening says 4 but A imported 5.
      const i = await item(f, { qty: 4, rate: 10 });
      await f.transfer("2026-01-04T10:00:00Z", a, b, i, 5, 12, false);
      sale = (await f.sale("2026-01-05T10:00:00Z", b, i, 2, 99)).salesItemId;
      await f.checkpoint(CHECKPOINT, [{ locationId: b, stockItemId: i, quantity: 3, rate: 12 }]);
    });
    expect(outcome.codes("pass")).toEqual(
      expect.arrayContaining([
        "LEGACY_TRANSFER_FLAG_FALLBACK_REPLAY_PROVEN",
        "OPENING_FORWARD_LOCATION_IMPORT_RECONCILED",
      ])
    );
    expect(outcome.cost.get(sale)).toBe("12.00");
  });

  it("proves a fallback history from a zero opening and from a split opening", async () => {
    let zeroSale = 0;
    const zero = await dryRun(async (f) => {
      const a = await f.location("A");
      const b = await f.location("B");
      const i = await item(f, { qty: 0, rate: 10 });
      await f.adjustment("2026-01-02T10:00:00Z", a, i, 5, 12);
      await f.transfer("2026-01-04T10:00:00Z", a, b, i, 5, 12, false);
      zeroSale = (await f.sale("2026-01-05T10:00:00Z", b, i, 2, 99)).salesItemId;
      await f.checkpoint(CHECKPOINT, [{ locationId: b, stockItemId: i, quantity: 3, rate: 12 }]);
    });
    expect(zero.codes("pass")).toContain("LEGACY_TRANSFER_FLAG_FALLBACK_REPLAY_PROVEN");
    expect(zero.cost.get(zeroSale)).toBe("12.00");

    let splitSale = 0;
    const split = await dryRun(async (f) => {
      const a = await f.location("A");
      const b = await f.location("B");
      const c = await f.location("C");
      const i = await item(f, { qty: 8, rate: 10 });
      await f.transfer("2026-01-04T10:00:00Z", a, b, i, 5, 12, false);
      splitSale = (await f.sale("2026-01-05T10:00:00Z", b, i, 2, 99)).salesItemId;
      await f.checkpoint(CHECKPOINT, [
        { locationId: b, stockItemId: i, quantity: 3, rate: 12 },
        { locationId: c, stockItemId: i, quantity: 3, rate: 10 },
      ]);
    });
    expect(split.codes("pass")).toContain("LEGACY_TRANSFER_FLAG_FALLBACK_REPLAY_PROVEN");
    expect(split.cost.get(splitSale)).toBe("12.00");
  });
});
