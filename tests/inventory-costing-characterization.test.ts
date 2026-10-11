/**
 * Characterization of adjustInventory / reverseInventoryByExactValue.
 *
 * This exists to make a behaviour change visible. The costing engine does its
 * arithmetic in JavaScript floats — `prevQty + deltaQty`, `remaining * rate`,
 * `newTotalValue / newQty` — while the rest of the accounting core uses
 * decimal.js. Converting it means every stored quantity, rate and value could
 * shift in its last digit, and there is no way to review that safely without a
 * before-and-after record.
 *
 * So: drive a scenario matrix through the real engine against the real database
 * and snapshot exactly what lands in `inventory` and `inventory_negative_layers`.
 * The snapshot is the golden master. After the decimal.js conversion, every
 * differing line has to be explained as a correction rather than a regression —
 * and lines that do not differ prove the conversion was behaviour-preserving.
 *
 * The values are chosen to stress float representation rather than to look
 * realistic: thirds that never terminate in binary, 0.1/0.2 sums, rates with
 * more precision than the 2dp column that stores them, and quantities that sit
 * exactly on the 0.0005 epsilon the engine uses as its "close enough to zero"
 * boundary.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../server/db";
import { adjustInventory, reverseInventoryByExactValue } from "../server/inventoryHelper";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "invchar";

let ctx: TestContext;

/** One step of a scenario: what to do, and what the engine returned. */
interface StepRecord {
  step: string;
  returned: {
    previousQuantity: string;
    newQuantity: string;
    previousTotalValue: string;
    newTotalValue: string;
    averageRate: string;
    created: boolean;
  };
  stored: { quantity: string; averageRate: string; totalValue: string } | null;
  negativeLayers: Array<{ qty: string; provisionalRate: string }>;
}

/**
 * Returned values are JS numbers today and will be numbers after the
 * conversion too, but their float representation is exactly what is under
 * review. Render them at a precision well beyond what any column stores, so a
 * drift of one ulp shows up in the snapshot instead of being rounded away.
 */
function renderNumber(value: number): string {
  return Number.isFinite(value) ? value.toFixed(6) : String(value);
}

async function readState(locationId: number, stockItemId: number) {
  const inventory: any = await db.execute(sql`
    SELECT quantity, average_rate, total_value
    FROM inventory
    WHERE location_id = ${locationId} AND stock_item_id = ${stockItemId}
  `);
  const inventoryRow = (inventory.rows ?? inventory)[0];

  const layers: any = await db.execute(sql`
    SELECT qty, provisional_rate
    FROM inventory_negative_layers
    WHERE location_id = ${locationId} AND stock_item_id = ${stockItemId}
    ORDER BY id ASC
  `);

  return {
    stored: inventoryRow
      ? {
          quantity: String(inventoryRow.quantity),
          averageRate: String(inventoryRow.average_rate),
          totalValue: String(inventoryRow.total_value),
        }
      : null,
    negativeLayers: (layers.rows ?? layers).map((row: any) => ({
      qty: String(row.qty),
      provisionalRate: String(row.provisional_rate),
    })),
  };
}

/** Remove every trace of this item so each scenario starts from nothing. */
async function resetItem(locationId: number, stockItemId: number): Promise<void> {
  await db.execute(sql`
    DELETE FROM inventory_negative_layers
    WHERE location_id = ${locationId} AND stock_item_id = ${stockItemId}
  `);
  await db.execute(sql`
    DELETE FROM inventory
    WHERE location_id = ${locationId} AND stock_item_id = ${stockItemId}
  `);
}

type Move = { kind: "adjust"; deltaQty: number; rate?: number } | { kind: "reverse"; qty: number; value: number };

function describeMove(move: Move): string {
  return move.kind === "adjust"
    ? `adjust delta=${move.deltaQty}${move.rate === undefined ? "" : ` rate=${move.rate}`}`
    : `reverse qty=${move.qty} value=${move.value}`;
}

/**
 * The fixture seeds three stock items. Each scenario resets its item to nothing
 * before it starts and the scenarios run sequentially, so cycling through them
 * keeps every run independent without needing a fixture change.
 */
