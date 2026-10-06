import { sql } from "drizzle-orm";
import type { DbTransaction } from "../../../db";
import { resultRows } from "../../../lib/queryResult";
import { roundInventoryValue, subtractInventoryValues } from "../../../lib/inventoryMath";
import { applyContainerChargeDeltaTx, type ChargePrefix } from "./charge-voucher-sync";

/**
 * One-time repair for offloads whose charge vouchers were edited before
 * voucher edits re-priced the bales.
 *
 * For every active offload, each charge column that has its own voucher
 * (DUTY → duties, OFFICE → office charges, TRANS → transport fees,
 * XFER → transfer charges) is compared with the sum of that container's live
 * vouchers. A difference is applied through the same routine the voucher-edit
 * sync uses, so the offload record, its lines and the inventory still on hand
 * end up exactly as if the edit had been synced when it was made.
 *
 * A charge with no voucher (entered at offload without an account) has nothing
 * to compare against and is left alone, as are suspended (optional) offloads.
 * CHG- (additional) charges have no column of their own and are not compared.
 */

const REPAIRABLE_PREFIXES: ChargePrefix[] = ["DUTY", "OFFICE", "TRANS", "XFER"];

export interface ContainerChargeVoucherDrift {
  offloadId: number;
  containerNumber: string;
  locationName: string | null;
  offloadedAt: string;
  prefix: ChargePrefix;
  stored: string;
  vouchers: string;
  chargeDelta: string;
  totalBales: string;
  oldCostPerBale: string;
  newCostPerBale: string;
  /** This container's bales the location still holds (at most the offloaded quantity per item). */
  balesOnHand: string;
}

type DriftRow = {
  offload_id: number;
  container_number: string;
  location_name: string | null;
  offloaded_at: string | Date;
  prefix: ChargePrefix;
  stored: string;
  vouchers: string;
  total_charges: string;
  total_bales: string;
  additional_cost_per_bale: string;
  bales_on_hand: string | null;
};

export async function findContainerChargeVoucherDriftTx(
  tx: DbTransaction,
  companyId: number
): Promise<ContainerChargeVoucherDrift[]> {
  const prefixes = sql.join(
    REPAIRABLE_PREFIXES.map((prefix) => sql`(${prefix})`),
    sql`, `
  );
  const result = await tx.execute(sql`
    WITH charges AS (
      SELECT o.id AS offload_id, c.container_number, l.name AS location_name, o.offloaded_at,
             cat.prefix, o.total_charges, o.total_bales, o.additional_cost_per_bale,
             CASE cat.prefix
               WHEN 'DUTY' THEN o.duties
               WHEN 'OFFICE' THEN o.office_charges
               WHEN 'TRANS' THEN o.transport_fees
               ELSE o.transfer_charges
             END AS stored,
             (SELECT ROUND(SUM(CASE WHEN v.optional THEN 0 ELSE v.total_amount::numeric END), 2)
                FROM vouchers v
               WHERE v.company_id = c.company_id
                 AND v.deleted_at IS NULL
                 AND LEFT(v.voucher_number, LENGTH(cat.prefix) + LENGTH(c.container_number) + 2)
                     = cat.prefix || '-' || c.container_number || '-'
                 AND SUBSTRING(v.voucher_number FROM LENGTH(cat.prefix) + LENGTH(c.container_number) + 3)
                     ~ '^[0-9]+$') AS vouchers
        FROM container_offloads o
        JOIN containers c ON c.id = o.container_id
        LEFT JOIN locations l ON l.id = o.location_id
        CROSS JOIN (VALUES ${prefixes}) AS cat(prefix)
       WHERE c.company_id = ${companyId}
         AND c.status = 'OFFLOADED'
         AND o.optional = false
    )
    SELECT ch.*,
           (SELECT SUM(LEAST(GREATEST(COALESCE(i.quantity, 0), 0), oi.quantity))
              FROM container_offload_items oi
              JOIN container_offloads o ON o.id = oi.offload_id
              LEFT JOIN inventory i ON i.location_id = o.location_id AND i.stock_item_id = oi.stock_item_id
             WHERE oi.offload_id = ch.offload_id) AS bales_on_hand
      FROM charges ch
     WHERE ch.vouchers IS NOT NULL
       AND ch.vouchers <> ch.stored
     ORDER BY ch.container_number, ch.prefix
  `);

  return resultRows<DriftRow>(result).map((row) => {
    const chargeDelta = roundInventoryValue(subtractInventoryValues(row.vouchers, row.stored), 2);
    const newTotal = chargeDelta.plus(row.total_charges);
    const bales = roundInventoryValue(row.total_bales, 3);
    return {
      offloadId: Number(row.offload_id),
      containerNumber: row.container_number,
      locationName: row.location_name,
      offloadedAt: new Date(row.offloaded_at).toISOString().slice(0, 10),
      prefix: row.prefix,
      stored: roundInventoryValue(row.stored, 2).toFixed(2),
      vouchers: roundInventoryValue(row.vouchers, 2).toFixed(2),
      chargeDelta: chargeDelta.toFixed(2),
      totalBales: bales.toFixed(3),
      oldCostPerBale: roundInventoryValue(row.additional_cost_per_bale, 2).toFixed(2),
      newCostPerBale: bales.greaterThan(0) ? roundInventoryValue(newTotal.dividedBy(bales), 2).toFixed(2) : "0.00",
      balesOnHand: roundInventoryValue(row.bales_on_hand ?? 0, 3).toFixed(3),
    };
  });
}

export interface ContainerChargeVoucherRepairResult {
  repaired: ContainerChargeVoucherDrift[];
}

/**
 * Apply every drift the preview finds (or only those on `offloadIds`), in the
 * caller's transaction. The drift is re-read inside the transaction so what is
 * applied is what the current data says, not a stale preview.
 */
export async function repairContainerChargeVoucherDriftTx(
  tx: DbTransaction,
  companyId: number,
  offloadIds?: number[]
): Promise<ContainerChargeVoucherRepairResult> {
  const only = offloadIds && offloadIds.length > 0 ? new Set(offloadIds) : null;
  const drift = (await findContainerChargeVoucherDriftTx(tx, companyId)).filter(
    (row) => !only || only.has(row.offloadId)
  );
  const repaired: ContainerChargeVoucherDrift[] = [];
  for (const row of drift) {
    const result = await applyContainerChargeDeltaTx(tx, {
      companyId,
      containerNumber: row.containerNumber,
      prefix: row.prefix,
      chargeDelta: row.chargeDelta,
    });
    if (result) repaired.push(row);
  }
  return { repaired };
}
