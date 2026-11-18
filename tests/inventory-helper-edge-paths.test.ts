// Behaviour of adjustInventory / reverseInventoryByExactValue on paths a real
// database rarely reaches: a negative receipt value, a concurrent first insert,
// and a reversal against a missing inventory row.
import { afterEach, describe, expect, it, vi } from "vitest";
import { adjustInventory, reverseInventoryByExactValue } from "../server/inventoryHelper";
import { logger } from "../server/lib/logger";

type Tx = Parameters<typeof adjustInventory>[0];

/** A transaction double that answers each execute() from a script, then with no rows. */
function scriptedTx(script: unknown[]) {
  const queue = [...script];
  const execute = vi.fn(async () => (queue.length ? queue.shift() : { rows: [] }));
  return { tx: { execute } as unknown as Tx, execute };
}

const row = (quantity: string, averageRate: string, totalValue: string, extra: Record<string, unknown> = {}) => ({
  rows: [{ id: 7, company_id: 3, quantity, average_rate: averageRate, total_value: totalValue, ...extra }],
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("adjustInventory edge paths", () => {
  it("receives a negative-valued receipt at zero value and logs it", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    const { tx } = scriptedTx([row("10", "10", "100")]);

    const result = await adjustInventory(tx, 1, 2, 5, 3, -4);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Negative receipt value received at zero"));
    expect(result.previousQuantity).toBe(10);
    expect(result.newQuantity).toBe(15);
    expect(result.previousTotalValue).toBe(100);
    expect(result.newTotalValue).toBe(100);
    expect(result.receiptValue).toBe("0.00");
    expect(result.created).toBe(false);
  });

  it("re-applies the movement against the row a concurrent transaction inserted first", async () => {
    const { tx, execute } = scriptedTx([
      { rows: [] }, // lock: no row yet
      { rows: [] }, // INSERT ... ON CONFLICT DO NOTHING inserted nothing
      row("4", "5", "20"), // retry lock: the concurrent row
    ]);

    const result = await adjustInventory(tx, 1, 2, 6, 3, 5);

    expect(result.created).toBe(false);
    expect(result.previousQuantity).toBe(4);
    expect(result.newQuantity).toBe(10);
    expect(result.previousTotalValue).toBe(20);
    expect(result.newTotalValue).toBe(50);
    expect(result.valueDelta).toBe("30.00");
    // lock, insert, retry lock, update, clear resolved layers
    expect(execute).toHaveBeenCalledTimes(5);
  });

  it("creates the row when the first insert succeeds", async () => {
    const { tx } = scriptedTx([{ rows: [] }, { rows: [{ id: 9 }] }]);

    const result = await adjustInventory(tx, 1, 2, 2, 3, 7);

    expect(result.created).toBe(true);
    expect(result.newQuantity).toBe(2);
    expect(result.newTotalValue).toBe(14);
  });
});

describe("reverseInventoryByExactValue edge paths", () => {
  it("returns null and logs when there is no inventory row to reverse", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    const { tx, execute } = scriptedTx([{ rows: [] }]);

    await expect(reverseInventoryByExactValue(tx, 1, 2, 3, "30", 3)).resolves.toBeNull();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("No inventory row to reverse"));
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("keeps the negative average when a reversal takes the row short with negative value", async () => {
    const { tx, execute } = scriptedTx([row("1", "10", "10")]);

    const result = await reverseInventoryByExactValue(tx, 1, 2, 3, "30");

    expect(result).toEqual({
      previousQuantity: 1,
      newQuantity: -2,
      previousTotalValue: 10,
      newTotalValue: -20,
      valueDelta: "-30.00",
    });
    // lock, negative layer for the 2-unit shortage (row's own company), update
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("falls back to the reversed unit value for the shortage layer when no average remains", async () => {
    const { tx, execute } = scriptedTx([row("0", "0", "0")]);

    const result = await reverseInventoryByExactValue(tx, 1, 2, 2, "0", 3);

    expect(result).toMatchObject({ previousQuantity: 0, newQuantity: -2, newTotalValue: 0, valueDelta: "0.00" });
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("does not create a shortage layer when the reversal leaves stock on hand", async () => {
    const { tx, execute } = scriptedTx([row("5", "10", "50")]);

    const result = await reverseInventoryByExactValue(tx, 1, 2, 2, "20", 3);

    expect(result).toMatchObject({ newQuantity: 3, newTotalValue: 30, valueDelta: "-20.00" });
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