function itemFor(slot: number): number {
  return ctx.stockItemIds[slot % ctx.stockItemIds.length];
}

async function runScenario(stockItemId: number, moves: Move[]): Promise<StepRecord[]> {
  const locationId = ctx.locationId;
  await resetItem(locationId, stockItemId);

  const records: StepRecord[] = [];

  for (const move of moves) {
    let returned: StepRecord["returned"];

    if (move.kind === "adjust") {
      const result = await adjustInventory(
        db as any,
        locationId,
        stockItemId,
        move.deltaQty,
        ctx.companyId,
        move.rate,
        "characterization",
        undefined
      );
      returned = {
        previousQuantity: renderNumber(result.previousQuantity),
        newQuantity: renderNumber(result.newQuantity),
        previousTotalValue: renderNumber(result.previousTotalValue),
        newTotalValue: renderNumber(result.newTotalValue),
        averageRate: renderNumber(result.averageRate),
        created: result.created,
      };
    } else {
      await reverseInventoryByExactValue(
        db as any,
        locationId,
        stockItemId,
        move.qty,
        move.value,
        ctx.companyId,
        "characterization",
        undefined
      );
      // This one returns void; the stored state below is the whole observation.
      returned = {
        previousQuantity: "-",
        newQuantity: "-",
        previousTotalValue: "-",
        newTotalValue: "-",
        averageRate: "-",
        created: false,
      };
    }

    const state = await readState(locationId, stockItemId);
    records.push({ step: describeMove(move), returned, ...state });
  }

  return records;
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
}, 60_000);

