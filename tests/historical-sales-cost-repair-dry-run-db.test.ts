/**
 * The historical sales cost repair dry run against a real database.
 *
 * Each case seeds one disposable company inside a rolled-back transaction —
 * legacy sales with a wrong recorded cost, the stock movements around them and
 * the Phase 3 valuation checkpoint — runs dryRunCompany, and checks the cost it
 * proposes for each sale and the checks that block or allow it. The engine's
 * pure replay functions have their own unit tests; these cover the loaders and
 * the orchestration that chooses between the checkpoint rewind, the opening
 * forward replay and closed zero-stock eras.
 */
import type { CompanyDryRun } from "../server/services/inventory/historicalSalesCostRepairTypes";
import { withHscrFixture, type HscrFixture } from "./helpers/historicalSalesCostRepairDbFixture";

type Outcome = {
  cost: Map<number, string>;
  changed: Map<number, boolean>;
  blocks: string[];
  warnings: string[];
  passes: string[];
  result: CompanyDryRun;
};

async function dryRun(build: (fixture: HscrFixture) => Promise<void>, cutoff?: string): Promise<Outcome> {
  return withHscrFixture(async (fixture) => {
    await build(fixture);
    const result = await fixture.dryRun(cutoff);
    return {
      cost: new Map(result.proposals.map((proposal) => [proposal.salesItemId, proposal.proposedCostPrice])),
      changed: new Map(result.proposals.map((proposal) => [proposal.salesItemId, proposal.changed])),
      blocks: result.checks.filter((check) => check.status === "block").map((check) => check.code),
      warnings: result.checks.filter((check) => check.status === "warning").map((check) => check.code),
      passes: result.checks.filter((check) => check.status === "pass").map((check) => check.code),
      result,
    };
  });
}

async function itemWithOpening(fixture: HscrFixture, quantity: number, rate: number | null): Promise<number> {
  const id = await fixture.item();
  await fixture.client.query("UPDATE stock_items SET opening_qty=$2, opening_rate=$3, opening_value=$4 WHERE id=$1", [
    id,
    quantity,
    rate,
    rate === null ? null : quantity * rate,
  ]);
  return id;
}

const CHECKPOINT = "2026-02-01T00:00:00Z";

