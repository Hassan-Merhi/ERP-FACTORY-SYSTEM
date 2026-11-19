/** Sale proposals, canonical sale evidence and source-evidence hashing for the historical sales-cost repair. */
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";

import { type HistoricalSalesRepairMovement } from "./historicalSalesCostRepairEngine";
import {
  HISTORICAL_VALUATION_RESETS,
  HistoricalMergeRow,
  LegacyRow,
  OffloadValueEvidenceRow,
  RepairCheck,
  SaleRow,
  StockItemRow,
  ValuationCheckpoint,
  ValuationOverrideRow,
  iso,
} from "./historicalSalesCostRepairTypes";
import {
  loadCanonicalMovements,
  loadCanonicalStart,
  loadHistoricalMerges,
  loadLegacyManualAdjustments,
  loadLegacyMovements,
  loadOffloadValueEvidence,
  loadSales,
  loadStockItems,
  loadValuationCheckpoint,
  loadValuationOverrides,
} from "./historicalSalesCostRepairLoaders";
export {
  buildPriorCanonicalCostMemoryRateHints,
  canonicalMovementNumericId,
  compareMovementMutationAscending,
  compareMovementMutationDescending,
  movementKey,
  movementMutationTime,
  originalProposalForSale,
  proposalFromRecordedRate,
} from "./proposalFromRecordedRate";
export type { CanonicalSaleEvidence } from "./proposalFromRecordedRate";
export {
  activeCanonicalSaleEvidence,
  droppedPosLineMovements,
} from "./historicalSalesCostRepairEvidenceDroppedPosLineMovements";

