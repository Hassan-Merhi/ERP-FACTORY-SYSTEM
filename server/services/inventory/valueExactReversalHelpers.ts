// Extracted from ./valueExactReversal.ts
import type Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../../db";
import { toMoney, type MoneyInput } from "../../lib/money";
import { firstRow } from "../../lib/queryResult";

type StoredRow = { id: number; quantity: string; total_value: string };

export async function storedRow(
  tx: DbTransaction,
  companyId: number,
  locationId: number,
  stockItemId: number
): Promise<StoredRow | undefined> {
  return firstRow<StoredRow>(
    await tx.execute(sql`
      SELECT id, quantity::text AS quantity, total_value::text AS total_value
        FROM inventory
       WHERE company_id = ${companyId} AND location_id = ${locationId} AND stock_item_id = ${stockItemId}
       FOR UPDATE
    `)
  );
}

export interface ExactReversalParams {
  companyId: number;
  locationId: number;
  stockItemId: number;
  /** Quantity to move back (positive). */
  quantity: MoneyInput;
  /** Value to move back (positive): the line's value moved. */
  value: MoneyInput;
  /**
   * False for a legacy line whose value is only an estimate (no value_moved);
   * see restoreIssuedValueTx.
   */
  exact?: boolean;
  sourceVoucherType?: string;
  sourceVoucherId?: number;
}

export interface SaleLineForReversal {
  id: number;
  quantity: MoneyInput;
  totalCost?: MoneyInput;
  costPrice?: MoneyInput;
  valueMoved?: MoneyInput;
}

export interface SaleLineValue {
  value: Decimal;
  /** True when the value is the line's recorded value_moved. */
  exact: boolean;
}

/** A legacy sale line's own cost: total_cost, else quantity × cost_price. */
export function legacyLineCost(line: SaleLineForReversal): Decimal {
  if (line.totalCost !== null && line.totalCost !== undefined) return toMoney(line.totalCost).abs();
  return toMoney(line.quantity).abs().times(toMoney(line.costPrice)).abs().toDecimalPlaces(2);
}