describe("historical sales cost repair dry run", () => {
  it("rewinds the checkpoint through a legacy sale to the cost it really had", async () => {
    let sale = 0;
    const outcome = await dryRun(async (f) => {
      const l = await f.location();
      const i = await f.item();
      sale = (await f.sale("2026-01-05T10:00:00Z", l, i, 2, 99)).salesItemId;
      await f.checkpoint(CHECKPOINT, [{ locationId: l, stockItemId: i, quantity: 8, rate: 10 }]);
      await f.inventory(l, i, 8, 10);
    });

    expect(outcome.cost.get(sale)).toBe("10.00");
    expect(outcome.changed.get(sale)).toBe(true);
    expect(outcome.blocks).toEqual([]);
    expect(outcome.passes).toEqual(
      expect.arrayContaining(["VALUATION_CHECKPOINT_PRESENT", "CHECKPOINT_REWIND_COVERAGE"])
    );
    expect(outcome.result.report).toMatchObject({ legacySaleRows: 1, canonicalMovements: 0, changedSaleRows: 1 });
  });

  it("blocks every sale and keeps its recorded cost when the company has no checkpoint", async () => {
    let sale = 0;
    const outcome = await dryRun(async (f) => {
      const l = await f.location();
      const i = await f.item();
      sale = (await f.sale("2026-01-05T10:00:00Z", l, i, 2, 99)).salesItemId;
    });

    expect(outcome.cost.get(sale)).toBe("99.00");
    expect(outcome.changed.get(sale)).toBe(false);
    expect(outcome.blocks).toContain("VALUATION_CHECKPOINT_MISSING");
  });

  it("unwinds a priced receipt between two sales into the weighted average each sale saw", async () => {
    const sales: number[] = [];
    const outcome = await dryRun(async (f) => {
      const l = await f.location();
      const i = await f.item();
      sales.push((await f.sale("2026-01-05T10:00:00Z", l, i, 2, 99)).salesItemId);
      await f.adjustment("2026-01-10T10:00:00Z", l, i, 10, 20);
      sales.push((await f.sale("2026-01-15T10:00:00Z", l, i, 4, 1)).salesItemId);
      await f.checkpoint(CHECKPOINT, [{ locationId: l, stockItemId: i, quantity: 14, rate: 15, value: 210 }]);
    });

    // 14 @ 15 after the second sale; 18 @ 15 before it; taking the 10 @ 20
    // receipt back out leaves 8 units worth 70, i.e. 8.75 for the first sale.
    expect(sales.map((id) => outcome.cost.get(id))).toEqual(["8.75", "15.00"]);
    // 8.75 is a rate the item never carried in any recorded movement.
    expect(outcome.blocks).toContain("LEGACY_PROPOSED_COST_OUTSIDE_RATE_HULL");
  });

  it("follows stock through a transfer and a credit note return", async () => {
    let sale = 0;
    const outcome = await dryRun(async (f) => {
      const a = await f.location("A");
      const b = await f.location("B");
      const i = await f.item();
      await f.transfer("2026-01-04T10:00:00Z", a, b, i, 5, 10);
      sale = (await f.sale("2026-01-05T10:00:00Z", b, i, 2, 99)).salesItemId;
      // The return comes back in at 20, lifting B from 3 @ 10 to 4 @ 12.50.
      await f.note("2026-01-06T10:00:00Z", "Credit Note", b, i, 1, 20);
      await f.checkpoint(CHECKPOINT, [
        { locationId: a, stockItemId: i, quantity: 5, rate: 10 },
        { locationId: b, stockItemId: i, quantity: 4, rate: 12.5 },
      ]);
    });

    expect(outcome.cost.get(sale)).toBe("10.00");
    expect(outcome.warnings).toContain("REWIND_BOUNDARY_DIAGNOSTIC");
  });

  it("takes a debit note out of stock at the running average", async () => {
    let sale = 0;
    const outcome = await dryRun(async (f) => {
      const l = await f.location();
      const i = await f.item();
      await f.offload("2026-01-02T10:00:00Z", l, i, 6, 10);
      sale = (await f.sale("2026-01-03T10:00:00Z", l, i, 2, 99)).salesItemId;
      await f.note("2026-01-04T10:00:00Z", "Debit Note", l, i, 1, 4);
      await f.checkpoint(CHECKPOINT, [{ locationId: l, stockItemId: i, quantity: 3, rate: 12 }]);
    });

    // An issue never changes the average, so the checkpoint's 12 carries back
    // through the debit note to the sale. Counting the note as stock coming in
    // would instead take a unit at 4 back out and raise the sale's cost.
    expect(outcome.cost.get(sale)).toBe("12.00");
  });

  it("prices sales inside offload eras that start and end at zero stock", async () => {
    const sales: number[] = [];
    const outcome = await dryRun(async (f) => {
      const l = await f.location();
      const i = await f.item();
      await f.offload("2026-01-02T10:00:00Z", l, i, 3, 7);
      sales.push((await f.sale("2026-01-03T10:00:00Z", l, i, 3, 50)).salesItemId);
      await f.offload("2026-01-04T10:00:00Z", l, i, 5, 9);
      sales.push((await f.sale("2026-01-05T10:00:00Z", l, i, 2, 50)).salesItemId);
      await f.checkpoint(CHECKPOINT, [{ locationId: l, stockItemId: i, quantity: 3, rate: 9 }]);
    });

    expect(sales.map((id) => outcome.cost.get(id))).toEqual(["7.00", "9.00"]);
    expect(outcome.blocks).toEqual([]);
  });

  it("proves a closed zero-stock era when the checkpoint itself is empty", async () => {
    let sale = 0;
    const outcome = await dryRun(async (f) => {
      const l = await f.location();
      const i = await f.item();
      await f.offload("2026-01-02T10:00:00Z", l, i, 3, 7);
      sale = (await f.sale("2026-01-03T10:00:00Z", l, i, 3, 50)).salesItemId;
      await f.checkpoint(CHECKPOINT, [{ locationId: l, stockItemId: i, quantity: 0, rate: 0 }]);
    });

    expect(outcome.cost.get(sale)).toBe("7.00");
    expect(outcome.passes).toContain("CLOSED_ZERO_STOCK_ERA_PROVEN");
    expect(outcome.warnings).toEqual(expect.arrayContaining(["CHECKPOINT_REWIND_CONTRADICTED_BELOW"]));
  });

  it("trusts the checkpoint rate over an earlier receipt that disagrees with it", async () => {
    let sale = 0;
    const outcome = await dryRun(async (f) => {
      const l = await f.location();
      const i = await f.item();
      await f.adjustment("2026-01-02T10:00:00Z", l, i, 5, 10);
      sale = (await f.sale("2026-01-05T10:00:00Z", l, i, 2, 99)).salesItemId;
      await f.checkpoint(CHECKPOINT, [{ locationId: l, stockItemId: i, quantity: 7, rate: 12 }]);
    });

    expect(outcome.cost.get(sale)).toBe("12.00");
    expect(outcome.warnings).toContain("OPENING_FORWARD_QTY_MISMATCH");
  });

  it("prices a canonical POS sale from its journaled issue and a legacy sale from the rewind", async () => {
    let legacy = 0;
    let pos = 0;
    const outcome = await dryRun(async (f) => {
      const l = await f.location();
      const i = await f.item();
      legacy = (await f.sale("2026-01-05T10:00:00Z", l, i, 2, 99)).salesItemId;
      await f.checkpoint(CHECKPOINT, [{ locationId: l, stockItemId: i, quantity: 8, rate: 10 }]);
      const sale = await f.sale("2026-02-05T10:00:00Z", l, i, 1, 33);
      pos = sale.salesItemId;
      await f.canonical(
        "2026-02-05T10:00:00Z",
        l,
        i,
        -1,
        10,
        "pos-sale",
        String(sale.voucherId),
        `pos-sale:${sale.voucherId}:rev0:issue:${i}`
      );
      await f.canonical("2026-02-06T10:00:00Z", l, i, 4, 20, "stock-adjustment", "77");
    });

    expect(outcome.cost.get(legacy)).toBe("10.00");
    expect(outcome.cost.get(pos)).toBe("10.00");
    expect(outcome.result.report).toMatchObject({ canonicalMovements: 2, canonicalSaleRows: 1, legacySaleRows: 1 });
  });

  it("refuses to order a sale against a priced receipt with the same timestamp", async () => {
    const outcome = await dryRun(async (f) => {
      const l = await f.location();
      const i = await f.item();
      await f.adjustment("2026-01-05T10:00:00Z", l, i, 4, 30);
      await f.sale("2026-01-05T10:00:00Z", l, i, 2, 99);
      await f.checkpoint(CHECKPOINT, [{ locationId: l, stockItemId: i, quantity: 10, rate: 15 }]);
    });

    expect(outcome.blocks).toContain("SAME_TIMESTAMP_COST_ORDER_AMBIGUOUS");
    expect(outcome.warnings).toContain("OPENING_FORWARD_SKIPPED_PREEXISTING_BLOCK");
  });

  it("treats production as stock in and consumption as stock out", async () => {
    let sale = 0;
    const outcome = await dryRun(async (f) => {
      const l = await f.location();
      const i = await f.item();
      await f.adjustment("2026-01-02T10:00:00Z", l, i, 6, 10, "production");
      sale = (await f.sale("2026-01-03T10:00:00Z", l, i, 2, 99)).salesItemId;
      await f.adjustment("2026-01-04T10:00:00Z", l, i, 4, 20);
      // Consumption is recorded as a positive quantity but takes stock out.
      await f.adjustment("2026-01-05T10:00:00Z", l, i, 2, 15, "consumption");
      await f.checkpoint(CHECKPOINT, [{ locationId: l, stockItemId: i, quantity: 6, rate: 15 }]);
    });

    // 6 @ 15, plus the 2 consumed, less the 4 @ 20 receipt: 4 @ 10 before the
    // receipt, so the sale took stock at 10.
    expect(outcome.cost.get(sale)).toBe("10.00");
    expect(outcome.warnings).not.toContain("OPENING_FORWARD_QTY_MISMATCH");
  });

  it("replays forward from the item opening through receipts that change the rate", async () => {
    const sales: number[] = [];
    const outcome = await dryRun(async (f) => {
      const l = await f.location();
      const i = await itemWithOpening(f, 10, 4);
      sales.push((await f.sale("2026-01-02T10:00:00Z", l, i, 2, 50)).salesItemId);
      await f.adjustment("2026-01-03T10:00:00Z", l, i, 8, 6);
      sales.push((await f.sale("2026-01-04T10:00:00Z", l, i, 4, 50)).salesItemId);
      await f.checkpoint(CHECKPOINT, [{ locationId: l, stockItemId: i, quantity: 12, rate: 5 }]);
    });

    expect(sales.map((id) => outcome.cost.get(id))).toEqual(["4.00", "5.00"]);
    expect(outcome.passes).toContain("OPENING_FORWARD_REPLAY_PROVEN");
  });

  it("prices a sale from an unpriced receipt that halves the average", async () => {
    let sale = 0;
    const outcome = await dryRun(async (f) => {
      const l = await f.location();
      const i = await itemWithOpening(f, 4, 5);
      await f.adjustment("2026-01-02T10:00:00Z", l, i, 4, 0);
      sale = (await f.sale("2026-01-03T10:00:00Z", l, i, 2, 50)).salesItemId;
      await f.checkpoint(CHECKPOINT, [{ locationId: l, stockItemId: i, quantity: 6, rate: 2.5 }]);
    });

    expect(outcome.cost.get(sale)).toBe("2.50");
  });

  it("prices sales before and after a short spell of negative stock", async () => {
    const sales: number[] = [];
    const outcome = await dryRun(async (f) => {
      const l = await f.location();
      const i = await f.item();
      sales.push((await f.sale("2026-01-01T10:00:00Z", l, i, 2, 40)).salesItemId);
      await f.offload("2026-01-02T10:00:00Z", l, i, 2, 6);
      await f.offload("2026-01-02T12:00:00Z", l, i, 4, 8);
      sales.push((await f.sale("2026-01-03T10:00:00Z", l, i, 4, 50)).salesItemId);
      await f.offload("2026-01-04T10:00:00Z", l, i, 5, 9);
      sales.push((await f.sale("2026-01-05T10:00:00Z", l, i, 2, 50)).salesItemId);
      await f.checkpoint(CHECKPOINT, [{ locationId: l, stockItemId: i, quantity: 3, rate: 9 }]);
    });

    // The first sale ran stock negative with no cost memory at all.
    expect(sales.map((id) => outcome.cost.get(id))).toEqual(["0.00", "8.00", "9.00"]);
    expect(outcome.blocks).toContain("LEGACY_PROPOSED_COST_OUTSIDE_RATE_HULL");
  });

  it("splits one item opening across two locations", async () => {
    const sales: number[] = [];
    const outcome = await dryRun(async (f) => {
      const a = await f.location("A");
      const b = await f.location("B");
      const i = await itemWithOpening(f, 6, 3);
      sales.push((await f.sale("2026-01-02T10:00:00Z", a, i, 1, 50)).salesItemId);
      sales.push((await f.sale("2026-01-02T11:00:00Z", b, i, 1, 50)).salesItemId);
      await f.checkpoint(CHECKPOINT, [
        { locationId: a, stockItemId: i, quantity: 2, rate: 3 },
        { locationId: b, stockItemId: i, quantity: 2, rate: 3 },
      ]);
    });

    expect(sales.map((id) => outcome.cost.get(id))).toEqual(["3.00", "3.00"]);
    expect(outcome.passes.filter((code) => code === "OPENING_FORWARD_REPLAY_PROVEN")).toHaveLength(2);
  });

  it("ignores deleted and optional sales and sales after the cutoff", async () => {
    const outcome = await dryRun(async (f) => {
      const l = await f.location();
      const i = await f.item();
      await f.sale("2026-01-05T10:00:00Z", l, i, 1, 99, 15, { deletedAt: "2026-01-06T00:00:00Z" });
      await f.sale("2026-01-05T11:00:00Z", l, i, 1, 99, 15, { optional: true });
      await f.sale("2026-03-05T11:00:00Z", l, i, 1, 99);
      await f.checkpoint(CHECKPOINT, [{ locationId: l, stockItemId: i, quantity: 8, rate: 10 }]);
    }, "2026-02-15T00:00:00Z");

    expect(outcome.result.proposals).toEqual([]);
    expect(outcome.result.report).toMatchObject({ saleRows: 0 });
  });
});

