// Extracted from ./inventoryReadinessResolution.ts
import { sql } from "drizzle-orm";
import { type DbTransaction } from "../../db";
import { reverseInventoryByExactValue } from "../../inventoryHelper";
import { toMoney } from "../../lib/money";
import {
  rows,
  READINESS_ROW_MISSING_MESSAGE,
  archivedLocationCode,
  archivedLocationName,
  type ReadinessInventoryRow,
} from "./inventoryReadinessPlan";

export async function recreateArchivedLocationTx(
  tx: DbTransaction,
  companyId: number,
  locationId: number
): Promise<string> {
  let code = archivedLocationCode(locationId);
  const taken = await rows<{ id: number }>(tx, sql`SELECT id FROM locations WHERE code = ${code}`);
  if (taken.length > 0) code = `${code}-${companyId}`;
  await tx.execute(sql`
    INSERT INTO locations (id, company_id, code, name, active)
    VALUES (${locationId}, ${companyId}, ${code}, ${archivedLocationName(locationId)}, false)
  `);
  // An explicit id can be at or beyond the sequence: move the sequence past it
  // so the next location never collides with the recreated one.
  await tx.execute(sql`
    SELECT setval(pg_get_serial_sequence('locations', 'id'),
                  GREATEST((SELECT MAX(id) FROM locations), 1), true)
  `);
  return code;
}

export interface RowOutcome {
  inventoryId: number;
  locationId: number;
  stockItemId: number;
  before: { quantity: string; totalValue: string };
  after: { quantity: string; totalValue: string };
}

/** Writes an anomalous value off to zero; the quantity is kept. */
export async function zeroValueTx(
  tx: DbTransaction,
  companyId: number,
  row: ReadinessInventoryRow,
  runRef: string
): Promise<{ outcome: RowOutcome; valueDelta: string }> {
  const reversed = await reverseInventoryByExactValue(
    tx,
    row.locationId,
    row.stockItemId,
    0,
    row.totalValue,
    companyId,
    `inventory-readiness-anomaly:${runRef}`
  );
  if (!reversed) throw new Error(READINESS_ROW_MISSING_MESSAGE);
  return {
    outcome: {
      inventoryId: row.inventoryId,
      locationId: row.locationId,
      stockItemId: row.stockItemId,
      before: { quantity: row.quantity, totalValue: row.totalValue },
      after: {
        quantity: toMoney(reversed.newQuantity).toFixed(3),
        totalValue: toMoney(reversed.newTotalValue).toFixed(2),
      },
    },
    valueDelta: reversed.valueDelta,
  };
}