afterAll(async () => {
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 30_000);

beforeEach(async () => {
  for (const stockItemId of ctx.stockItemIds) {
    await resetItem(ctx.locationId, stockItemId);
  }
});

describe("adjustInventory costing — characterization", () => {
  it("receipts and issues that stay positive", async () => {
    expect(
      await runScenario(itemFor(0), [
        { kind: "adjust", deltaQty: 100, rate: 10 },
        { kind: "adjust", deltaQty: 50, rate: 12.5 },
        { kind: "adjust", deltaQty: -30 },
        { kind: "adjust", deltaQty: 25, rate: 9.99 },
        { kind: "adjust", deltaQty: -60 },
      ])
    ).toMatchSnapshot();
  });

  it("non-terminating rates and quantities", async () => {
    // 1/3 and 2/3 have no exact binary representation, and the moving average
    // divides by quantities that do not divide evenly.
    expect(
      await runScenario(itemFor(1), [
        { kind: "adjust", deltaQty: 3, rate: 10 / 3 },
        { kind: "adjust", deltaQty: 7, rate: 100 / 7 },
        { kind: "adjust", deltaQty: -1 },
        { kind: "adjust", deltaQty: 0.1, rate: 0.2 },
        { kind: "adjust", deltaQty: 0.2, rate: 0.1 },
        { kind: "adjust", deltaQty: -0.30000000000000004 },
      ])
    ).toMatchSnapshot();
  });

  it("crossing zero exactly", async () => {
    // The engine branches on `newQty === 0`, an exact float comparison. 0.1 + 0.2
    // does not equal 0.3 in binary, so how the sum lands decides the branch.
    expect(
      await runScenario(itemFor(2), [
        { kind: "adjust", deltaQty: 0.3, rate: 5 },
        { kind: "adjust", deltaQty: -0.1 },
        { kind: "adjust", deltaQty: -0.2 },
      ])
    ).toMatchSnapshot();
  });

  it("going short and settling FIFO across several layers", async () => {
    expect(
      await runScenario(itemFor(3), [
        { kind: "adjust", deltaQty: 10, rate: 4 },
        { kind: "adjust", deltaQty: -15 }, // 5 short, provisional rate 4
        { kind: "adjust", deltaQty: -5 }, // 5 more short, incremental only
        { kind: "adjust", deltaQty: 4, rate: 6 }, // partial settle of layer 1
        { kind: "adjust", deltaQty: 3, rate: 7 }, // finishes layer 1, starts layer 2
        { kind: "adjust", deltaQty: 20, rate: 8 }, // settles the rest, back positive
      ])
    ).toMatchSnapshot();
  });

  it("shortage quantities that sit on the 0.0005 epsilon", async () => {
    // The engine treats a residue below 0.0005 as zero — half of the third
    // decimal the qty column keeps. These land either side of that boundary.
    expect(
      await runScenario(itemFor(4), [
        { kind: "adjust", deltaQty: 1, rate: 3 },
        { kind: "adjust", deltaQty: -1.0004 },
        { kind: "adjust", deltaQty: -0.0006 },
        { kind: "adjust", deltaQty: 0.0004, rate: 3 },
        { kind: "adjust", deltaQty: 2, rate: 3 },
      ])
    ).toMatchSnapshot();
  });

  it("first touch is an issue, creating stock that starts short", async () => {
    expect(
      await runScenario(itemFor(5), [
        { kind: "adjust", deltaQty: -7.5, rate: 2.25 },
        { kind: "adjust", deltaQty: 2.5, rate: 2.25 },
        { kind: "adjust", deltaQty: 10, rate: 3 },
      ])
    ).toMatchSnapshot();
  });

  it("a zero-quantity adjustment leaves everything alone", async () => {
    expect(
      await runScenario(itemFor(6), [
        { kind: "adjust", deltaQty: 12, rate: 7.77 },
        { kind: "adjust", deltaQty: 0, rate: 999 },
      ])
    ).toMatchSnapshot();
  });

  it("exact-value reversal, including one that pushes the balance short", async () => {
    expect(
      await runScenario(itemFor(7), [
        { kind: "adjust", deltaQty: 20, rate: 6.5 },
        { kind: "reverse", qty: 5, value: 32.5 },
        { kind: "reverse", qty: 20, value: 130 },
        { kind: "adjust", deltaQty: 10, rate: 6.5 },
      ])
    ).toMatchSnapshot();
  });

  it("a rate carrying more precision than the column keeps", async () => {
    // adjustInventory writes average_rate at 2dp (the column keeps 7dp since
    // wave 11) and provisional_rate at 4dp. These rates round at
    // both boundaries, including a .005 case that depends on rounding mode.
    expect(
      await runScenario(itemFor(8), [
        { kind: "adjust", deltaQty: 1, rate: 1.005 },
        { kind: "adjust", deltaQty: 1, rate: 2.34567 },
        { kind: "adjust", deltaQty: 1, rate: 0.00005 },
        { kind: "adjust", deltaQty: -4 },
      ])
    ).toMatchSnapshot();
  });

  /**
   * Not a characterization — an assertion about what the answer should be.
   *
   * This is the one case where the decimal.js conversion changed a stored value,
   * and a snapshot alone would record the change without arguing it is right.
   * 1.005 rounded to the 2dp the column keeps is 1.01. The float engine stored
   * 1.00, because the double nearest 1.005 is 1.00499999999999989 and
   * `(1.005).toFixed(2)` rounds that down — understating inventory value by a
   * cent every time a rate landed on a half-cent boundary.
   */
  it("rounds a half-cent rate up rather than down", async () => {
    const records = await runScenario(itemFor(0), [{ kind: "adjust", deltaQty: 1, rate: 1.005 }]);

    expect(records[0].stored).toEqual({
      quantity: "1.000",
      // The column keeps 7dp since wave 11; the engine still writes 2dp.
      averageRate: "1.0100000",
      totalValue: "1.01",
    });
  });

  it("many small receipts accumulating float drift", async () => {
    // 0.1 added a hundred times is 9.99999999999998 in float, not 10. Whether
    // that matters depends on where the engine rounds.
    const moves: Move[] = [];
    for (let index = 0; index < 100; index += 1) {
      moves.push({ kind: "adjust", deltaQty: 0.1, rate: 1.1 });
    }
    moves.push({ kind: "adjust", deltaQty: -10 });
    expect(await runScenario(itemFor(9), moves)).toMatchSnapshot();
  });
});