describe("historical sales cost repair dry run: merged stock items", () => {
  // A source item sold under its old code, then merged into the kept item; the
  // checkpoint only knows the kept item, so the source sales are recovered
  // through the merge or blocked.
  async function merged(
    build: (f: HscrFixture, ids: { l: number; source: number; kept: number }) => Promise<void>,
    mergeAt = "2026-01-10T00:00:00Z"
  ) {
    let sale = 0;
    const outcome = await dryRun(async (f) => {
      const l = await f.location();
      const source = await f.item("OLD");
      const kept = await f.item("NEW");
      await build(f, { l, source, kept });
      sale = (await f.client.query("SELECT MIN(si.id) AS id FROM sales_items si WHERE si.stock_item_id=$1", [source]))
        .rows[0].id;
      await f.merge(source, kept, mergeAt);
    });
    return { outcome, sale };
  }

  it("replays a source item that opened at exactly zero forward to its sale", async () => {
    const { outcome, sale } = await merged(async (f, { l, source, kept }) => {
      await f.offload("2026-01-02T10:00:00Z", l, source, 4, 6);
      await f.sale("2026-01-03T10:00:00Z", l, source, 2, 50);
      await f.checkpoint(CHECKPOINT, [{ locationId: l, stockItemId: kept, quantity: 2, rate: 6 }]);
    });

    expect(outcome.cost.get(sale)).toBe("6.00");
    expect(outcome.passes).toContain("MERGED_ITEM_ZERO_OPENING_REPLAY");
    expect(outcome.blocks).toEqual([]);
  });

  it("splits a nonzero source opening out of the kept item's checkpoint", async () => {
    const { outcome, sale } = await merged(async (f, { l, source, kept }) => {
      await f.opening(source, 4, 5);
      await f.sale("2026-01-03T10:00:00Z", l, source, 2, 50);
      await f.checkpoint(CHECKPOINT, [{ locationId: l, stockItemId: kept, quantity: 2, rate: 5 }]);
    });

    expect(outcome.cost.get(sale)).toBe("5.00");
    expect(outcome.passes).toContain("MERGED_ITEM_IDENTITY_RECONCILED");
    // More than one pre-sale rate reproduces the merged state exactly.
    expect(outcome.blocks).toContain("LEGACY_SALE_INVERSE_NOT_UNIQUE");
  });

  it.each([
    [
      "a merge after the checkpoint",
      "MERGED_ITEM_MERGE_TIMESTAMP_INVALID",
      "2026-03-10T00:00:00Z",
      async (f: HscrFixture, { l, source, kept }: { l: number; source: number; kept: number }) => {
        await f.offload("2026-01-02T10:00:00Z", l, source, 4, 6);
        await f.sale("2026-01-03T10:00:00Z", l, source, 2, 50);
        await f.checkpoint(CHECKPOINT, [{ locationId: l, stockItemId: kept, quantity: 2, rate: 6 }]);
      },
    ],
    [
      "source stock moving after the merge",
      "MERGED_ITEM_SOURCE_MOVEMENT_AFTER_MERGE",
      undefined,
      async (f: HscrFixture, { l, source, kept }: { l: number; source: number; kept: number }) => {
        await f.offload("2026-01-02T10:00:00Z", l, source, 4, 6);
        await f.sale("2026-01-03T10:00:00Z", l, source, 2, 50);
        await f.adjustment("2026-01-12T10:00:00Z", l, source, 1, 6);
        await f.checkpoint(CHECKPOINT, [{ locationId: l, stockItemId: kept, quantity: 3, rate: 6 }]);
      },
    ],
    [
      "both items having an opening",
      "MERGED_ITEM_SPLIT_UNPROVEN",
      undefined,
      async (f: HscrFixture, { l, source, kept }: { l: number; source: number; kept: number }) => {
        await f.opening(source, 4, 5);
        await f.opening(kept, 3, 5);
        await f.sale("2026-01-03T10:00:00Z", l, source, 2, 50);
        await f.checkpoint(CHECKPOINT, [{ locationId: l, stockItemId: kept, quantity: 5, rate: 5 }]);
      },
    ],
    [
      "the kept item missing from the checkpoint at the sale's location",
      "MERGED_ITEM_KEPT_REWIND_FAILED",
      undefined,
      async (f: HscrFixture, { l, source, kept }: { l: number; source: number; kept: number }) => {
        const elsewhere = await f.location("Elsewhere");
        await f.opening(source, 4, 5);
        await f.sale("2026-01-03T10:00:00Z", l, source, 2, 50);
        await f.checkpoint(CHECKPOINT, [{ locationId: elsewhere, stockItemId: kept, quantity: 2, rate: 5 }]);
      },
    ],
  ])("keeps the recorded cost and blocks on %s", async (_label, code, mergeAt, build) => {
    const { outcome, sale } = await merged(build, mergeAt);

    expect(outcome.cost.get(sale)).toBe("50.00");
    expect(outcome.changed.get(sale)).toBe(false);
    expect(outcome.blocks).toContain(code);
  });

  it("refuses to place a source opening when the kept item also moved before the merge", async () => {
    const { outcome, sale } = await merged(async (f, { l, source, kept }) => {
      await f.opening(source, 4, 5);
      await f.adjustment("2026-01-02T10:00:00Z", l, kept, 2, 8);
      await f.sale("2026-01-03T10:00:00Z", l, source, 2, 50);
      await f.adjustment("2026-01-15T10:00:00Z", l, kept, 4, 10);
      await f.sale("2026-01-20T10:00:00Z", l, kept, 1, 50);
      await f.checkpoint(CHECKPOINT, [{ locationId: l, stockItemId: kept, quantity: 7, rate: 8, value: 56 }]);
    });

    expect(outcome.cost.get(sale)).toBe("50.00");
    expect(outcome.blocks).toContain("MERGED_ITEM_OPENING_LOCATION_AMBIGUOUS");
  });
});
