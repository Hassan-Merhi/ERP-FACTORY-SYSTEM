// Extracted from ./postOffloadImpactPreview.ts to keep that module under the source-size cap.
import Decimal from "decimal.js";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db, pool } from "../../db";
import {
  factoryContainerCommissions,
  factoryContainerOtherCharges,
  factoryContainers,
  factoryOffloadAdditionalCharges,
  factoryRawStock,
  factorySuppliers,
} from "@shared/schema";
import { previewHistoricalCostReplayWithExecutor, type ReplayQueryExecutor } from "./historicalCostReplay";
import { getAuthoritativeSupplierRemainingKg, getLockedSupplierRateReadOnly } from "./rawStockLockedRate";
import { InvalidPostOffloadImpactPreviewError, type PostOffloadImpactScope } from "./normalizePostOffloadImpactCharges";

export async function loadImpactScope(companyId: number, supplierId: number | null): Promise<PostOffloadImpactScope> {
  if (!supplierId) {
    return {
      supplierOwnedSources: 0,
      affectedSourceRows: 0,
      affectedBatches: 0,
      openBatches: 0,
      completedBatches: 0,
      availableBales: 0,
      finalizedBalesExcluded: 0,
    };
  }

  const result = await pool.query<{
    supplier_owned_sources: string;
    affected_source_rows: string;
    affected_batches: string;
    open_batches: string;
    completed_batches: string;
    available_bales: string;
    finalized_bales_excluded: string;
  }>(
    `WITH RECURSIVE affected_batches(batch_id) AS (
       SELECT DISTINCT mbs.mix_batch_id
       FROM factory_mix_batch_sources mbs
       JOIN factory_mix_batches mb ON mb.id = mbs.mix_batch_id
       WHERE mb.company_id = $1
         AND mb.deleted_at IS NULL
         AND mbs.inventory_supplier_id = $2
       UNION
       SELECT DISTINCT child.mix_batch_id
       FROM factory_mix_batch_sources child
       JOIN factory_mix_batches child_batch ON child_batch.id = child.mix_batch_id
       JOIN affected_batches parent ON child.source_batch_id = parent.batch_id
       WHERE child_batch.company_id = $1
         AND child_batch.deleted_at IS NULL
     ),
     bale_scope AS (
       SELECT
         fb.id,
         CASE
           WHEN fb.status IN ('SOLD','DISPATCHED','RESERVED_FOR_DISPATCH','RESERVED_FOR_ORDER','FINALIZED')
             OR fb.finalized_at IS NOT NULL
             OR EXISTS (
               SELECT 1
               FROM customer_order_bales cob
               JOIN customer_orders co ON co.id = cob.order_id
               WHERE cob.bale_id = fb.id
                 AND co.company_id = fb.company_id
                 AND co.deleted_at IS NULL
             )
             OR EXISTS (
               SELECT 1 FROM factory_invoice_loading_bales filb WHERE filb.bale_id = fb.id
             )
           THEN TRUE ELSE FALSE
         END AS finalized
       FROM factory_bales fb
       JOIN affected_batches ab ON ab.batch_id = fb.mix_batch_id
       WHERE fb.company_id = $1
         AND fb.status NOT IN ('DELETED','REMOVED')
     )
     SELECT
       (SELECT COUNT(*) FROM factory_mix_batch_sources mbs
         JOIN factory_mix_batches mb ON mb.id = mbs.mix_batch_id
        WHERE mb.company_id = $1 AND mb.deleted_at IS NULL AND mbs.inventory_supplier_id = $2)::text
         AS supplier_owned_sources,
       (SELECT COUNT(*) FROM factory_mix_batch_sources mbs
        WHERE mbs.mix_batch_id IN (SELECT batch_id FROM affected_batches))::text AS affected_source_rows,
       (SELECT COUNT(*) FROM affected_batches)::text AS affected_batches,
       (SELECT COUNT(*) FROM factory_mix_batches mb
        WHERE mb.id IN (SELECT batch_id FROM affected_batches)
          AND mb.status IN ('ACTIVE','OPEN','CARRY_FORWARD'))::text AS open_batches,
       (SELECT COUNT(*) FROM factory_mix_batches mb
        WHERE mb.id IN (SELECT batch_id FROM affected_batches)
          AND mb.status IN ('COMPLETED','CLOSED'))::text AS completed_batches,
       (SELECT COUNT(*) FROM bale_scope WHERE finalized = FALSE)::text AS available_bales,
       (SELECT COUNT(*) FROM bale_scope WHERE finalized = TRUE)::text AS finalized_bales_excluded`,
    [companyId, supplierId]
  );

  const row = result.rows[0];
  const count = (value: string | undefined) => Number.parseInt(value || "0", 10) || 0;
  return {
    supplierOwnedSources: count(row?.supplier_owned_sources),
    affectedSourceRows: count(row?.affected_source_rows),
    affectedBatches: count(row?.affected_batches),
    openBatches: count(row?.open_batches),
    completedBatches: count(row?.completed_batches),
    availableBales: count(row?.available_bales),
    finalizedBalesExcluded: count(row?.finalized_bales_excluded),
  };
}

