import { db } from "../../db";
import { companyStockValue } from "../../services/inventory/stockValuation";

/**
 * ERP Stock In Hand — the value of location inventory.
 *
 * Wave 11: the one stock valuation (server/services/inventory/stockValuation.ts):
 * SUM(inventory.total_value) over the company's non-deleted locations, active or
 * inactive, bale mirror left out, negative stock not subtracting. With no
 * `toDate` it is the live value; with one it is replayed back to that date from
 * the stored values. quantity × average_rate is never used: the stored rate is
 * display precision and drifts from the stored value.
 */
export async function computeStockInHand(companyId: number, toDate: string | null | undefined): Promise<number> {
  return Number(await companyStockValue(db, companyId, toDate));
}