export function historicalSalesCompanyEvidenceHash(input: {
  companyId: number;
  canonicalStart: Date | null;
  checkpoint: ValuationCheckpoint | null;
  canonical: HistoricalSalesRepairMovement[];
  legacy: LegacyRow[];
  manual: { movements: LegacyRow[]; checks: RepairCheck[] };
  sales: SaleRow[];
  stockItems: StockItemRow[];
  offloadEvidence: OffloadValueEvidenceRow[];
  historicalMerges: HistoricalMergeRow[];
  valuationOverrides: ValuationOverrideRow[];
}): string {
  const payload = {
    companyId: input.companyId,
    canonicalStart: input.canonicalStart ? input.canonicalStart.toISOString() : null,
    checkpoint: input.checkpoint
      ? {
          movementCutoffId: input.checkpoint.movementCutoffId,
          createdAt: input.checkpoint.createdAt.toISOString(),
          rows: input.checkpoint.rows.map((row) => ({
            locationId: Number(row.location_id),
            stockItemId: Number(row.stock_item_id),
            quantity: String(row.quantity),
            averageRate: String(row.average_rate),
            totalValue: String(row.total_value),
          })),
        }
      : null,
    canonical: input.canonical.map((movement) => ({
      movementId: movement.movementId,
      locationId: movement.locationId,
      stockItemId: movement.stockItemId,
      occurredAt: movement.occurredAt,
      createdAt: movement.createdAt ?? null,
      reversalOfMovementId: movement.reversalOfMovementId ?? null,
      sequence: movement.sequence,
      quantityDelta: movement.quantityDelta,
      unitCost: movement.unitCost,
      sourceType: movement.sourceType,
      sourceId: movement.sourceId,
      canonicalPosRole: movement.canonicalPosRole ?? null,
    })),
    legacy: input.legacy.map((row) => ({
      movementId: row.movement_id,
      locationId: Number(row.location_id),
      stockItemId: Number(row.stock_item_id),
      quantityDelta: String(row.quantity_delta),
      unitCost: row.unit_cost === null ? null : String(row.unit_cost),
      occurredAt: iso(row.occurred_at),
      mutationAt: row.mutation_at ? iso(row.mutation_at) : null,
      sequence: Number(row.sequence),
      sourceType: row.source_type,
      sourceId: row.source_id,
    })),
    manualMovements: input.manual.movements.map((row) => ({
      movementId: row.movement_id,
      locationId: Number(row.location_id),
      stockItemId: Number(row.stock_item_id),
      quantityDelta: String(row.quantity_delta),
      unitCost: row.unit_cost === null ? null : String(row.unit_cost),
      occurredAt: iso(row.occurred_at),
      sequence: Number(row.sequence),
      sourceType: row.source_type,
      sourceId: row.source_id,
    })),
    manualChecks: [...input.manual.checks].sort((a, b) =>
      [a.locationId ?? 0, a.stockItemId ?? 0, a.salesItemId ?? 0, a.code, a.detail ?? ""]
        .join(":")
        .localeCompare([b.locationId ?? 0, b.stockItemId ?? 0, b.salesItemId ?? 0, b.code, b.detail ?? ""].join(":"))
    ),
    sales: input.sales.map((sale) => ({
      salesItemId: Number(sale.sales_item_id),
      voucherId: Number(sale.voucher_id),
      locationId: sale.location_id === null ? null : Number(sale.location_id),
      stockItemId: Number(sale.stock_item_id),
      quantity: String(sale.quantity),
      totalSales: String(sale.total_sales),
      costPrice: String(sale.cost_price),
      totalCost: String(sale.total_cost),
      profit: String(sale.profit),
      createdAt: iso(sale.created_at),
    })),
    stockItems: input.stockItems.map((item) => ({
      id: Number(item.id),
      code: item.code,
      openingQty: String(item.opening_qty),
      openingRate: String(item.opening_rate),
      openingValue: String(item.opening_value),
      active: Boolean(item.active),
      deletedAt: item.deleted_at ? iso(item.deleted_at) : null,
      createdAt: iso(item.created_at),
    })),
    offloadEvidence: input.offloadEvidence.map((row) => ({
      offloadId: Number(row.offload_id),
      stockItemId: Number(row.stock_item_id),
      quantity: String(row.quantity),
      rate: String(row.rate),
      totalValue: String(row.total_value),
      offloadedAt: iso(row.offloaded_at),
    })),
    valuationResets: HISTORICAL_VALUATION_RESETS.filter((reset) => reset.companyId === input.companyId).map(
      (reset) => ({ ...reset })
    ),
    valuationOverrides: input.valuationOverrides.map((row) => ({
      id: Number(row.id),
      locationId: Number(row.location_id),
      stockItemId: Number(row.stock_item_id),
      sourceType: row.source_type,
      before: [row.before_quantity, row.before_average_rate, row.before_total_value].map(String),
      after: [row.after_quantity, row.after_average_rate, row.after_total_value].map(String),
      createdAt: iso(row.created_at),
    })),
    historicalMerges: input.historicalMerges.map((merge) => ({
      aliasId: Number(merge.alias_id),
      aliasCode: merge.alias_code,
      aliasCreatedAt: iso(merge.alias_created_at),
      sourceItemId: Number(merge.source_item_id),
      sourceCode: merge.source_code,
      sourceOpeningQty: String(merge.source_opening_qty),
      sourceOpeningRate: String(merge.source_opening_rate),
      sourceOpeningValue: String(merge.source_opening_value),
      sourceDeletedAt: merge.source_deleted_at ? iso(merge.source_deleted_at) : null,
      keptItemId: Number(merge.kept_item_id),
      keptCode: merge.kept_code,
      keptOpeningQty: String(merge.kept_opening_qty),
      keptOpeningRate: String(merge.kept_opening_rate),
      keptOpeningValue: String(merge.kept_opening_value),
      mergeAt: iso(merge.merge_at),
    })),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/**
 * A direct location inventory update journals its quantity change as a
 * location_inventory_update movement in the same transaction as its valuation
 * override. The override reset carries that quantity change together with the
 * exact valuation, so the journal row is replaced by it rather than applied
 * twice. Shared by the dry-run and the apply-time evidence hash.
 */
export function journalWithoutOverriddenLocationUpdates(
  loaded: HistoricalSalesRepairMovement[],
  valuationOverrides: ValuationOverrideRow[]
): HistoricalSalesRepairMovement[] {
  const overrideTransactionKeys = new Set(
    valuationOverrides.map((row) => `${Number(row.location_id)}:${Number(row.stock_item_id)}:${iso(row.created_at)}`)
  );
  return loaded.filter(
    (movement) =>
      !(
        movement.sourceType === "location_inventory_update" &&
        overrideTransactionKeys.has(
          `${movement.locationId}:${movement.stockItemId}:${movement.createdAt ?? movement.occurredAt}`
        )
      )
  );
}

export async function recomputeHistoricalSalesCompanyEvidenceHash(
  client: PoolClient,
  companyId: number,
  sourceCutoff: Date
): Promise<string> {
  const [canonicalStart, sales, stockItems, checkpoint, offloadEvidence, historicalMerges] = await Promise.all([
    loadCanonicalStart(client, companyId, sourceCutoff),
    loadSales(client, companyId, sourceCutoff),
    loadStockItems(client, companyId),
    loadValuationCheckpoint(client, companyId),
    loadOffloadValueEvidence(client, companyId, sourceCutoff),
    loadHistoricalMerges(client, companyId),
  ]);
  const [loadedCanonical, legacy, manual, valuationOverrides] = await Promise.all([
    loadCanonicalMovements(client, companyId, canonicalStart, sourceCutoff),
    loadLegacyMovements(client, companyId, canonicalStart, sourceCutoff),
    loadLegacyManualAdjustments(client, companyId, canonicalStart, sourceCutoff),
    loadValuationOverrides(client, companyId, sourceCutoff),
  ]);
  return historicalSalesCompanyEvidenceHash({
    companyId,
    canonicalStart,
    checkpoint,
    canonical: journalWithoutOverriddenLocationUpdates(loadedCanonical, valuationOverrides),
    legacy,
    manual,
    sales,
    stockItems,
    offloadEvidence,
    historicalMerges,
    valuationOverrides,
  });
}

export async function inventoryEvidenceFingerprint(
  client: PoolClient,
  companyIds: number[]
): Promise<{ hash: string; rowCount: number }> {
  const result = await client.query<{
    company_id: number;
    location_id: number;
    stock_item_id: number;
    quantity: string;
    average_rate: string;
    total_value: string;
  }>(
    `SELECT company_id,location_id,stock_item_id,
            quantity::text,average_rate::text,total_value::text
       FROM inventory
      WHERE company_id = ANY($1::int[])
      ORDER BY company_id,location_id,stock_item_id`,
    [companyIds]
  );
  const hash = createHash("sha256");
  for (const row of result.rows) {
    hash.update(
      `${row.company_id}|${row.location_id}|${row.stock_item_id}|${row.quantity}|${row.average_rate}|${row.total_value}\n`
    );
  }
  return { hash: hash.digest("hex"), rowCount: result.rows.length };
}

export async function assertSalesItemsUpdateHasNoSideEffectTriggers(client: PoolClient): Promise<void> {
  const triggers = await client.query<{ trigger_name: string }>(
    `SELECT tg.tgname AS trigger_name
       FROM pg_trigger tg
       JOIN pg_class c ON c.oid=tg.tgrelid
       JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public'
        AND c.relname='sales_items'
        AND NOT tg.tgisinternal
      ORDER BY tg.tgname`
  );
  if (triggers.rows.length > 0) {
    throw new Error(
      `Historical sales cost repair refused because sales_items has unreviewed side-effect trigger(s): ${triggers.rows
        .map((row) => row.trigger_name)
        .join(", ")}`
    );
  }
}
