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
  const voucherPattern = `^(${REPAIRABLE_PREFIXES.join("|")})-(.+)-([0-9]+)$`;

  // Keep this scan set-based. The old query ran one correlated vouchers scan
  // for every offload × charge prefix, which timed out in production once the
  // voucher table grew. Parse each candidate voucher once, aggregate it once,
  // then join those totals back to the active offloads.
  const result = await tx.execute(sql`
    WITH active_offloads AS MATERIALIZED (
      SELECT o.id AS offload_id,
             o.location_id,
             c.container_number,
             l.name AS location_name,
             o.offloaded_at,
             o.total_charges,
             o.total_bales,
             o.additional_cost_per_bale,
             o.duties,
             o.office_charges,
             o.transport_fees,
             o.transfer_charges
        FROM container_offloads o
        JOIN containers c ON c.id = o.container_id
        LEFT JOIN locations l ON l.id = o.location_id
       WHERE c.company_id = ${companyId}
         AND c.status = 'OFFLOADED'
         AND o.optional = false
    ),
    voucher_parts AS (
      SELECT match[1] AS prefix,
             match[2] AS container_number,
             CASE WHEN v.optional THEN 0::numeric ELSE v.total_amount::numeric END AS amount
        FROM vouchers v
        CROSS JOIN LATERAL regexp_match(v.voucher_number, ${voucherPattern}) AS match
       WHERE v.company_id = ${companyId}
         AND v.deleted_at IS NULL
    ),
    voucher_totals AS (
      SELECT prefix,
             container_number,
             ROUND(SUM(amount), 2) AS vouchers
        FROM voucher_parts
       GROUP BY prefix, container_number
    ),
    charges AS (
      SELECT ao.offload_id,
             ao.container_number,
             ao.location_name,
             ao.offloaded_at,
             ao.total_charges,
             ao.total_bales,
             ao.additional_cost_per_bale,
             cat.prefix,
             CASE cat.prefix
               WHEN 'DUTY' THEN ao.duties
               WHEN 'OFFICE' THEN ao.office_charges
               WHEN 'TRANS' THEN ao.transport_fees
               ELSE ao.transfer_charges
             END AS stored,
             vt.vouchers
        FROM active_offloads ao
        CROSS JOIN (VALUES ${prefixes}) AS cat(prefix)
        JOIN voucher_totals vt
          ON vt.container_number = ao.container_number
         AND vt.prefix = cat.prefix
    ),
    stock_by_offload AS (
      SELECT oi.offload_id,
             SUM(LEAST(GREATEST(COALESCE(i.quantity, 0), 0), oi.quantity)) AS bales_on_hand
        FROM container_offload_items oi
        JOIN active_offloads ao ON ao.offload_id = oi.offload_id
        LEFT JOIN inventory i
          ON i.location_id = ao.location_id
         AND i.stock_item_id = oi.stock_item_id
       GROUP BY oi.offload_id
    )
    SELECT ch.*,
           stock.bales_on_hand
      FROM charges ch
      LEFT JOIN stock_by_offload stock ON stock.offload_id = ch.offload_id
     WHERE ch.vouchers <> ch.stored
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
