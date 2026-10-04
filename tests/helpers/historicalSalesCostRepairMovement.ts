/** Builds a historical sales-cost repair movement with test defaults for every field not overridden. */
import type { HistoricalSalesRepairMovement } from "../../server/services/inventory/historicalSalesCostRepairEngine";

export function movement(
  overrides: Partial<HistoricalSalesRepairMovement> &
    Pick<HistoricalSalesRepairMovement, "movementId" | "quantityDelta">
): HistoricalSalesRepairMovement {
  return {
    movementId: overrides.movementId,
    companyId: 1,
    locationId: 10,
    stockItemId: 100,
    occurredAt: overrides.occurredAt ?? "2026-01-01T00:00:00.000Z",
    createdAt: overrides.createdAt,
    sequence: overrides.sequence ?? 1,
    quantityDelta: overrides.quantityDelta,
    unitCost: overrides.unitCost ?? null,
    exactValue: overrides.exactValue ?? null,
    sourceType: overrides.sourceType ?? "test",
    sourceId: overrides.sourceId ?? overrides.movementId,
    evidence: overrides.evidence ?? "legacy",
    canonicalPosRole: overrides.canonicalPosRole,
    valuationReset: overrides.valuationReset,
    sale: overrides.sale,
  };
}
