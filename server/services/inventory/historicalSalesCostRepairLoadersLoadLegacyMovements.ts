// Extracted from ./historicalSalesCostRepairLoaders.ts to keep that module under the source-size cap.
import type { PoolClient } from "pg";
import { LegacyRow } from "./historicalSalesCostRepairTypes";

export async function loadLegacyMovements(
  client: PoolClient,
  companyId: number,
  canonicalStart: Date | null,
  sourceCutoff: Date
): Promise<LegacyRow[]> {
  const params = [companyId, canonicalStart, sourceCutoff];
  const rows = await client.query<LegacyRow>(
    `
    WITH boundary AS (
      SELECT $1::int AS company_id,$2::timestamptz AS canonical_start,$3::timestamptz AS source_cutoff
    ),
    -- V36: offloadContainer() posts its charge vouchers inside the same
    -- transaction that mutates inventory, numbered
    -- PREFIX-{containerNumber}-{Date.now()}. That system-generated millisecond
    -- stamp, corroborated by vouchers.created_at, is the real inventory
    -- mutation time; offloaded_at is only the user-entered calendar date.
    -- Used only when the container has exactly one offload and exactly one
    -- charge-voucher transaction, so re-offloads and later charge edits fall
    -- back to offloaded_at.
    offload_voucher_groups AS (
      SELECT
        v.company_id,
        substring(v.voucher_number from '^(?:DUTY|OFFICE|TRANS|XFER|CHG)-(.+)-[0-9]{13}$') AS container_number,
        COUNT(DISTINCT v.created_at) AS transaction_groups,
        MIN(v.created_at) AS entered_at,
        bool_and(
          ABS(
            substring(v.voucher_number from '([0-9]{13})$')::bigint -
            (EXTRACT(EPOCH FROM v.created_at) * 1000)::bigint
          ) < 120000
        ) AS stamp_agrees
      FROM vouchers v
      JOIN boundary b ON b.company_id=v.company_id
      WHERE v.voucher_type='Payment'
        AND v.voucher_number ~ '^(DUTY|OFFICE|TRANS|XFER|CHG)-.+-[0-9]{13}$'
      GROUP BY 1,2
    ),
    offload_entry AS (
      SELECT co.id AS offload_id, g.entered_at AS mutation_at
      FROM container_offloads co
      JOIN containers c ON c.id=co.container_id
      JOIN boundary b ON b.company_id=c.company_id
      JOIN offload_voucher_groups g
        ON g.company_id=c.company_id
       AND g.container_number=c.container_number
      WHERE COALESCE(co.optional,false)=false
        AND g.transaction_groups=1
        AND g.stamp_agrees
        AND g.entered_at <= b.source_cutoff
        AND (SELECT COUNT(*) FROM container_offloads o2 WHERE o2.container_id=co.container_id)=1
    ),
    offloads AS (
      SELECT
        'offload:'||coi.id::text AS movement_id,
        co.location_id,
        coi.stock_item_id,
        coi.quantity::text AS quantity_delta,
        coi.rate::text AS unit_cost,
        co.offloaded_at AS occurred_at,
        coi.id*10+1 AS sequence,
        'legacy-container-offload'::text AS source_type,
        co.id::text AS source_id
      FROM container_offload_items coi
      JOIN container_offloads co ON co.id=coi.offload_id
      JOIN containers c ON c.id=co.container_id
      JOIN boundary b ON b.company_id=c.company_id
      WHERE COALESCE(co.optional,false)=false
        AND co.offloaded_at <= b.source_cutoff
        AND NOT EXISTS (
          SELECT 1
            FROM canonical_stock_movements csm
           WHERE csm.company_id=b.company_id
             AND csm.stock_item_id=coi.stock_item_id
             AND csm.location_id=co.location_id
             AND csm.source_type IN ('legacy-container-offload','container-offload')
             AND csm.source_id=co.id::text
             AND csm.created_at <= b.source_cutoff
        )
    ),
    adjustments AS (
      SELECT
        'adjustment:'||sai.id::text,
        sav.location_id,
        sai.stock_item_id,
        (CASE
           WHEN lower(sav.adjustment_type)='production' THEN ABS(sai.quantity)
           WHEN lower(sav.adjustment_type)='consumption' THEN -ABS(sai.quantity)
           ELSE sai.quantity
         END)::text,
        sai.rate::text,
        GREATEST(sai.created_at,sav.created_at,v.created_at),
        sai.id*10+2,
        'legacy-stock-adjustment',
        sav.id::text
      FROM stock_adjustment_items sai
      JOIN stock_adjustment_vouchers sav ON sav.id=sai.adjustment_id
      JOIN vouchers v ON v.id=sav.voucher_id
      JOIN boundary b ON b.company_id=v.company_id
      WHERE v.deleted_at IS NULL
        AND COALESCE(v.optional,false)=false
        AND GREATEST(sai.created_at,sav.created_at,v.created_at) <= b.source_cutoff
        AND NOT EXISTS (
          SELECT 1
            FROM canonical_stock_movements csm
           WHERE csm.company_id=b.company_id
             AND csm.stock_item_id=sai.stock_item_id
             AND csm.location_id=sav.location_id
             AND csm.source_type='stock-adjustment'
             AND csm.source_id=sav.id::text
             AND csm.created_at <= b.source_cutoff
        )
    ),
    transfer_source AS (
      SELECT
        'transfer-out:'||sti.id::text,
        COALESCE(sti.source_location_id,stv.source_location_id) AS location_id,
        sti.stock_item_id,
        (-ABS(sti.quantity))::text,
        sti.rate::text,
        GREATEST(sti.created_at,stv.created_at,v.created_at),
        sti.id*10+3,
        CASE
          WHEN COALESCE(stv.inventory_applied,false)=true THEN 'legacy-stock-transfer-out'
          ELSE 'legacy-stock-transfer-out-flag-fallback'
        END,
        stv.id::text
      FROM stock_transfer_items sti
      JOIN stock_transfer_vouchers stv ON stv.id=sti.transfer_id
      JOIN vouchers v ON v.id=stv.voucher_id
      JOIN boundary b ON b.company_id=v.company_id
      WHERE COALESCE(sti.source_location_id,stv.source_location_id) IS NOT NULL
        AND v.deleted_at IS NULL
        AND COALESCE(v.optional,false)=false
        AND GREATEST(sti.created_at,stv.created_at,v.created_at) <= b.source_cutoff
        AND NOT EXISTS (
          SELECT 1
            FROM canonical_stock_movements csm
           WHERE csm.company_id=b.company_id
             AND csm.stock_item_id=sti.stock_item_id
             AND csm.location_id=COALESCE(sti.source_location_id,stv.source_location_id)
             AND csm.source_type IN ('stock-transfer','stock-transfer-import','stock-transfer-import-multi-source')
             AND csm.source_id IN (stv.id::text,v.id::text)
             AND csm.created_at <= b.source_cutoff
        )
    ),
    transfer_destination AS (
      SELECT
        'transfer-in:'||sti.id::text,
        stv.destination_location_id,
        sti.stock_item_id,
        ABS(sti.quantity)::text,
        sti.rate::text,
        GREATEST(sti.created_at,stv.created_at,v.created_at),
        sti.id*10+4,
        CASE
          WHEN COALESCE(stv.inventory_applied,false)=true THEN 'legacy-stock-transfer-in'
          ELSE 'legacy-stock-transfer-in-flag-fallback'
        END,
        stv.id::text
      FROM stock_transfer_items sti
      JOIN stock_transfer_vouchers stv ON stv.id=sti.transfer_id
      JOIN vouchers v ON v.id=stv.voucher_id
      JOIN boundary b ON b.company_id=v.company_id
      WHERE v.deleted_at IS NULL
        AND COALESCE(v.optional,false)=false
        AND GREATEST(sti.created_at,stv.created_at,v.created_at) <= b.source_cutoff
        AND NOT EXISTS (
          SELECT 1
            FROM canonical_stock_movements csm
           WHERE csm.company_id=b.company_id
             AND csm.stock_item_id=sti.stock_item_id
             AND csm.location_id=stv.destination_location_id
             AND csm.source_type IN ('stock-transfer','stock-transfer-import','stock-transfer-import-multi-source')
             AND csm.source_id IN (stv.id::text,v.id::text)
             AND csm.created_at <= b.source_cutoff
        )
    ),
    notes AS (
      SELECT
        'note:'||cni.id::text,
        cni.location_id,
        cni.stock_item_id,
        (CASE WHEN v.voucher_type='Credit Note' THEN ABS(cni.quantity) ELSE -ABS(cni.quantity) END)::text,
        cni.inventory_cost::text,
        GREATEST(cni.created_at,v.created_at),
        cni.id*10+6,
        CASE WHEN v.voucher_type='Credit Note' THEN 'legacy-credit-note' ELSE 'legacy-debit-note' END,
        v.id::text
      FROM credit_note_items cni
      JOIN vouchers v ON v.id=cni.voucher_id
      JOIN boundary b ON b.company_id=v.company_id
      WHERE v.voucher_type IN ('Credit Note','Debit Note')
        AND v.deleted_at IS NULL
        AND COALESCE(v.optional,false)=false
        AND GREATEST(cni.created_at,v.created_at) <= b.source_cutoff
        AND NOT EXISTS (
          SELECT 1
            FROM canonical_stock_movements csm
           WHERE csm.company_id=b.company_id
             AND csm.stock_item_id=cni.stock_item_id
             AND csm.location_id=cni.location_id
             AND csm.source_type IN ('credit-note','debit-note')
             AND csm.source_id=v.id::text
             AND csm.created_at <= b.source_cutoff
        )
    ),
    archive_out AS (
      SELECT
        'archive-out:'||ai.id::text,
        a.location_id,
        ai.stock_item_id,
        (-ABS(ai.quantity))::text,
        ai.average_rate::text,
        a.archived_at,
        ai.id*10+7,
        'legacy-stock-group-archive',
        a.id::text
      FROM stock_group_location_archive_items ai
      JOIN stock_group_location_archives a ON a.id=ai.archive_id
      JOIN boundary b ON b.company_id=a.company_id
      WHERE a.archived_at <= b.source_cutoff
        AND NOT EXISTS (
          SELECT 1
            FROM canonical_stock_movements csm
           WHERE csm.company_id=b.company_id
             AND csm.stock_item_id=ai.stock_item_id
             AND csm.location_id=a.location_id
             AND csm.source_type='stock_group_location_archive'
             AND csm.source_id=a.id::text
             AND csm.created_at <= b.source_cutoff
        )
    ),
    archive_in AS (
      SELECT
        'archive-in:'||ai.id::text,
        a.location_id,
        ai.stock_item_id,
        ABS(ai.quantity)::text,
        ai.average_rate::text,
        a.restored_at,
        ai.id*10+8,
        'legacy-stock-group-archive-restore',
        a.id::text
      FROM stock_group_location_archive_items ai
      JOIN stock_group_location_archives a ON a.id=ai.archive_id
      JOIN boundary b ON b.company_id=a.company_id
      WHERE a.restored_at IS NOT NULL
        AND a.restored_at <= b.source_cutoff
        AND NOT EXISTS (
          SELECT 1
            FROM canonical_stock_movements csm
           WHERE csm.company_id=b.company_id
             AND csm.stock_item_id=ai.stock_item_id
             AND csm.location_id=a.location_id
             AND csm.source_type='stock_group_location_archive_restore'
             AND csm.source_id=a.id::text
             AND csm.created_at <= b.source_cutoff
        )
    )
    SELECT u.*, oe.mutation_at
    FROM (
      SELECT * FROM offloads
      UNION ALL SELECT * FROM adjustments
      UNION ALL SELECT * FROM transfer_source
      UNION ALL SELECT * FROM transfer_destination
      UNION ALL SELECT * FROM notes
      UNION ALL SELECT * FROM archive_out
      UNION ALL SELECT * FROM archive_in
    ) u
    LEFT JOIN offload_entry oe
      ON u.source_type='legacy-container-offload'
     AND oe.offload_id::text=u.source_id
    ORDER BY u.occurred_at,u.sequence
    `,
    params
  );
  return rows.rows;
}