export async function loadReplaySafety(
  companyId: number,
  supplierId: number | null
): Promise<{
  safe: boolean;
  reasons: string[];
}> {
  if (!supplierId) return { safe: true, reasons: [] };

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const preview = await previewHistoricalCostReplayWithExecutor(client as unknown as ReplayQueryExecutor, companyId);
    await client.query("COMMIT");

    const supplier = preview.supplierRows.find((row) => row.supplierId === supplierId);
    const reasons = new Set<string>(supplier?.reasons ?? []);
    if (preview.financialImpact?.allSafetyGatesPassed === false) {
      reasons.add("COMPANY_WIDE_HISTORICAL_REPLAY_SAFETY_GATE_FAILED");
    }
    return {
      safe: (supplier?.safeToRepair ?? true) && preview.financialImpact?.allSafetyGatesPassed !== false,
      reasons: [...reasons].sort(),
    };
  } catch (error) {
    await client.query("ROLLBACK");
    return {
      safe: false,
      reasons: [
        (error as { code?: string }).code ||
          (error instanceof Error ? error.message : "HISTORICAL_REPLAY_PREVIEW_FAILED"),
      ],
    };
  } finally {
    client.release();
  }
}

export async function loadPreviewState(companyId: number, containerId: number) {
  const [container] = await db
    .select()
    .from(factoryContainers)
    .where(
      and(
        eq(factoryContainers.id, containerId),
        eq(factoryContainers.companyId, companyId),
        isNull(factoryContainers.deletedAt)
      )
    );
  if (!container) {
    throw new InvalidPostOffloadImpactPreviewError("Container not found.");
  }
  if (!["OFFLOADED", "PARTIALLY_RECEIVED"].includes(container.status)) {
    throw new InvalidPostOffloadImpactPreviewError(
      "Post-offload impact preview is only available for received containers."
    );
  }

  const [activeCharges, commissions, otherCharges, rawStockRows, supplierRows] = await Promise.all([
    db
      .select()
      .from(factoryOffloadAdditionalCharges)
      .where(
        and(
          eq(factoryOffloadAdditionalCharges.companyId, companyId),
          eq(factoryOffloadAdditionalCharges.containerId, containerId),
          isNull(factoryOffloadAdditionalCharges.deletedAt)
        )
      ),
    db
      .select()
      .from(factoryContainerCommissions)
      .where(
        and(
          eq(factoryContainerCommissions.companyId, companyId),
          eq(factoryContainerCommissions.containerId, containerId)
        )
      )
      .orderBy(desc(factoryContainerCommissions.id)),
    db
      .select()
      .from(factoryContainerOtherCharges)
      .where(
        and(
          eq(factoryContainerOtherCharges.companyId, companyId),
          eq(factoryContainerOtherCharges.containerId, containerId)
        )
      ),
    db
      .select()
      .from(factoryRawStock)
      .where(and(eq(factoryRawStock.companyId, companyId), eq(factoryRawStock.containerId, containerId))),
    container.supplierId
      ? db
          .select({
            id: factorySuppliers.id,
            rate: factorySuppliers.currentRawMaterialCostPerKgUsd,
            updatedAt: factorySuppliers.updatedAt,
          })
          .from(factorySuppliers)
          .where(and(eq(factorySuppliers.companyId, companyId), eq(factorySuppliers.id, container.supplierId)))
      : Promise.resolve([]),
  ]);

  const commission = commissions[0] ?? null;
  const supplier = supplierRows[0] ?? null;
  const supplierRemainingKg = container.supplierId
    ? await getAuthoritativeSupplierRemainingKg(db, companyId, container.supplierId)
    : 0;
  const supplierLockedRate = container.supplierId
    ? (await getLockedSupplierRateReadOnly(db, companyId, container.supplierId)).rate
    : null;

  let receivedKg = new Decimal(0);
  let usedKg = new Decimal(0);
  for (const row of rawStockRows) {
    receivedKg = receivedKg.plus(String(row.receivedKg ?? "0"));
    usedKg = usedKg.plus(String(row.usedKg ?? "0"));
  }
  const remainingKg = Decimal.max(0, receivedKg.minus(usedKg));
  const remainingFraction = receivedKg.gt(0) ? Decimal.min(1, remainingKg.div(receivedKg)) : new Decimal(0);

  return {
    container,
    activeCharges,
    commission,
    otherCharges,
    rawStockRows,
    supplier,
    supplierRemainingKg,
    supplierLockedRate,
    receivedKg,
    remainingKg,
    remainingFraction,
  };
}
