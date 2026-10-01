import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import type { PoolClient } from "pg";

import { pool } from "../../db";
import { logger } from "../../lib/logger";
import { ensureHistoricalSalesCostRepairSchema } from "./ensureHistoricalSalesCostRepairSchema";
import {
  HISTORICAL_SALES_COST_REPAIR_ALGORITHM_VERSION,
  applyHistoricalForwardReplayMovement,
  applyHistoricalSalesRepairMovement,
  canonicalPosRoleFromIdempotencyKey,
  createHistoricalForwardReplayState,
  createHistoricalInventoryStateFromSnapshot,
  createHistoricalSignedLocationImportState,
  historicalInventoryKey,
  historicalRateWithinEvidencedRange,
  historicalSaleProposalFromState,
  repairMoney,
  repairQuantity,
  posJournalCostIsNotInventoryRate,
  repairRate,
  reverseHistoricalSalesRepairMovement,
  type HistoricalForwardReplayState,
  type HistoricalInventoryState,
  type HistoricalSalesRepairMovement,
  type HistoricalSalesRepairProposal,
} from "./historicalSalesCostRepairEngine";

type RepairCheck = {
  companyId: number;
  locationId: number | null;
  stockItemId: number | null;
  salesItemId?: number | null;
  code: string;
  status: "pass" | "block" | "warning";
  expected?: string | null;
  actual?: string | null;
  detail?: string | null;
};

type InventoryRow = {
  location_id: number;
  stock_item_id: number;
  quantity: string;
  average_rate: string;
  total_value: string;
};

type ValuationCheckpoint = {
  movementCutoffId: number;
  createdAt: Date;
  rows: InventoryRow[];
};

type StockItemRow = {
  id: number;
  code: string | null;
  opening_qty: string;
  opening_rate: string;
  opening_value: string;
  active: boolean;
  deleted_at: Date | null;
  created_at: Date;
};

type HistoricalMergeRow = {
  alias_id: number;
  alias_code: string;
  alias_created_at: Date;
  source_item_id: number;
  source_code: string;
  source_opening_qty: string;
  source_opening_rate: string;
  source_opening_value: string;
  source_deleted_at: Date | null;
  kept_item_id: number;
  kept_code: string;
  kept_opening_qty: string;
  kept_opening_rate: string;
  kept_opening_value: string;
  merge_at: Date;
};

type CanonicalRow = {
  id: number;
  location_id: number;
  stock_item_id: number;
  quantity_delta: string;
  unit_cost: string | null;
  source_type: string;
  source_id: string;
  occurred_at: Date;
  created_at: Date;
  reversal_of_movement_id: number | null;
  idempotency_key: string | null;
};

type SaleRow = {
  sales_item_id: number;
  voucher_id: number;
  location_id: number | null;
  stock_item_id: number;
  quantity: string;
  total_sales: string;
  cost_price: string;
  total_cost: string;
  profit: string;
  created_at: Date;
};

type LegacyRow = {
  movement_id: string;
  location_id: number;
  stock_item_id: number;
  quantity_delta: string;
  unit_cost: string | null;
  occurred_at: Date;
  sequence: number;
  source_type: string;
  source_id: string;
  mutation_at?: Date | null;
};

type OffloadValueEvidenceRow = {
  offload_id: number;
  stock_item_id: number;
  quantity: string;
  rate: string;
  total_value: string;
  offloaded_at: Date;
};

type AuditInventoryRow = {
  id: number;
  stock_item_id: number | null;
  location_name: string | null;
  old_quantity: string | null;
  new_quantity: string | null;
  created_at: Date;
};

type CompanyDryRun = {
  proposals: HistoricalSalesRepairProposal[];
  checks: RepairCheck[];
  report: Record<string, unknown>;
};

const QTY_TOLERANCE = new Decimal("0.001");
const MONEY_TOLERANCE = new Decimal("0.02");
const OFFLOAD_EVIDENCE_SOURCE_TYPES = new Set([
  "container-offload",
  "legacy-container-offload",
  "offload_optional_suspend",
  "offload_optional_restore",
  "container-reverse-offload",
  "container-reverse-offload-legacy",
]);

type HistoricalValuationResetEvidence = {
  companyId: number;
  locationId: number;
  stockItemId: number;
  occurredAt: string;
  sourceId: string;
  beforeQuantity: string;
  beforeAverageRate: string;
  beforeTotalValue: string;
  afterQuantity: string;
  afterAverageRate: string;
  afterTotalValue: string;
};

const HISTORICAL_VALUATION_RESETS: HistoricalValuationResetEvidence[] = [
  {
    companyId: 8,
    locationId: 122,
    stockItemId: 6374,
    // Inventory valuation Wave 6 was deployed after the 2026-09-11 12:43 sale
    // and before the next 2026-09-12 13:08 sale. The production regression
    // fixture captured the guarded pre-repair snapshot and exact target.
    occurredAt: "2026-09-11T19:58:31.453Z",
    sourceId: "wave6:SH.MIX3:company8:location122:item6374",
    beforeQuantity: "17.000",
    beforeAverageRate: "33.92",
    beforeTotalValue: "576.56",
    afterQuantity: "17.000",
    afterAverageRate: "66.65",
    afterTotalValue: "1133.05",
  },
];

function offloadEvidenceKey(offloadId: string | number, stockItemId: string | number): string {
  return `${String(offloadId)}:${Number(stockItemId)}`;
}

function hscrError(code: string): Error {
  const error = new Error();
  error.message = code;
  return error;
}

function d(value: Decimal.Value | null | undefined): Decimal {
  const parsed = new Decimal(value ?? 0);
  if (!parsed.isFinite()) throw hscrError(`HSCR_NON_FINITE_VALUE:${String(value)}`);
  return parsed;
}

function iso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw hscrError(`HSCR_INVALID_TIMESTAMP:${String(value)}`);
  return date.toISOString();
}

function beforeCutoff(value: Date, canonicalStart: Date | null): boolean {
  return canonicalStart === null || value.getTime() < canonicalStart.getTime();
}

async function enableMaintenanceScope(client: PoolClient): Promise<void> {
  await client.query("SELECT set_config('app.company_scope_maintenance', 'on', true)");
  await client.query("SELECT set_config('app.current_company_id', '', true)");
  await client.query("SELECT set_config('app.authorized_company_ids', '', true)");
}

async function companyIdsForRun(client: PoolClient, requested?: number[]): Promise<number[]> {
  if (requested?.length) {
    const unique = [...new Set(requested.map(Number).filter((value) => Number.isInteger(value) && value > 0))];
    const existing = await client.query<{ id: number }>(
      "SELECT id FROM companies WHERE id = ANY($1::int[]) ORDER BY id",
      [unique]
    );
    if (existing.rows.length !== unique.length) {
      throw hscrError("HSCR_REQUESTED_COMPANY_NOT_FOUND");
    }
    return existing.rows.map((row) => Number(row.id));
  }
  const all = await client.query<{ id: number }>("SELECT id FROM companies ORDER BY id");
  return all.rows.map((row) => Number(row.id));
}

async function loadCanonicalStart(client: PoolClient, companyId: number, sourceCutoff: Date): Promise<Date | null> {
  const result = await client.query<{ started_at: Date | null }>(
    `SELECT MIN(created_at) AS started_at
       FROM canonical_stock_movements
      WHERE company_id=$1 AND created_at <= $2`,
    [companyId, sourceCutoff]
  );
  return result.rows[0]?.started_at ?? null;
}

async function loadCanonicalMovements(
  client: PoolClient,
  companyId: number,
  canonicalStart: Date | null,
  sourceCutoff: Date
): Promise<HistoricalSalesRepairMovement[]> {
  if (!canonicalStart) return [];
  const rows = await client.query<CanonicalRow>(
    `SELECT id,location_id,stock_item_id,quantity_delta::text,unit_cost::text,
            source_type,source_id,occurred_at,created_at,reversal_of_movement_id,idempotency_key
       FROM canonical_stock_movements
      WHERE company_id=$1
        AND created_at >= $2
        AND created_at <= $3
      ORDER BY occurred_at,id`,
    [companyId, canonicalStart, sourceCutoff]
  );
  return rows.rows.map((row) => ({
    canonicalPosRole: canonicalPosRoleFromIdempotencyKey(row.source_type, row.idempotency_key),
    movementId: `canonical:${row.id}`,
    companyId,
    locationId: Number(row.location_id),
    stockItemId: Number(row.stock_item_id),
    occurredAt: iso(row.occurred_at),
    createdAt: iso(row.created_at),
    sequence: Number(row.id) * 10 + 5,
    quantityDelta: String(row.quantity_delta),
    unitCost: row.unit_cost === null ? null : String(row.unit_cost),
    sourceType: row.source_type,
    sourceId: row.source_id,
    evidence: "canonical" as const,
    reversalOfMovementId: row.reversal_of_movement_id === null ? null : Number(row.reversal_of_movement_id),
  }));
}

async function loadValuationCheckpoint(client: PoolClient, companyId: number): Promise<ValuationCheckpoint | null> {
  const cutover = await client.query<{ movement_cutoff_id: number; created_at: Date }>(
    `SELECT movement_cutoff_id,created_at
       FROM phase3_inventory_valuation_cutovers
      WHERE company_id=$1
      LIMIT 1`,
    [companyId]
  );
  const row = cutover.rows[0];
  if (!row) return null;

  const baseline = await client.query<InventoryRow>(
    `SELECT location_id,stock_item_id,quantity::text,average_rate::text,total_value::text
       FROM phase3_inventory_valuation_baselines
      WHERE company_id=$1
      ORDER BY location_id,stock_item_id`,
    [companyId]
  );
  return {
    movementCutoffId: Number(row.movement_cutoff_id),
    createdAt: row.created_at,
    rows: baseline.rows,
  };
}

async function loadOffloadValueEvidence(
  client: PoolClient,
  companyId: number,
  sourceCutoff: Date
): Promise<OffloadValueEvidenceRow[]> {
  const result = await client.query<OffloadValueEvidenceRow>(
    `SELECT co.id AS offload_id,coi.stock_item_id,
            coi.quantity::text,coi.rate::text,coi.total_value::text,
            co.offloaded_at
       FROM container_offload_items coi
       JOIN container_offloads co ON co.id=coi.offload_id
       JOIN containers c ON c.id=co.container_id
      WHERE c.company_id=$1
        AND co.offloaded_at <= $2
      ORDER BY co.id,coi.stock_item_id`,
    [companyId, sourceCutoff]
  );
  return result.rows;
}

async function loadHistoricalMerges(client: PoolClient, companyId: number): Promise<HistoricalMergeRow[]> {
  const result = await client.query<HistoricalMergeRow>(
    `SELECT
        a.id AS alias_id,
        a.alias_code,
        a.created_at AS alias_created_at,
        source.id AS source_item_id,
        source.code AS source_code,
        source.opening_qty::text AS source_opening_qty,
        source.opening_rate::text AS source_opening_rate,
        source.opening_value::text AS source_opening_value,
        source.deleted_at AS source_deleted_at,
        kept.id AS kept_item_id,
        kept.code AS kept_code,
        kept.opening_qty::text AS kept_opening_qty,
        kept.opening_rate::text AS kept_opening_rate,
        kept.opening_value::text AS kept_opening_value,
        COALESCE(source.deleted_at,a.created_at) AS merge_at
       FROM stock_item_code_aliases a
       JOIN stock_items kept
         ON kept.company_id=a.company_id
        AND kept.id=a.stock_item_id
       JOIN stock_items source
         ON source.company_id=a.company_id
        AND source.code=a.alias_code
        AND source.id<>a.stock_item_id
      WHERE a.company_id=$1
        AND a.description LIKE 'Merged from:%'
      ORDER BY COALESCE(source.deleted_at,a.created_at),a.id`,
    [companyId]
  );
  return result.rows;
}

function proposalFromRecordedRate(
  companyId: number,
  sale: SaleRow,
  proposedRate: Decimal.Value,
  sourceType: string,
  sourceId: string,
  evidence: "canonical" | "legacy"
): HistoricalSalesRepairProposal {
  if (!sale.location_id) throw hscrError("HSCR_SALE_LOCATION_REQUIRED_FOR_PROPOSAL");
  const originalCostPrice = repairRate(sale.cost_price);
  const originalTotalCost = repairMoney(sale.total_cost);
  const originalProfit = repairMoney(sale.profit);
  const proposedCostPrice = repairRate(proposedRate);
  const proposedTotalCost = repairMoney(repairQuantity(sale.quantity).abs().times(proposedCostPrice));
  const proposedProfit = repairMoney(d(sale.total_sales).minus(proposedTotalCost));
  return {
    salesItemId: Number(sale.sales_item_id),
    voucherId: Number(sale.voucher_id),
    companyId,
    locationId: Number(sale.location_id),
    stockItemId: Number(sale.stock_item_id),
    occurredAt: iso(sale.created_at),
    sourceType,
    sourceId,
    evidence,
    originalCostPrice: originalCostPrice.toFixed(2),
    originalTotalCost: originalTotalCost.toFixed(2),
    originalProfit: originalProfit.toFixed(2),
    proposedCostPrice: proposedCostPrice.toFixed(2),
    proposedTotalCost: proposedTotalCost.toFixed(2),
    proposedProfit: proposedProfit.toFixed(2),
    changed:
      !originalCostPrice.eq(proposedCostPrice) ||
      !originalTotalCost.eq(proposedTotalCost) ||
      !originalProfit.eq(proposedProfit),
  };
}

function originalProposalForSale(companyId: number, sale: SaleRow): HistoricalSalesRepairProposal {
  if (!sale.location_id) throw hscrError("HSCR_SALE_LOCATION_REQUIRED_FOR_PROPOSAL");
  const originalCostPrice = repairRate(sale.cost_price);
  const originalTotalCost = repairMoney(sale.total_cost);
  const originalProfit = repairMoney(sale.profit);
  return {
    salesItemId: Number(sale.sales_item_id),
    voucherId: Number(sale.voucher_id),
    companyId,
    locationId: Number(sale.location_id),
    stockItemId: Number(sale.stock_item_id),
    occurredAt: iso(sale.created_at),
    sourceType: "legacy-sale",
    sourceId: String(sale.voucher_id),
    evidence: "legacy",
    originalCostPrice: originalCostPrice.toFixed(2),
    originalTotalCost: originalTotalCost.toFixed(2),
    originalProfit: originalProfit.toFixed(2),
    proposedCostPrice: originalCostPrice.toFixed(2),
    proposedTotalCost: originalTotalCost.toFixed(2),
    proposedProfit: originalProfit.toFixed(2),
    changed: false,
  };
}

function movementKey(
  movement: Pick<HistoricalSalesRepairMovement, "companyId" | "locationId" | "stockItemId">
): string {
  return historicalInventoryKey(movement.companyId, movement.locationId, movement.stockItemId);
}

function compareLegacyMovementDescending(a: HistoricalSalesRepairMovement, b: HistoricalSalesRepairMovement): number {
  const time = Date.parse(b.occurredAt) - Date.parse(a.occurredAt);
  if (time !== 0) return time;
  if (a.sequence !== b.sequence) return b.sequence - a.sequence;
  return b.movementId.localeCompare(a.movementId);
}

function movementMutationTime(movement: HistoricalSalesRepairMovement): number {
  return Date.parse(movement.createdAt ?? movement.occurredAt);
}

function compareMovementMutationAscending(a: HistoricalSalesRepairMovement, b: HistoricalSalesRepairMovement): number {
  const time = movementMutationTime(a) - movementMutationTime(b);
  if (time !== 0) return time;
  if (a.sequence !== b.sequence) return a.sequence - b.sequence;
  return a.movementId.localeCompare(b.movementId);
}

function compareMovementMutationDescending(a: HistoricalSalesRepairMovement, b: HistoricalSalesRepairMovement): number {
  return -compareMovementMutationAscending(a, b);
}

function canonicalMovementNumericId(movement: HistoricalSalesRepairMovement): number | null {
  if (movement.movementId.startsWith("canonical-correction:")) {
    const id = Number(movement.movementId.split(":")[1]);
    return Number.isInteger(id) && id > 0 ? id : null;
  }
  if (!movement.movementId.startsWith("canonical:")) return null;
  const id = Number(movement.movementId.slice("canonical:".length));
  return Number.isInteger(id) && id > 0 ? id : null;
}

function buildPriorCanonicalCostMemoryRateHints(
  movements: HistoricalSalesRepairMovement[]
): Map<string, string> {
  const hints = new Map<string, string>();
  const knownRateByKey = new Map<string, Decimal>();

  for (const movement of [...movements].sort(compareMovementMutationAscending)) {
    const key = movementKey(movement);
    const knownRate = knownRateByKey.get(key);
    if (knownRate) hints.set(movement.movementId, knownRate.toFixed(2));

    const delta = d(movement.quantityDelta);
    // V31: POS edit legs journal the old sale-line cost, not the live rate
    // production used. They neither pin nor invalidate cost memory: the live
    // rate is preserved by an unchanged edit, so the prior hint stays valid.
    if (posJournalCostIsNotInventoryRate(movement)) continue;
    if (
      delta.lt(0) &&
      movement.evidence === "canonical" &&
      movement.unitCost !== null &&
      movement.unitCost !== undefined
    ) {
      knownRateByKey.set(key, repairRate(movement.unitCost));
      continue;
    }

    if (delta.gt(0) && movement.unitCost !== null && movement.unitCost !== undefined) {
      const incomingRate = repairRate(movement.unitCost);
      if (!knownRate || !incomingRate.eq(knownRate)) {
        knownRateByKey.delete(key);
      }
    }
  }

  return hints;
}

type CanonicalSaleEvidence = {
  movements: HistoricalSalesRepairMovement[];
  latestMutationAt: number;
  latestNegativeMovements: HistoricalSalesRepairMovement[];
  latestPositiveMovements: HistoricalSalesRepairMovement[];
  latestNegativeRates: Set<string>;
  latestNegativeQuantity: Decimal;
  latestNegativeValue: Decimal;
  latestNegativeRate: Decimal | null;
  latestPositiveRate: Decimal | null;
  totalSignedQuantity: Decimal;
  anchorCanonicalId: number;
};

function activeCanonicalSaleEvidence(
  movements: HistoricalSalesRepairMovement[]
): Map<string, CanonicalSaleEvidence> {
  const grouped = new Map<string, HistoricalSalesRepairMovement[]>();
  for (const movement of movements) {
    if (!CANONICAL_SALE_SOURCE_TYPES.has(movement.sourceType)) continue;
    const key = `${movement.sourceId}:${movement.locationId}:${movement.stockItemId}`;
    const rows = grouped.get(key) ?? [];
    rows.push(movement);
    grouped.set(key, rows);
  }

  const result = new Map<string, CanonicalSaleEvidence>();
  for (const [key, rows] of grouped) {
    const latestMutationAt = Math.max(...rows.map(movementMutationTime));
    const latestNegativeMovements = rows
      .filter(
        (movement) =>
          movementMutationTime(movement) === latestMutationAt &&
          d(movement.quantityDelta).lt(0)
      )
      .sort(compareMovementMutationAscending);
    const latestPositiveMovements = rows
      .filter(
        (movement) =>
          movementMutationTime(movement) === latestMutationAt &&
          d(movement.quantityDelta).gt(0)
      )
      .sort(compareMovementMutationAscending);
    const latestNegativeRates = new Set<string>();
    let latestNegativeQuantity = new Decimal(0);
    let latestNegativeValue = new Decimal(0);
    let hasMissingCost = false;
    for (const movement of latestNegativeMovements) {
      const quantity = d(movement.quantityDelta).abs();
      latestNegativeQuantity = repairQuantity(latestNegativeQuantity.plus(quantity));
      if (movement.unitCost === null || movement.unitCost === undefined) {
        hasMissingCost = true;
        continue;
      }
      latestNegativeRates.add(repairRate(movement.unitCost).toFixed(2));
      latestNegativeValue = latestNegativeValue.plus(quantity.times(d(movement.unitCost)));
    }
    const latestNegativeRate =
      !hasMissingCost && latestNegativeQuantity.gt(0)
        ? repairRate(latestNegativeValue.dividedBy(latestNegativeQuantity))
        : null;

    let latestPositiveQuantity = new Decimal(0);
    let latestPositiveValue = new Decimal(0);
    let hasMissingPositiveCost = false;
    for (const movement of latestPositiveMovements) {
      const quantity = d(movement.quantityDelta).abs();
      latestPositiveQuantity = repairQuantity(latestPositiveQuantity.plus(quantity));
      if (movement.unitCost === null || movement.unitCost === undefined) {
        hasMissingPositiveCost = true;
        continue;
      }
      latestPositiveValue = latestPositiveValue.plus(quantity.times(d(movement.unitCost)));
    }
    const latestPositiveRate =
      !hasMissingPositiveCost && latestPositiveQuantity.gt(0)
        ? repairRate(latestPositiveValue.dividedBy(latestPositiveQuantity))
        : null;
    const totalSignedQuantity = repairQuantity(
      rows.reduce((sum, movement) => sum.plus(d(movement.quantityDelta)), new Decimal(0))
    );
    const anchorCanonicalId = Math.max(
      ...rows.map((movement) => canonicalMovementNumericId(movement) ?? 0)
    );

    result.set(key, {
      movements: rows.sort(compareMovementMutationAscending),
      latestMutationAt,
      latestNegativeMovements,
      latestPositiveMovements,
      latestNegativeRates,
      latestNegativeQuantity,
      latestNegativeValue: repairMoney(latestNegativeValue),
      latestNegativeRate,
      latestPositiveRate,
      totalSignedQuantity,
      anchorCanonicalId,
    });
  }
  return result;
}


function historicalSalesCompanyEvidenceHash(input: {
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
        .localeCompare(
          [b.locationId ?? 0, b.stockItemId ?? 0, b.salesItemId ?? 0, b.code, b.detail ?? ""].join(":")
        )
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
    valuationResets: HISTORICAL_VALUATION_RESETS
      .filter((reset) => reset.companyId === input.companyId)
      .map((reset) => ({ ...reset })),
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

async function recomputeHistoricalSalesCompanyEvidenceHash(
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
  const [canonical, legacy, manual] = await Promise.all([
    loadCanonicalMovements(client, companyId, canonicalStart, sourceCutoff),
    loadLegacyMovements(client, companyId, canonicalStart, sourceCutoff),
    loadLegacyManualAdjustments(client, companyId, canonicalStart, sourceCutoff),
  ]);
  return historicalSalesCompanyEvidenceHash({
    companyId,
    canonicalStart,
    checkpoint,
    canonical,
    legacy,
    manual,
    sales,
    stockItems,
    offloadEvidence,
    historicalMerges,
  });
}

async function inventoryEvidenceFingerprint(
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

async function assertSalesItemsUpdateHasNoSideEffectTriggers(client: PoolClient): Promise<void> {
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

async function loadStockItems(client: PoolClient, companyId: number): Promise<StockItemRow[]> {
  const result = await client.query<StockItemRow>(
    `SELECT id,code,opening_qty::text,opening_rate::text,opening_value::text,
            active,deleted_at,created_at
       FROM stock_items
      WHERE company_id=$1
      ORDER BY id`,
    [companyId]
  );
  return result.rows;
}

async function loadSales(client: PoolClient, companyId: number, sourceCutoff: Date): Promise<SaleRow[]> {
  const rows = await client.query<SaleRow>(
    `SELECT si.id AS sales_item_id,si.voucher_id,v.location_id,si.stock_item_id,
            si.quantity::text,si.total_sales::text,si.cost_price::text,
            si.total_cost::text,si.profit::text,
            GREATEST(si.created_at,v.created_at) AS created_at
       FROM sales_items si
       JOIN vouchers v ON v.id=si.voucher_id
      WHERE v.company_id=$1
        AND v.voucher_type='Sales'
        AND v.deleted_at IS NULL
        AND COALESCE(v.optional,false)=false
        AND GREATEST(si.created_at,v.created_at) <= $2
      ORDER BY GREATEST(si.created_at,v.created_at),si.id`,
    [companyId, sourceCutoff]
  );
  return rows.rows;
}

async function loadLegacyMovements(
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

async function loadLegacyManualAdjustments(
  client: PoolClient,
  companyId: number,
  canonicalStart: Date | null,
  sourceCutoff: Date
): Promise<{ movements: LegacyRow[]; checks: RepairCheck[] }> {
  const rows = await client.query<AuditInventoryRow>(
    `SELECT id,record_id AS stock_item_id,
            changes->'location'->>'new' AS location_name,
            changes->'quantity'->>'old' AS old_quantity,
            changes->'quantity'->>'new' AS new_quantity,
            created_at
       FROM audit_log
      WHERE company_id=$1
        AND table_name='inventory'
        AND action='update'
        AND changes ? 'adjustmentType'
        AND changes ? 'quantity'
        AND created_at <= $2
      ORDER BY created_at,id`,
    [companyId, sourceCutoff]
  );

  const movements: LegacyRow[] = [];
  const checks: RepairCheck[] = [];
  const locationRows = await client.query<{ id: number; name: string }>(
    `SELECT id,name FROM locations WHERE company_id=$1 ORDER BY id`,
    [companyId]
  );
  const locationsByName = new Map<string, number[]>();
  for (const location of locationRows.rows) {
    const ids = locationsByName.get(location.name) ?? [];
    ids.push(Number(location.id));
    locationsByName.set(location.name, ids);
  }

  for (const row of rows.rows) {
    if (!row.stock_item_id || !row.location_name || row.old_quantity === null || row.new_quantity === null) {
      checks.push({
        companyId,
        locationId: null,
        stockItemId: row.stock_item_id ? Number(row.stock_item_id) : null,
        code: "LEGACY_MANUAL_ADJUSTMENT_UNRESOLVED",
        status: "block",
        detail: `Audit row ${row.id} is missing item/location/quantity evidence`,
      });
      continue;
    }

    const locationIds = locationsByName.get(row.location_name) ?? [];
    if (locationIds.length !== 1) {
      checks.push({
        companyId,
        locationId: null,
        stockItemId: Number(row.stock_item_id),
        code: "LEGACY_MANUAL_ADJUSTMENT_LOCATION_AMBIGUOUS",
        status: "block",
        actual: String(locationIds.length),
        detail: `Audit row ${row.id} location "${row.location_name}" did not resolve to exactly one location`,
      });
      continue;
    }

    const delta = d(row.new_quantity).minus(d(row.old_quantity));
    if (delta.isZero()) continue;
    movements.push({
      movement_id: `manual-audit:${row.id}`,
      location_id: locationIds[0],
      stock_item_id: Number(row.stock_item_id),
      quantity_delta: repairQuantity(delta).toFixed(3),
      unit_cost: null,
      occurred_at: row.created_at,
      sequence: Number(row.id) * 10 + 9,
      source_type: "legacy-manual-inventory-adjustment",
      source_id: String(row.id),
    });
  }
  return { movements, checks };
}

type RepairBlockerIndex = {
  saleSpecific: Map<number, RepairCheck>;
  itemWide: Map<string, RepairCheck>;
  locationSpecific: Map<string, RepairCheck>;
  legacyItemWide: Map<string, RepairCheck>;
  legacyLocationSpecific: Map<string, RepairCheck>;
};

function isLegacyProofBlock(code: string): boolean {
  return (
    code.startsWith("CHECKPOINT_") ||
    code.startsWith("LEGACY_") ||
    code.startsWith("MERGED_ITEM_") ||
    code === "VALUATION_CHECKPOINT_MISSING" ||
    code === "VALUATION_CHECKPOINT_KEY_MISSING" ||
    code === "SAME_TIMESTAMP_COST_ORDER_AMBIGUOUS" ||
    code === "CANONICAL_SALE_COST_EVIDENCE_MISMATCH"
  );
}

function buildRepairBlockerIndex(checks: RepairCheck[]): RepairBlockerIndex {
  const saleSpecific = new Map<number, RepairCheck>();
  const itemWide = new Map<string, RepairCheck>();
  const locationSpecific = new Map<string, RepairCheck>();
  const legacyItemWide = new Map<string, RepairCheck>();
  const legacyLocationSpecific = new Map<string, RepairCheck>();

  for (const check of checks) {
    if (check.status !== "block") continue;
    if (check.salesItemId) {
      if (!saleSpecific.has(check.salesItemId)) saleSpecific.set(check.salesItemId, check);
      continue;
    }
    if (check.stockItemId === null) continue;

    const legacyOnly = isLegacyProofBlock(check.code);
    if (check.locationId === null) {
      const key = `${check.companyId}:${check.stockItemId}`;
      const target = legacyOnly ? legacyItemWide : itemWide;
      if (!target.has(key)) target.set(key, check);
    } else {
      const key = `${check.companyId}:${check.locationId}:${check.stockItemId}`;
      const target = legacyOnly ? legacyLocationSpecific : locationSpecific;
      if (!target.has(key)) target.set(key, check);
    }
  }

  return {
    saleSpecific,
    itemWide,
    locationSpecific,
    legacyItemWide,
    legacyLocationSpecific,
  };
}

function blockerForProposal(
  blockers: RepairBlockerIndex,
  proposal: Pick<
    HistoricalSalesRepairProposal,
    "salesItemId" | "companyId" | "locationId" | "stockItemId" | "evidence"
  >
): RepairCheck | undefined {
  const saleSpecific = blockers.saleSpecific.get(proposal.salesItemId);
  if (saleSpecific) return saleSpecific;

  const locationKey = `${proposal.companyId}:${proposal.locationId}:${proposal.stockItemId}`;
  const itemKey = `${proposal.companyId}:${proposal.stockItemId}`;
  const general =
    blockers.locationSpecific.get(locationKey) ??
    blockers.itemWide.get(itemKey);
  if (general) return general;

  if (proposal.evidence === "legacy") {
    return (
      blockers.legacyLocationSpecific.get(locationKey) ??
      blockers.legacyItemWide.get(itemKey)
    );
  }
  return undefined;
}

function distinctBlockedItemLocations(checks: RepairCheck[]): number {
  const keys = new Set<string>();
  for (const check of checks) {
    if (check.status !== "block") continue;
    keys.add(
      `${check.companyId}:${check.locationId === null ? "*" : check.locationId}:${
        check.stockItemId === null ? "*" : check.stockItemId
      }`
    );
  }
  return keys.size;
}

const CANONICAL_SALE_SOURCE_TYPES = new Set(["pos-sale", "pos-import", "credit-sales-import"]);


function markAmbiguousTimestampTies(
  companyId: number,
  movements: HistoricalSalesRepairMovement[],
  sales: SaleRow[],
  canonicalStart: Date | null,
  canonicalSaleKeys: Set<string>
): RepairCheck[] {
  const checks: RepairCheck[] = [];
  const inboundByKeyTime = new Set<string>();
  for (const movement of movements) {
    if (movement.evidence !== "legacy") continue;
    if (d(movement.quantityDelta).lte(0) || movement.unitCost === null) continue;
    inboundByKeyTime.add(`${movement.locationId}:${movement.stockItemId}:${movement.occurredAt}`);
  }
  for (const sale of sales) {
    if (!sale.location_id || !beforeCutoff(sale.created_at, canonicalStart)) continue;
    if (canonicalSaleKeys.has(`${sale.voucher_id}:${sale.location_id}:${sale.stock_item_id}`)) continue;
    const key = `${sale.location_id}:${sale.stock_item_id}:${iso(sale.created_at)}`;
    if (inboundByKeyTime.has(key)) {
      checks.push({
        companyId,
        locationId: Number(sale.location_id),
        stockItemId: Number(sale.stock_item_id),
        code: "SAME_TIMESTAMP_COST_ORDER_AMBIGUOUS",
        status: "block",
        detail: `Sale item ${sale.sales_item_id} shares an exact legacy timestamp with a priced stock-in; ordering cannot be proven`,
      });
    }
  }
  return checks;
}

type MergedRecoveryResult = {
  recoveredKeys: Set<string>;
  proposals: HistoricalSalesRepairProposal[];
  checks: RepairCheck[];
};

function stateForZeroOpening(rate: Decimal.Value): HistoricalInventoryState {
  return createHistoricalInventoryStateFromSnapshot("0", repairRate(rate), "0");
}

function historicalInventoryStatesEqual(
  left: HistoricalInventoryState,
  right: HistoricalInventoryState
): boolean {
  return (
    repairQuantity(left.quantity).eq(repairQuantity(right.quantity)) &&
    repairRate(left.averageRate).eq(repairRate(right.averageRate)) &&
    repairMoney(left.totalValue).eq(repairMoney(right.totalValue))
  );
}

function stateQuantityValueMatches(
  actual: HistoricalInventoryState,
  expected: HistoricalInventoryState
): boolean {
  return (
    repairQuantity(actual.quantity).minus(repairQuantity(expected.quantity)).abs().lte(QTY_TOLERANCE) &&
    repairMoney(actual.totalValue).minus(repairMoney(expected.totalValue)).abs().lte(MONEY_TOLERANCE)
  );
}

function checkpointContainsMovement(
  movement: HistoricalSalesRepairMovement,
  checkpoint: ValuationCheckpoint
): boolean {
  const canonicalId = canonicalMovementNumericId(movement);
  if (canonicalId !== null) return canonicalId <= checkpoint.movementCutoffId;
  return movementMutationTime(movement) <= checkpoint.createdAt.getTime();
}

function replayMergedSourceLocationForward(input: {
  companyId: number;
  sourceItemId: number;
  locationId: number;
  opening: HistoricalInventoryState;
  movements: HistoricalSalesRepairMovement[];
  mergeAtMs: number;
}): { stateAtMerge: HistoricalInventoryState; proposals: HistoricalSalesRepairProposal[] } {
  let state = createHistoricalInventoryStateFromSnapshot(
    input.opening.quantity,
    input.opening.averageRate,
    input.opening.totalValue
  );
  const proposals: HistoricalSalesRepairProposal[] = [];
  const movements = input.movements
    .filter(
      (movement) =>
        movement.stockItemId === input.sourceItemId &&
        movement.locationId === input.locationId &&
        movementMutationTime(movement) < input.mergeAtMs
    )
    .sort(compareMovementMutationAscending);

  for (const movement of movements) {
    if (movement.sale) proposals.push(historicalSaleProposalFromState(movement, state));
    state = applyHistoricalSalesRepairMovement(state, movement);
  }
  return { stateAtMerge: state, proposals };
}

function recoverHistoricalMergedSales(input: {
  companyId: number;
  targetKeys: Set<string>;
  checkpoint: ValuationCheckpoint;
  checkpointStates: Map<string, HistoricalInventoryState>;
  historicalMerges: HistoricalMergeRow[];
  canonical: HistoricalSalesRepairMovement[];
  legacyMovements: HistoricalSalesRepairMovement[];
}): MergedRecoveryResult {
  const recoveredKeys = new Set<string>();
  const proposals: HistoricalSalesRepairProposal[] = [];
  const checks: RepairCheck[] = [];
  const allMovements = [...input.legacyMovements, ...input.canonical];
  const priorCostMemoryRateHints = buildPriorCanonicalCostMemoryRateHints(allMovements);
  const mergeBySource = new Map(input.historicalMerges.map((merge) => [Number(merge.source_item_id), merge]));
  const missingKeys = [...input.targetKeys].filter((key) => !input.checkpointStates.has(key));
  const sourceIds = [...new Set(missingKeys.map((key) => Number(key.split(":")[2])))];

  const blockSourceKeys = (sourceItemId: number, code: string, detail: string) => {
    const sourceKeys = missingKeys.filter((key) => Number(key.split(":")[2]) === sourceItemId);
    for (const key of sourceKeys) {
      const [, locationIdText] = key.split(":");
      checks.push({
        companyId: input.companyId,
        locationId: Number(locationIdText),
        stockItemId: sourceItemId,
        code,
        status: "block",
        detail,
      });
    }
  };

  for (const sourceItemId of sourceIds) {
    const merge = mergeBySource.get(sourceItemId);
    if (!merge) continue;

    const mergeAtMs = merge.merge_at.getTime();
    if (!Number.isFinite(mergeAtMs) || mergeAtMs > input.checkpoint.createdAt.getTime()) {
      blockSourceKeys(
        sourceItemId,
        "MERGED_ITEM_MERGE_TIMESTAMP_INVALID",
        `Historical merge timestamp is not before the valuation checkpoint (alias ${merge.alias_id})`
      );
      continue;
    }

    const sourceMovements = allMovements.filter((movement) => movement.stockItemId === sourceItemId);
    const postMergeSource = sourceMovements.filter((movement) => movementMutationTime(movement) >= mergeAtMs);
    if (postMergeSource.length > 0) {
      blockSourceKeys(
        sourceItemId,
        "MERGED_ITEM_SOURCE_MOVEMENT_AFTER_MERGE",
        `Historical source item has ${postMergeSource.length} inventory movement(s) at/after merge; identity transition is not clean`
      );
      continue;
    }

    const sourceOpeningQty = repairQuantity(merge.source_opening_qty);
    const sourceOpeningRate = repairRate(merge.source_opening_rate);
    const sourceOpeningValue = repairMoney(merge.source_opening_value);
    const sourceTargetKeys = missingKeys.filter((key) => Number(key.split(":")[2]) === sourceItemId);
    const sourceTargetLocations = sourceTargetKeys.map((key) => Number(key.split(":")[1]));

    if (sourceOpeningQty.isZero() && sourceOpeningValue.isZero()) {
      const locations = new Set<number>([
        ...sourceTargetLocations,
        ...sourceMovements.map((movement) => movement.locationId),
      ]);
      const sourceProposals: HistoricalSalesRepairProposal[] = [];
      for (const locationId of locations) {
        const replay = replayMergedSourceLocationForward({
          companyId: input.companyId,
          sourceItemId,
          locationId,
          opening: stateForZeroOpening(sourceOpeningRate),
          movements: allMovements,
          mergeAtMs,
        });
        sourceProposals.push(...replay.proposals);
      }

      const proposedSaleIds = new Set(sourceProposals.map((proposal) => proposal.salesItemId));
      const missingProposal = input.legacyMovements.find(
        (movement) =>
          movement.stockItemId === sourceItemId &&
          movement.sale &&
          sourceTargetLocations.includes(movement.locationId) &&
          !proposedSaleIds.has(movement.sale.salesItemId)
      );
      if (missingProposal) {
        blockSourceKeys(
          sourceItemId,
          "MERGED_ITEM_ZERO_OPENING_REPLAY_INCOMPLETE",
          `Could not replay sale item ${missingProposal.sale?.salesItemId ?? "unknown"} from exact zero opening`
        );
        continue;
      }

      proposals.push(...sourceProposals);
      for (const key of sourceTargetKeys) {
        recoveredKeys.add(key);
        const [, locationIdText] = key.split(":");
        checks.push({
          companyId: input.companyId,
          locationId: Number(locationIdText),
          stockItemId: sourceItemId,
          code: "MERGED_ITEM_ZERO_OPENING_REPLAY",
          status: "pass",
          expected: "0.000|0.00",
          actual: "0.000|0.00",
          detail: `Alias ${merge.alias_code} -> ${merge.kept_code}; merged at ${iso(merge.merge_at)}; source opening is exact zero`,
        });
      }
      continue;
    }

    const keptOpeningQty = repairQuantity(merge.kept_opening_qty);
    const keptOpeningValue = repairMoney(merge.kept_opening_value);
    if (!keptOpeningQty.isZero() || !keptOpeningValue.isZero()) {
      blockSourceKeys(
        sourceItemId,
        "MERGED_ITEM_SPLIT_UNPROVEN",
        `Source opening is nonzero and kept item ${merge.kept_item_id} also has a nonzero opening; merge split cannot be uniquely separated`
      );
      continue;
    }

    const keptItemId = Number(merge.kept_item_id);
    const keptMovements = allMovements.filter((movement) => movement.stockItemId === keptItemId);
    const sourcePreMovements = sourceMovements.filter((movement) => movementMutationTime(movement) < mergeAtMs);
    const keptPreMovements = keptMovements
      .filter((movement) => movementMutationTime(movement) < mergeAtMs)
      .sort(compareMovementMutationAscending);
    const keptPostMovements = keptMovements
      .filter(
        (movement) =>
          movementMutationTime(movement) > mergeAtMs && checkpointContainsMovement(movement, input.checkpoint)
      )
      .sort(compareMovementMutationDescending);

    const relevantLocations = new Set<number>([
      ...sourceTargetLocations,
      ...sourcePreMovements.map((movement) => movement.locationId),
      ...input.checkpoint.rows
        .filter((row) => Number(row.stock_item_id) === keptItemId)
        .map((row) => Number(row.location_id)),
    ]);

    const keptBeforeByLocation = new Map<number, HistoricalInventoryState>();
    for (const locationId of relevantLocations) {
      keptBeforeByLocation.set(locationId, stateForZeroOpening(merge.kept_opening_rate));
    }
    for (const movement of keptPreMovements) {
      if (!relevantLocations.has(movement.locationId)) continue;
      const current =
        keptBeforeByLocation.get(movement.locationId) ?? stateForZeroOpening(merge.kept_opening_rate);
      keptBeforeByLocation.set(
        movement.locationId,
        applyHistoricalSalesRepairMovement(current, movement)
      );
    }

    const combinedAtMergeByLocation = new Map<number, HistoricalInventoryState>();
    let keptRewindFailure: { locationId: number; detail: string } | null = null;
    for (const locationId of relevantLocations) {
      const checkpointKey = historicalInventoryKey(input.companyId, locationId, keptItemId);
      const checkpointState = input.checkpointStates.get(checkpointKey);
      if (!checkpointState) {
        keptRewindFailure = {
          locationId,
          detail: `Kept item ${keptItemId} has no checkpoint row at location ${locationId}`,
        };
        break;
      }
      combinedAtMergeByLocation.set(
        locationId,
        createHistoricalInventoryStateFromSnapshot(
          checkpointState.quantity,
          checkpointState.averageRate,
          checkpointState.totalValue
        )
      );
    }

    if (!keptRewindFailure) {
      for (const movement of keptPostMovements) {
        if (!relevantLocations.has(movement.locationId)) continue;
        const stateAfter = combinedAtMergeByLocation.get(movement.locationId);
        if (!stateAfter) continue;
        const reversed = reverseHistoricalSalesRepairMovement(stateAfter, movement, {
          priorCostMemoryRate: priorCostMemoryRateHints.get(movement.movementId) ?? null,
        });
        if (!reversed.reversible) {
          keptRewindFailure = {
            locationId: movement.locationId,
            detail: `Cannot rewind kept item movement ${movement.movementId}: ${reversed.reason}`,
          };
          break;
        }
        if (
          movement.evidence === "canonical" &&
          CANONICAL_SALE_SOURCE_TYPES.has(movement.sourceType) &&
          !posJournalCostIsNotInventoryRate(movement) &&
          d(movement.quantityDelta).lt(0) &&
          movement.unitCost !== null &&
          !repairRate(movement.unitCost).eq(repairRate(reversed.stateBefore.averageRate))
        ) {
          keptRewindFailure = {
            locationId: movement.locationId,
            detail: `Canonical kept-item sale ${movement.movementId} disagrees with checkpoint rewind`,
          };
          break;
        }
        combinedAtMergeByLocation.set(movement.locationId, reversed.stateBefore);
      }
    }

    if (keptRewindFailure) {
      blockSourceKeys(sourceItemId, "MERGED_ITEM_KEPT_REWIND_FAILED", keptRewindFailure.detail);
      continue;
    }

    const sourceAtMergeByLocation = new Map<number, HistoricalInventoryState>();
    let subtractionFailure: { locationId: number; detail: string } | null = null;
    for (const locationId of relevantLocations) {
      const combined = combinedAtMergeByLocation.get(locationId)!;
      const keptBefore = keptBeforeByLocation.get(locationId) ?? stateForZeroOpening(merge.kept_opening_rate);
      const sourceQty = repairQuantity(combined.quantity.minus(keptBefore.quantity));
      const sourceValue = repairMoney(combined.totalValue.minus(keptBefore.totalValue));
      if (sourceValue.lt(MONEY_TOLERANCE.negated())) {
        subtractionFailure = {
          locationId,
          detail: `Merge subtraction produced negative source value ${sourceValue.toFixed(2)}`,
        };
        break;
      }
      const normalizedValue = sourceValue.abs().lte(MONEY_TOLERANCE) ? new Decimal(0) : sourceValue;
      const sourceRate = sourceQty.gt(0)
        ? repairRate(normalizedValue.dividedBy(sourceQty))
        : sourceOpeningRate;
      const sourceState = createHistoricalInventoryStateFromSnapshot(
        sourceQty,
        sourceRate,
        normalizedValue
      );

      const combinedQty = repairQuantity(keptBefore.quantity.plus(sourceState.quantity));
      const combinedValue = repairMoney(keptBefore.totalValue.plus(sourceState.totalValue));
      const combinedRate = combinedQty.gt(0) ? repairRate(combinedValue.dividedBy(combinedQty)) : new Decimal(0);
      if (
        !combinedQty.eq(repairQuantity(combined.quantity)) ||
        !combinedValue.eq(repairMoney(combined.totalValue)) ||
        !combinedRate.eq(repairRate(combined.averageRate))
      ) {
        subtractionFailure = {
          locationId,
          detail: "Source/kept split does not replay the exact post-merge checkpoint-rewound state",
        };
        break;
      }
      sourceAtMergeByLocation.set(locationId, sourceState);
    }

    if (subtractionFailure) {
      blockSourceKeys(sourceItemId, "MERGED_ITEM_VALUE_SPLIT_FAILED", subtractionFailure.detail);
      continue;
    }

    const tempProposals: HistoricalSalesRepairProposal[] = [];
    const openingByLocation = new Map<number, HistoricalInventoryState>();
    const unresolvedLocations: number[] = [];
    let sourceRewindFailure: { locationId: number; detail: string } | null = null;

    for (const locationId of relevantLocations) {
      const sourceAtMerge = sourceAtMergeByLocation.get(locationId)!;
      const movements = sourcePreMovements
        .filter((movement) => movement.locationId === locationId)
        .sort(compareMovementMutationDescending);

      if (sourceAtMerge.quantity.lte(0)) {
        unresolvedLocations.push(locationId);
        continue;
      }

      let stateAfter = sourceAtMerge;
      const locationProposals: HistoricalSalesRepairProposal[] = [];
      for (const movement of movements) {
        const reversed = reverseHistoricalSalesRepairMovement(stateAfter, movement, {
          priorCostMemoryRate: priorCostMemoryRateHints.get(movement.movementId) ?? null,
        });
        if (!reversed.reversible) {
          sourceRewindFailure = {
            locationId,
            detail: `Cannot rewind source movement ${movement.movementId}: ${reversed.reason}`,
          };
          break;
        }
        if (movement.sale) {
          locationProposals.push(historicalSaleProposalFromState(movement, reversed.stateBefore));
        }
        stateAfter = reversed.stateBefore;
      }
      if (sourceRewindFailure) break;
      openingByLocation.set(locationId, stateAfter);
      tempProposals.push(...locationProposals);
    }

    if (sourceRewindFailure) {
      blockSourceKeys(sourceItemId, "MERGED_ITEM_SOURCE_REWIND_FAILED", sourceRewindFailure.detail);
      continue;
    }

    let recoveredOpeningQty = new Decimal(0);
    let recoveredOpeningValue = new Decimal(0);
    for (const opening of openingByLocation.values()) {
      recoveredOpeningQty = repairQuantity(recoveredOpeningQty.plus(opening.quantity));
      recoveredOpeningValue = repairMoney(recoveredOpeningValue.plus(opening.totalValue));
    }
    const remainingOpeningQty = repairQuantity(sourceOpeningQty.minus(recoveredOpeningQty));
    const remainingOpeningValue = repairMoney(sourceOpeningValue.minus(recoveredOpeningValue));

    if (
      remainingOpeningQty.lt(QTY_TOLERANCE.negated()) ||
      remainingOpeningValue.lt(MONEY_TOLERANCE.negated())
    ) {
      blockSourceKeys(
        sourceItemId,
        "MERGED_ITEM_OPENING_RECONCILIATION_FAILED",
        `Rewind exceeded source opening: remaining ${remainingOpeningQty.toFixed(3)} / ${remainingOpeningValue.toFixed(2)}`
      );
      continue;
    }

    const unresolvedWithActivity = unresolvedLocations.filter(
      (locationId) =>
        sourcePreMovements.some((movement) => movement.locationId === locationId) ||
        sourceTargetLocations.includes(locationId)
    );
    if (
      (!remainingOpeningQty.isZero() || !remainingOpeningValue.isZero()) &&
      unresolvedWithActivity.length !== 1
    ) {
      blockSourceKeys(
        sourceItemId,
        "MERGED_ITEM_OPENING_LOCATION_AMBIGUOUS",
        `Remaining source opening ${remainingOpeningQty.toFixed(3)} / ${remainingOpeningValue.toFixed(
          2
        )} cannot be assigned uniquely across ${unresolvedWithActivity.length} unresolved locations`
      );
      continue;
    }

    let forwardFailure: { locationId: number; detail: string } | null = null;
    for (const locationId of unresolvedWithActivity) {
      const getsRemainder =
        unresolvedWithActivity.length === 1 &&
        (!remainingOpeningQty.isZero() || !remainingOpeningValue.isZero());
      const opening = getsRemainder
        ? createHistoricalInventoryStateFromSnapshot(
            remainingOpeningQty,
            sourceOpeningRate,
            remainingOpeningValue
          )
        : stateForZeroOpening(sourceOpeningRate);
      const replay = replayMergedSourceLocationForward({
        companyId: input.companyId,
        sourceItemId,
        locationId,
        opening,
        movements: allMovements,
        mergeAtMs,
      });
      const expectedAtMerge = sourceAtMergeByLocation.get(locationId)!;
      if (!stateQuantityValueMatches(replay.stateAtMerge, expectedAtMerge)) {
        forwardFailure = {
          locationId,
          detail: `Forward replay reaches ${replay.stateAtMerge.quantity.toFixed(3)} / ${replay.stateAtMerge.totalValue.toFixed(
            2
          )}, expected merge contribution ${expectedAtMerge.quantity.toFixed(3)} / ${expectedAtMerge.totalValue.toFixed(2)}`,
        };
        break;
      }
      openingByLocation.set(locationId, opening);
      tempProposals.push(...replay.proposals);
    }

    if (forwardFailure) {
      blockSourceKeys(sourceItemId, "MERGED_ITEM_FORWARD_PROOF_FAILED", forwardFailure.detail);
      continue;
    }

    let finalOpeningQty = new Decimal(0);
    let finalOpeningValue = new Decimal(0);
    let openingRateMismatch = false;
    for (const opening of openingByLocation.values()) {
      finalOpeningQty = repairQuantity(finalOpeningQty.plus(opening.quantity));
      finalOpeningValue = repairMoney(finalOpeningValue.plus(opening.totalValue));
      if (opening.quantity.gt(0) && !repairRate(opening.averageRate).eq(sourceOpeningRate)) {
        openingRateMismatch = true;
      }
    }
    if (
      finalOpeningQty.minus(sourceOpeningQty).abs().gt(QTY_TOLERANCE) ||
      finalOpeningValue.minus(sourceOpeningValue).abs().gt(MONEY_TOLERANCE) ||
      openingRateMismatch
    ) {
      blockSourceKeys(
        sourceItemId,
        "MERGED_ITEM_OPENING_RECONCILIATION_FAILED",
        `Recovered opening ${finalOpeningQty.toFixed(3)} @ ${sourceOpeningRate.toFixed(
          2
        )} / ${finalOpeningValue.toFixed(2)} does not reproduce stock master ${sourceOpeningQty.toFixed(
          3
        )} / ${sourceOpeningValue.toFixed(2)}`
      );
      continue;
    }

    const targetSaleIds = new Set(
      input.legacyMovements
        .filter(
          (movement) =>
            movement.stockItemId === sourceItemId &&
            movement.sale &&
            sourceTargetLocations.includes(movement.locationId)
        )
        .map((movement) => movement.sale!.salesItemId)
    );
    const recoveredSaleIds = new Set(tempProposals.map((proposal) => proposal.salesItemId));
    if ([...targetSaleIds].some((saleId) => !recoveredSaleIds.has(saleId))) {
      blockSourceKeys(
        sourceItemId,
        "MERGED_ITEM_SALE_PROPOSAL_INCOMPLETE",
        "At least one historical sale did not receive a proposal from the proven merge rewind"
      );
      continue;
    }

    proposals.push(...tempProposals);
    for (const key of sourceTargetKeys) {
      recoveredKeys.add(key);
      const [, locationIdText] = key.split(":");
      checks.push({
        companyId: input.companyId,
        locationId: Number(locationIdText),
        stockItemId: sourceItemId,
        code: "MERGED_ITEM_IDENTITY_RECONCILED",
        status: "pass",
        expected: `${sourceOpeningQty.toFixed(3)}|${sourceOpeningValue.toFixed(2)}`,
        actual: `${finalOpeningQty.toFixed(3)}|${finalOpeningValue.toFixed(2)}`,
        detail: `Alias ${merge.alias_code} -> ${merge.kept_code}; merge ${iso(
          merge.merge_at
        )}; kept checkpoint rewound and exact source opening recovered`,
      });
    }
  }

  return { recoveredKeys, proposals, checks };
}

/**
 * Every rate an item could have carried, from evidence already pinned in the
 * V2 source hash: pinned openings, priced receipts (canonical and legacy),
 * exact offload values, recorded live sale-issue rates, the checkpoint, and
 * the rates of historically merged source items.
 */
function evidencedRateHullByItem(input: {
  stockItems: StockItemRow[];
  canonical: HistoricalSalesRepairMovement[];
  legacy: LegacyRow[];
  offloadEvidence: OffloadValueEvidenceRow[];
  checkpoint: ValuationCheckpoint | null;
  historicalMerges: HistoricalMergeRow[];
}): Map<number, { low: Decimal; high: Decimal }> {
  const hull = new Map<number, { low: Decimal; high: Decimal }>();
  const add = (stockItemId: number, value: Decimal.Value | null | undefined) => {
    if (value === null || value === undefined) return;
    const rate = new Decimal(value);
    if (!rate.isFinite() || !rate.gt(0)) return;
    const current = hull.get(stockItemId);
    if (!current) {
      hull.set(stockItemId, { low: rate, high: rate });
      return;
    }
    if (rate.lt(current.low)) current.low = rate;
    if (rate.gt(current.high)) current.high = rate;
  };

  for (const item of input.stockItems) add(Number(item.id), item.opening_rate);
  for (const movement of input.canonical) {
    const delta = d(movement.quantityDelta);
    if (delta.gt(0) || movement.canonicalPosRole === "sale-issue") {
      add(movement.stockItemId, movement.unitCost);
    }
  }
  for (const row of input.legacy) {
    if (d(row.quantity_delta).gt(0)) add(Number(row.stock_item_id), row.unit_cost);
  }
  for (const row of input.offloadEvidence) {
    add(Number(row.stock_item_id), row.rate);
    const quantity = d(row.quantity);
    if (quantity.gt(0)) add(Number(row.stock_item_id), d(row.total_value).dividedBy(quantity));
  }
  for (const row of input.checkpoint?.rows ?? []) {
    if (d(row.quantity).gt(0)) add(Number(row.stock_item_id), row.average_rate);
  }
  for (const merge of input.historicalMerges) {
    const source = hull.get(Number(merge.source_item_id));
    if (source) {
      add(Number(merge.kept_item_id), source.low);
      add(Number(merge.kept_item_id), source.high);
    }
    add(Number(merge.kept_item_id), merge.source_opening_rate);
  }
  return hull;
}

function rateHullBlocks(input: {
  companyId: number;
  proposals: HistoricalSalesRepairProposal[];
  stockItems: StockItemRow[];
  canonical: HistoricalSalesRepairMovement[];
  legacy: LegacyRow[];
  offloadEvidence: OffloadValueEvidenceRow[];
  checkpoint: ValuationCheckpoint | null;
  historicalMerges: HistoricalMergeRow[];
}): RepairCheck[] {
  const hull = evidencedRateHullByItem(input);
  const worstByKey = new Map<string, { proposal: HistoricalSalesRepairProposal; count: number }>();
  for (const proposal of input.proposals) {
    if (proposal.evidence !== "legacy") continue;
    const rate = repairRate(proposal.proposedCostPrice);
    if (historicalRateWithinEvidencedRange(rate, hull.get(proposal.stockItemId))) continue;
    const key = `${proposal.locationId}:${proposal.stockItemId}`;
    const current = worstByKey.get(key);
    worstByKey.set(key, {
      proposal: current && d(current.proposal.proposedCostPrice).gt(rate) ? current.proposal : proposal,
      count: (current?.count ?? 0) + 1,
    });
  }

  return [...worstByKey.values()].map(({ proposal, count }) => {
    const range = hull.get(proposal.stockItemId);
    return {
      companyId: input.companyId,
      locationId: proposal.locationId,
      stockItemId: proposal.stockItemId,
      code: "LEGACY_PROPOSED_COST_OUTSIDE_RATE_HULL",
      status: "block" as const,
      expected: range ? `${repairRate(range.low).toFixed(2)}..${repairRate(range.high).toFixed(2)}` : "no rate evidence",
      actual: repairRate(proposal.proposedCostPrice).toFixed(2),
      detail: `${count} reconstructed sale cost(s) fall outside every rate this item ever carried (worst: sales item ${proposal.salesItemId}); the reconstruction chain for this item/location is unproven`,
    };
  });
}

async function dryRunCompany(client: PoolClient, companyId: number, sourceCutoff: Date): Promise<CompanyDryRun> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`historical-sales-cost-repair:${companyId}`]);

  const [inventoryResult, stockItems, canonicalStart, sales, checkpoint, offloadEvidence, historicalMerges] = await Promise.all([
    client.query<InventoryRow>(
      `SELECT i.location_id,i.stock_item_id,i.quantity::text,i.average_rate::text,i.total_value::text
         FROM inventory i
         JOIN locations l
           ON l.id=i.location_id
          AND l.company_id=i.company_id
          AND l.deleted_at IS NULL
        WHERE i.company_id=$1
        ORDER BY i.location_id,i.stock_item_id`,
      [companyId]
    ),
    loadStockItems(client, companyId),
    loadCanonicalStart(client, companyId, sourceCutoff),
    loadSales(client, companyId, sourceCutoff),
    loadValuationCheckpoint(client, companyId),
    loadOffloadValueEvidence(client, companyId, sourceCutoff),
    loadHistoricalMerges(client, companyId),
  ]);

  const [canonical, legacy, manual] = await Promise.all([
    loadCanonicalMovements(client, companyId, canonicalStart, sourceCutoff),
    loadLegacyMovements(client, companyId, canonicalStart, sourceCutoff),
    loadLegacyManualAdjustments(client, companyId, canonicalStart, sourceCutoff),
  ]);

  const sourceEvidenceHash = historicalSalesCompanyEvidenceHash({
    companyId,
    canonicalStart,
    checkpoint,
    canonical,
    legacy,
    manual,
    sales,
    stockItems,
    offloadEvidence,
    historicalMerges,
  });
  const offloadEvidenceByKey = new Map(
    offloadEvidence.map((row) => [
      offloadEvidenceKey(row.offload_id, row.stock_item_id),
      row,
    ])
  );
  for (const movement of canonical) {
    if (!OFFLOAD_EVIDENCE_SOURCE_TYPES.has(movement.sourceType)) continue;
    const evidence = offloadEvidenceByKey.get(
      offloadEvidenceKey(movement.sourceId, movement.stockItemId)
    );
    if (evidence) movement.exactValue = String(evidence.total_value);
  }

  const checks: RepairCheck[] = [
    ...manual.checks,
    {
      companyId,
      locationId: null,
      stockItemId: null,
      code: "V2_SOURCE_EVIDENCE_HASH",
      status: "pass",
      expected: sourceEvidenceHash,
      actual: sourceEvidenceHash,
      detail:
        "Pins Phase 3 checkpoint rows/cutoff, canonical and legacy movements, historical merge aliases, source openings, and target sale originals",
    },
  ];
  const pinnedOffloadRows = legacy.filter(
    (row) => row.source_type === "legacy-container-offload" && row.mutation_at
  );
  checks.push({
    companyId,
    locationId: null,
    stockItemId: null,
    code: "LEGACY_OFFLOAD_ENTRY_TIME_PINNED",
    status: "pass",
    expected: String(legacy.filter((row) => row.source_type === "legacy-container-offload").length),
    actual: String(pinnedOffloadRows.length),
    detail:
      "Legacy offload item rows ordered at their charge-voucher transaction time (unique container offload, single voucher group, millisecond stamp agrees with created_at); the rest keep offloaded_at",
  });
  for (const reset of HISTORICAL_VALUATION_RESETS.filter(
    (candidate) => candidate.companyId === companyId
  )) {
    checks.push({
      companyId,
      locationId: reset.locationId,
      stockItemId: reset.stockItemId,
      code: "WAVE6_VALUATION_RESET_EVIDENCE",
      status: "pass",
      expected:
        reset.afterQuantity +
        "|" +
        reset.afterAverageRate +
        "|" +
        reset.afterTotalValue,
      actual:
        reset.beforeQuantity +
        "|" +
        reset.beforeAverageRate +
        "|" +
        reset.beforeTotalValue,
      detail:
        "Exact guarded Wave 6 production valuation reset is included as an immutable replay boundary and source-hash input.",
    });
  }

  const canonicalSaleEvidence = activeCanonicalSaleEvidence(canonical);
  const canonicalSaleKeys = new Set(canonicalSaleEvidence.keys());
  const toLegacyMovement = (row: LegacyRow): HistoricalSalesRepairMovement => ({
    movementId: row.movement_id,
    companyId,
    locationId: Number(row.location_id),
    stockItemId: Number(row.stock_item_id),
    occurredAt: iso(row.occurred_at),
    ...(row.mutation_at ? { createdAt: iso(row.mutation_at) } : {}),
    sequence: Number(row.sequence),
    quantityDelta: String(row.quantity_delta),
    unitCost: row.unit_cost === null ? null : String(row.unit_cost),
    exactValue: OFFLOAD_EVIDENCE_SOURCE_TYPES.has(row.source_type)
      ? offloadEvidenceByKey.get(offloadEvidenceKey(row.source_id, row.stock_item_id))?.total_value ?? null
      : null,
    sourceType: row.source_type,
    sourceId: row.source_id,
    evidence: "legacy" as const,
  });
  const legacyTransferFallbackMovements = legacy
    .filter((row) => row.source_type.endsWith("-flag-fallback"))
    .map(toLegacyMovement);
  const valuationResetMovements: HistoricalSalesRepairMovement[] =
    HISTORICAL_VALUATION_RESETS
      .filter((reset) => reset.companyId === companyId)
      .map((reset, index) => ({
        movementId: `valuation-reset:${reset.sourceId}`,
        companyId: reset.companyId,
        locationId: reset.locationId,
        stockItemId: reset.stockItemId,
        occurredAt: reset.occurredAt,
        createdAt: reset.occurredAt,
        sequence: 900_000_000 + index,
        quantityDelta: "0.000",
        unitCost: null,
        valuationReset: {
          beforeQuantity: reset.beforeQuantity,
          beforeAverageRate: reset.beforeAverageRate,
          beforeTotalValue: reset.beforeTotalValue,
          afterQuantity: reset.afterQuantity,
          afterAverageRate: reset.afterAverageRate,
          afterTotalValue: reset.afterTotalValue,
        },
        sourceType: "inventory-valuation-wave6-reset",
        sourceId: reset.sourceId,
        evidence: "legacy" as const,
      }));

  const legacyMovements: HistoricalSalesRepairMovement[] = [
    ...legacy
      .filter((row) => !row.source_type.endsWith("-flag-fallback"))
      .map(toLegacyMovement),
    ...valuationResetMovements,
    ...manual.movements.map((row) => ({
      movementId: row.movement_id,
      companyId,
      locationId: Number(row.location_id),
      stockItemId: Number(row.stock_item_id),
      occurredAt: iso(row.occurred_at),
      sequence: Number(row.sequence),
      quantityDelta: String(row.quantity_delta),
      unitCost: row.unit_cost === null ? null : String(row.unit_cost),
      sourceType: row.source_type,
      sourceId: row.source_id,
      evidence: "legacy" as const,
    })),
  ];

  const directCanonicalProposals = new Map<number, HistoricalSalesRepairProposal>();
  const saleQuantityByEvidenceKey = new Map<string, Decimal>();
  for (const sale of sales) {
    if (!sale.location_id) continue;
    const key = `${sale.voucher_id}:${sale.location_id}:${sale.stock_item_id}`;
    saleQuantityByEvidenceKey.set(
      key,
      repairQuantity((saleQuantityByEvidenceKey.get(key) ?? new Decimal(0)).plus(d(sale.quantity).abs()))
    );
  }

  const canonicalSaleLifecycleCorrections: HistoricalSalesRepairMovement[] = [];

  for (const [key, evidence] of canonicalSaleEvidence) {
    const [voucherIdText, locationIdText, stockItemIdText] = key.split(":");
    const expectedQuantity = saleQuantityByEvidenceKey.get(key);
    if (!expectedQuantity) continue;
    if (evidence.latestNegativeRate === null) {
      checks.push({
        companyId,
        locationId: Number(locationIdText),
        stockItemId: Number(stockItemIdText),
        code: "CANONICAL_SALE_RATE_MISSING",
        status: "block",
        detail: `Voucher ${voucherIdText} latest canonical sale mutation has no priced outbound issue`,
      });
      continue;
    }
    if (!evidence.latestNegativeQuantity.eq(expectedQuantity)) {
      checks.push({
        companyId,
        locationId: Number(locationIdText),
        stockItemId: Number(stockItemIdText),
        code: "CANONICAL_SALE_QUANTITY_DRIFT",
        status: "warning",
        expected: expectedQuantity.toFixed(3),
        actual: evidence.latestNegativeQuantity.toFixed(3),
        detail: `Voucher ${voucherIdText} quantity differs from its latest canonical issue batch; the exact transaction-time cost rate is still pinned by the matching latest mutation timestamp`,
      });
    }
    if (evidence.latestNegativeRates.size > 1) {
      checks.push({
        companyId,
        locationId: Number(locationIdText),
        stockItemId: Number(stockItemIdText),
        code: "CANONICAL_SALE_MULTI_RATE_RECONCILED",
        status: "warning",
        expected: evidence.latestNegativeRate.toFixed(2),
        actual: [...evidence.latestNegativeRates].sort().join(","),
        detail: `Voucher ${voucherIdText} latest canonical issue batch contains multiple recorded rates; using its quantity-weighted recorded cost`,
      });
    }

    const desiredSignedQuantity = repairQuantity(expectedQuantity.negated());
    const correctionDelta = repairQuantity(desiredSignedQuantity.minus(evidence.totalSignedQuantity));
    if (!correctionDelta.isZero()) {
      const correctionRate =
        correctionDelta.lt(0)
          ? evidence.latestNegativeRate
          : evidence.latestPositiveRate ?? evidence.latestNegativeRate;
      const anchorMovement =
        evidence.latestNegativeMovements[evidence.latestNegativeMovements.length - 1] ??
        evidence.latestPositiveMovements[evidence.latestPositiveMovements.length - 1] ??
        evidence.movements[evidence.movements.length - 1];

      if (!correctionRate || evidence.anchorCanonicalId <= 0 || !anchorMovement) {
        checks.push({
          companyId,
          locationId: Number(locationIdText),
          stockItemId: Number(stockItemIdText),
          code: "CANONICAL_SALE_LIFECYCLE_CORRECTION_UNPROVEN",
          status: "block",
          expected: desiredSignedQuantity.toFixed(3),
          actual: evidence.totalSignedQuantity.toFixed(3),
          detail: `Voucher ${voucherIdText} canonical lifecycle differs from the current sale but has no direct rate anchor for the missing inventory effect`,
        });
      } else {
        canonicalSaleLifecycleCorrections.push({
          movementId: `canonical-correction:${evidence.anchorCanonicalId}:${voucherIdText}:${locationIdText}:${stockItemIdText}`,
          companyId,
          locationId: Number(locationIdText),
          stockItemId: Number(stockItemIdText),
          occurredAt: anchorMovement.occurredAt,
          createdAt: new Date(evidence.latestMutationAt).toISOString(),
          sequence: evidence.anchorCanonicalId * 10 + 9,
          quantityDelta: correctionDelta.toFixed(3),
          unitCost: correctionRate.toFixed(2),
          sourceType: "canonical-sale-lifecycle-correction",
          sourceId: voucherIdText,
          evidence: "canonical",
        });
        checks.push({
          companyId,
          locationId: Number(locationIdText),
          stockItemId: Number(stockItemIdText),
          code: "CANONICAL_SALE_LIFECYCLE_CORRECTION",
          status: "pass",
          expected: desiredSignedQuantity.toFixed(3),
          actual: evidence.totalSignedQuantity.toFixed(3),
          detail: `Voucher ${voucherIdText} replay adds ${correctionDelta.toFixed(
            3
          )} units at its latest canonical mutation to match the current immutable sale state`,
        });
      }
    }
  }

  const canonicalForReplay = [...canonical, ...canonicalSaleLifecycleCorrections];

  // POS edits/deletes before the 2026-09-11 valuation hardening wrote a
  // reversal receipt followed by a replacement issue. Those canonical rows are
  // excellent lifecycle evidence but not exact valuation evidence: the
  // reversal used the then-live inventory average, while the journal unit_cost
  // stored the old sale-line cost. Build an alternate replay that collapses
  // each POS lifecycle to the final active sale state. It is never trusted on
  // its own: later forward proof accepts it only when it reproduces the
  // immutable Phase 3 checkpoint exactly.
  const normalizedCanonicalPosReplay: HistoricalSalesRepairMovement[] = canonical.filter(
    (movement) => movement.sourceType !== "pos-sale"
  );
  for (const [key, evidence] of canonicalSaleEvidence) {
    const posMovements = evidence.movements.filter((movement) => movement.sourceType === "pos-sale");
    if (posMovements.length === 0) continue;

    const expectedQuantity = saleQuantityByEvidenceKey.get(key);
    if (!expectedQuantity) {
      // The sale no longer exists. Its edit/delete lifecycle has a normalized
      // net stock effect of zero.
      continue;
    }

    const latestPosMutationAt = Math.max(...posMovements.map(movementMutationTime));
    const latestNegative = posMovements
      .filter(
        (movement) =>
          movementMutationTime(movement) === latestPosMutationAt &&
          d(movement.quantityDelta).lt(0) &&
          movement.unitCost !== null &&
          movement.unitCost !== undefined
      )
      .sort(compareMovementMutationAscending);

    let weightedQuantity = new Decimal(0);
    let weightedValue = new Decimal(0);
    for (const movement of latestNegative) {
      const quantity = d(movement.quantityDelta).abs();
      weightedQuantity = weightedQuantity.plus(quantity);
      weightedValue = weightedValue.plus(quantity.times(d(movement.unitCost)));
    }

    if (latestNegative.length === 0 || !weightedQuantity.gt(0)) {
      // Without a latest priced issue, do not normalize this lifecycle.
      normalizedCanonicalPosReplay.push(...posMovements);
      continue;
    }

    const anchor = latestNegative[latestNegative.length - 1];
    normalizedCanonicalPosReplay.push({
      ...anchor,
      quantityDelta: repairQuantity(expectedQuantity.negated()).toFixed(3),
      unitCost: repairRate(weightedValue.dividedBy(weightedQuantity)).toFixed(2),
      sourceType: "pos-sale-normalized",
      sourceId: key.split(":")[0],
    });
  }

  const legacySales: SaleRow[] = [];
  for (const sale of sales) {
    if (!sale.location_id) {
      checks.push({
        companyId,
        locationId: null,
        stockItemId: Number(sale.stock_item_id),
        code: "SALE_LOCATION_MISSING",
        status: "block",
        detail: `Sales item ${sale.sales_item_id} / voucher ${sale.voucher_id} has no location`,
      });
      continue;
    }

    const saleEvidenceKey = `${sale.voucher_id}:${sale.location_id}:${sale.stock_item_id}`;
    const canonicalEvidence = canonicalSaleEvidence.get(saleEvidenceKey);
    if (canonicalEvidence) {
      if (canonicalEvidence.latestNegativeRate !== null) {
        const evidenceMovement =
          canonicalEvidence.latestNegativeMovements[canonicalEvidence.latestNegativeMovements.length - 1] ??
          canonicalEvidence.movements[canonicalEvidence.movements.length - 1];
        directCanonicalProposals.set(
          Number(sale.sales_item_id),
          proposalFromRecordedRate(
            companyId,
            sale,
            canonicalEvidence.latestNegativeRate,
            evidenceMovement.sourceType,
            evidenceMovement.sourceId,
            "canonical"
          )
        );
      } else {
        directCanonicalProposals.set(Number(sale.sales_item_id), originalProposalForSale(companyId, sale));
      }
      continue;
    }
    if (!beforeCutoff(sale.created_at, canonicalStart)) {
      checks.push({
        companyId,
        locationId: Number(sale.location_id),
        stockItemId: Number(sale.stock_item_id),
        code: "CANONICAL_SALE_EVIDENCE_MISSING",
        status: "block",
        detail: `Sale item ${sale.sales_item_id} is after canonical cutover but has no canonical sale issue evidence`,
      });
      continue;
    }

    legacySales.push(sale);
    legacyMovements.push({
      movementId: `sale-marker:${sale.sales_item_id}`,
      companyId,
      locationId: Number(sale.location_id),
      stockItemId: Number(sale.stock_item_id),
      occurredAt: iso(sale.created_at),
      sequence: Number(sale.sales_item_id) * 10 + 5,
      quantityDelta: repairQuantity(d(sale.quantity).negated()).toFixed(3),
      unitCost: null,
      sourceType: "legacy-sale",
      sourceId: String(sale.voucher_id),
      evidence: "legacy",
      sale: {
        salesItemId: Number(sale.sales_item_id),
        voucherId: Number(sale.voucher_id),
        quantity: sale.quantity,
        totalSales: sale.total_sales,
        originalCostPrice: sale.cost_price,
        originalTotalCost: sale.total_cost,
        originalProfit: sale.profit,
      },
    });
  }

  checks.push(...markAmbiguousTimestampTies(companyId, legacyMovements, sales, canonicalStart, canonicalSaleKeys));

  const proposalsBySaleId = new Map<number, HistoricalSalesRepairProposal>();
  const targetKeys = new Set(
    legacySales
      .filter((sale) => sale.location_id !== null)
      .map((sale) => historicalInventoryKey(companyId, Number(sale.location_id), Number(sale.stock_item_id)))
  );

  if (!checkpoint || checkpoint.rows.length === 0) {
    checks.push({
      companyId,
      locationId: null,
      stockItemId: null,
      code: "VALUATION_CHECKPOINT_MISSING",
      status: "block",
      detail: "Phase 3 inventory valuation checkpoint is missing for this company",
    });
    for (const sale of legacySales) {
      if (sale.location_id) proposalsBySaleId.set(Number(sale.sales_item_id), originalProposalForSale(companyId, sale));
    }
  } else {
    checks.push({
      companyId,
      locationId: null,
      stockItemId: null,
      code: "VALUATION_CHECKPOINT_PRESENT",
      status: "pass",
      expected: String(checkpoint.movementCutoffId),
      actual: String(checkpoint.movementCutoffId),
      detail: checkpoint.createdAt.toISOString(),
    });

    const checkpointByKey = new Map<string, InventoryRow>();
    const checkpointStates = new Map<string, HistoricalInventoryState>();
    for (const row of checkpoint.rows) {
      const key = historicalInventoryKey(companyId, Number(row.location_id), Number(row.stock_item_id));
      checkpointByKey.set(key, row);
      checkpointStates.set(
        key,
        createHistoricalInventoryStateFromSnapshot(row.quantity, row.average_rate, row.total_value)
      );
    }

    const mergedRecovery = recoverHistoricalMergedSales({
      companyId,
      targetKeys,
      checkpoint,
      checkpointStates,
      historicalMerges,
      canonical: canonicalForReplay,
      legacyMovements,
    });
    checks.push(...mergedRecovery.checks);
    for (const proposal of mergedRecovery.proposals) {
      proposalsBySaleId.set(proposal.salesItemId, proposal);
    }

    const mergedSourceIds = new Set(historicalMerges.map((merge) => Number(merge.source_item_id)));
    const unavailableKeys = new Set<string>();
    for (const key of targetKeys) {
      if (checkpointStates.has(key) || mergedRecovery.recoveredKeys.has(key)) continue;
      const [, locationIdText, stockItemIdText] = key.split(":");
      const locationId = Number(locationIdText);
      const stockItemId = Number(stockItemIdText);
      unavailableKeys.add(key);
      const alreadyBlocked = checks.some(
        (check) =>
          check.status === "block" &&
          check.companyId === companyId &&
          check.stockItemId === stockItemId &&
          (check.locationId === null || check.locationId === locationId)
      );
      if (!alreadyBlocked) {
        checks.push({
          companyId,
          locationId,
          stockItemId,
          code: mergedSourceIds.has(stockItemId)
            ? "MERGED_ITEM_RECOVERY_FAILED"
            : "VALUATION_CHECKPOINT_KEY_MISSING",
          status: "block",
          detail: mergedSourceIds.has(stockItemId)
            ? "Historical merged item could not be reconstructed uniquely"
            : "Legacy sale item/location has no row in the immutable Phase 3 valuation checkpoint",
        });
      }
    }
    const checkpointTargetKeys = new Set(
      [...targetKeys].filter((key) => checkpointStates.has(key) && !unavailableKeys.has(key))
    );

    // Prove the immutable checkpoint still reaches today's active-location
    // inventory using every durable movement after the checkpoint. Canonical
    // rows use the exact checkpoint movement-id boundary; noncanonical durable
    // rows use the checkpoint timestamp.
    const liveReplayStates = new Map<string, HistoricalInventoryState>();
    for (const [key, state] of checkpointStates) {
      if (checkpointTargetKeys.has(key)) {
        liveReplayStates.set(
          key,
          createHistoricalInventoryStateFromSnapshot(state.quantity, state.averageRate, state.totalValue)
        );
      }
    }

    const postCheckpointMovements = [
      ...canonicalForReplay.filter((movement) => {
        const id = canonicalMovementNumericId(movement);
        return id !== null && id > checkpoint.movementCutoffId;
      }),
      ...legacyMovements.filter((movement) => movementMutationTime(movement) > checkpoint.createdAt.getTime()),
    ].sort(compareMovementMutationAscending);

    for (const movement of postCheckpointMovements) {
      const key = movementKey(movement);
      if (!checkpointTargetKeys.has(key) || unavailableKeys.has(key)) continue;
      const current =
        liveReplayStates.get(key) ?? createHistoricalInventoryStateFromSnapshot("0", movement.unitCost ?? "0", "0");
      liveReplayStates.set(
        key,
        applyHistoricalSalesRepairMovement(current, movement)
      );
    }

    const liveByKey = new Map(
      inventoryResult.rows.map((row) => [
        historicalInventoryKey(companyId, Number(row.location_id), Number(row.stock_item_id)),
        row,
      ])
    );
    for (const key of checkpointTargetKeys) {
      if (unavailableKeys.has(key)) continue;
      const actual = liveReplayStates.get(key) ?? createHistoricalInventoryStateFromSnapshot("0", "0", "0");
      const live = liveByKey.get(key);
      const expectedQty = repairQuantity(live?.quantity ?? "0");
      const expectedValue = repairMoney(live?.total_value ?? "0");
      if (
        actual.quantity.minus(expectedQty).abs().gt(QTY_TOLERANCE) ||
        actual.totalValue.minus(expectedValue).abs().gt(MONEY_TOLERANCE)
      ) {
        const [, locationIdText, stockItemIdText] = key.split(":");
        checks.push({
          companyId,
          locationId: Number(locationIdText),
          stockItemId: Number(stockItemIdText),
          code: "CHECKPOINT_TO_LIVE_RECONCILIATION_MISMATCH",
          status: "warning",
          expected: `${expectedQty.toFixed(3)}|${expectedValue.toFixed(2)}`,
          actual: `${actual.quantity.toFixed(3)}|${actual.totalValue.toFixed(2)}`,
          detail:
            "Post-checkpoint journal does not reproduce today's live inventory exactly. The immutable checkpoint remains valid for pre-checkpoint sales-cost reconstruction; apply still fingerprints inventory so this warning cannot mutate current stock.",
        });
      }
    }

    const rewindStates = new Map<string, HistoricalInventoryState>();
    for (const [key, state] of checkpointStates) {
      if (checkpointTargetKeys.has(key) && !unavailableKeys.has(key)) {
        rewindStates.set(
          key,
          createHistoricalInventoryStateFromSnapshot(state.quantity, state.averageRate, state.totalValue)
        );
      }
    }

    // Rewind every durable movement represented in the checkpoint in actual
    // mutation order. This includes durable legacy rows that never received a
    // canonical journal counterpart after canonical journaling began.
    const movementsInCheckpoint = [
      ...canonicalForReplay.filter((movement) => {
        const id = canonicalMovementNumericId(movement);
        return id !== null && id <= checkpoint.movementCutoffId;
      }),
      ...legacyMovements.filter((movement) => movementMutationTime(movement) <= checkpoint.createdAt.getTime()),
    ].sort(compareMovementMutationDescending);
    const normalizedMovementsAscending = [
      ...normalizedCanonicalPosReplay.filter((movement) => {
        const id = canonicalMovementNumericId(movement);
        return id !== null && id <= checkpoint.movementCutoffId;
      }),
      ...legacyMovements.filter((movement) => movementMutationTime(movement) <= checkpoint.createdAt.getTime()),
    ].sort(compareMovementMutationAscending);
    const priorCostMemoryRateHints =
      buildPriorCanonicalCostMemoryRateHints(movementsInCheckpoint);
    const fallbackMovementsInCheckpoint = legacyTransferFallbackMovements
      .filter((movement) => movementMutationTime(movement) <= checkpoint.createdAt.getTime())
      .sort(compareMovementMutationAscending);
    const legacyTransferFallbackItemIds = new Set(
      fallbackMovementsInCheckpoint.map((movement) => movement.stockItemId)
    );
    const targetLegacySaleMovementsByKey = new Map<string, HistoricalSalesRepairMovement[]>();
    for (const movement of legacyMovements) {
      if (!movement.sale) continue;
      const key = movementKey(movement);
      const rows = targetLegacySaleMovementsByKey.get(key) ?? [];
      rows.push(movement);
      targetLegacySaleMovementsByKey.set(key, rows);
    }

    // Reverse replay can lose pre-reset cost memory. Before blocking older
    // sales, derive location opening quantities from the immutable checkpoint,
    // reconcile them to the pinned stock-item opening balance, replay every
    // durable movement forward, and accept only an exact checkpoint match.
    const forwardReplayResolvedKeys = new Set<string>();
    const fallbackProvenItemIds = new Set<number>();
    const movementsAscending = [...movementsInCheckpoint].sort(compareMovementMutationAscending);
    const stockItemById = new Map(stockItems.map((item) => [Number(item.id), item]));
    const targetKeysByItem = new Map<number, string[]>();
    for (const key of checkpointTargetKeys) {
      const stockItemId = Number(key.split(":")[2]);
      const rows = targetKeysByItem.get(stockItemId) ?? [];
      rows.push(key);
      targetKeysByItem.set(stockItemId, rows);
    }

    for (const [stockItemId, itemTargetKeys] of targetKeysByItem) {
      const stockItem = stockItemById.get(stockItemId);
      if (!stockItem) continue;

      const hasPreexistingEvidenceBlock = checks.some(
        (check) =>
          check.status === "block" &&
          check.stockItemId === stockItemId &&
          (check.locationId === null ||
            itemTargetKeys.some((key) => Number(key.split(":")[1]) === check.locationId))
      );
      if (hasPreexistingEvidenceBlock) {
        checks.push({
          companyId,
          locationId: null,
          stockItemId,
          code: "OPENING_FORWARD_SKIPPED_PREEXISTING_BLOCK",
          status: "warning",
          detail: "Opening forward proof was skipped because independent evidence already blocks this stock item.",
        });
        continue;
      }

      const itemMovements = movementsAscending.filter(
        (movement) => movement.stockItemId === stockItemId
      );
      const normalizedItemMovements = normalizedMovementsAscending.filter(
        (movement) => movement.stockItemId === stockItemId
      );
      const openingQty = repairQuantity(stockItem.opening_qty);
      const openingRate = repairRate(stockItem.opening_rate);
      const openingValue = repairMoney(stockItem.opening_value);
      const fallbackItemMovements = fallbackMovementsInCheckpoint.filter(
        (movement) => movement.stockItemId === stockItemId
      );
      let fallbackProofCandidate:
        | {
            replay: {
              exact: boolean;
              detail: string | null;
              replayProposals: Map<number, HistoricalSalesRepairProposal>;
              peakNegativeLayerQuantity: Decimal;
            };
            openingTotal: Decimal;
            openingProofBasis:
              | "stock-opening"
              | "location-import-inferred"
              | "signed-location-import-inferred";
            usedNormalizedPos: boolean;
            movementCount: number;
          }
        | null = null;

      if (fallbackItemMovements.length > 0) {
        const fallbackRawMovements = [...itemMovements, ...fallbackItemMovements].sort(
          compareMovementMutationAscending
        );
        const fallbackNormalizedMovements = [
          ...normalizedItemMovements,
          ...fallbackItemMovements,
        ].sort(compareMovementMutationAscending);
        const fallbackLocationIds = new Set<number>([
          ...checkpoint.rows
            .filter((row) => Number(row.stock_item_id) === stockItemId)
            .map((row) => Number(row.location_id)),
          ...fallbackRawMovements.map((movement) => movement.locationId),
          ...fallbackNormalizedMovements.map((movement) => movement.locationId),
        ]);

        const rawFallbackDeltaByLocation = new Map<number, Decimal>();
        for (const movement of fallbackRawMovements) {
          rawFallbackDeltaByLocation.set(
            movement.locationId,
            repairQuantity(
              (rawFallbackDeltaByLocation.get(movement.locationId) ?? new Decimal(0)).plus(
                d(movement.quantityDelta)
              )
            )
          );
        }
        const normalizedFallbackDeltaByLocation = new Map<number, Decimal>();
        for (const movement of fallbackNormalizedMovements) {
          normalizedFallbackDeltaByLocation.set(
            movement.locationId,
            repairQuantity(
              (normalizedFallbackDeltaByLocation.get(movement.locationId) ?? new Decimal(0)).plus(
                d(movement.quantityDelta)
              )
            )
          );
        }
        const fallbackNormalizedQuantityCompatible = [...fallbackLocationIds].every(
          (locationId) =>
            (normalizedFallbackDeltaByLocation.get(locationId) ?? new Decimal(0)).eq(
              rawFallbackDeltaByLocation.get(locationId) ?? new Decimal(0)
            )
        );

        const fallbackOpeningQtyByLocation = new Map<number, Decimal>();
        let fallbackOpeningTotal = new Decimal(0);
        let fallbackHasNegativeOpening = false;
        for (const locationId of fallbackLocationIds) {
          const checkpointState = checkpointStates.get(
            historicalInventoryKey(companyId, locationId, stockItemId)
          );
          let inferred = repairQuantity(
            (checkpointState?.quantity ?? new Decimal(0)).minus(
              rawFallbackDeltaByLocation.get(locationId) ?? new Decimal(0)
            )
          );
          if (inferred.abs().lte(QTY_TOLERANCE)) inferred = new Decimal(0);
          if (inferred.lt(0)) fallbackHasNegativeOpening = true;
          fallbackOpeningQtyByLocation.set(locationId, inferred);
          fallbackOpeningTotal = repairQuantity(fallbackOpeningTotal.plus(inferred));
        }

        let fallbackOpeningProofBasis:
          | "stock-opening"
          | "location-import-inferred"
          | "signed-location-import-inferred" = "stock-opening";
        let fallbackOpeningStates: Map<number, HistoricalInventoryState> | null =
          new Map<number, HistoricalInventoryState>();

        if (fallbackHasNegativeOpening) {
          if (!openingRate.gt(0)) {
            fallbackOpeningStates = null;
          } else {
            fallbackOpeningProofBasis = "signed-location-import-inferred";
            for (const [locationId, quantity] of fallbackOpeningQtyByLocation) {
              fallbackOpeningStates.set(
                locationId,
                createHistoricalSignedLocationImportState(quantity, openingRate)
              );
            }
          }
        } else if (!fallbackOpeningTotal.eq(openingQty)) {
          if (!openingRate.gt(0)) {
            fallbackOpeningStates = null;
          } else {
            fallbackOpeningProofBasis = "location-import-inferred";
            for (const [locationId, quantity] of fallbackOpeningQtyByLocation) {
              fallbackOpeningStates.set(
                locationId,
                quantity.gt(0)
                  ? createHistoricalInventoryStateFromSnapshot(
                      quantity,
                      openingRate,
                      repairMoney(quantity.times(openingRate))
                    )
                  : stateForZeroOpening(openingRate)
              );
            }
          }
        } else if (openingQty.isZero()) {
          if (openingValue.abs().gt(MONEY_TOLERANCE)) {
            fallbackOpeningStates = null;
          } else {
            for (const locationId of fallbackLocationIds) {
              fallbackOpeningStates.set(locationId, stateForZeroOpening(openingRate));
            }
          }
        } else {
          const positiveLocations = [...fallbackOpeningQtyByLocation.entries()].filter(
            ([, quantity]) => quantity.gt(0)
          );
          if (positiveLocations.length === 1 && positiveLocations[0][1].eq(openingQty)) {
            const openingLocationId = positiveLocations[0][0];
            for (const locationId of fallbackLocationIds) {
              fallbackOpeningStates.set(
                locationId,
                locationId === openingLocationId
                  ? createHistoricalInventoryStateFromSnapshot(
                      openingQty,
                      openingRate,
                      openingValue
                    )
                  : stateForZeroOpening(openingRate)
              );
            }
          } else {
            let allocatedValue = new Decimal(0);
            for (const [locationId, quantity] of fallbackOpeningQtyByLocation) {
              const value = repairMoney(quantity.times(openingRate));
              fallbackOpeningStates.set(
                locationId,
                createHistoricalInventoryStateFromSnapshot(quantity, openingRate, value)
              );
              allocatedValue = repairMoney(allocatedValue.plus(value));
            }
            if (!allocatedValue.eq(openingValue)) fallbackOpeningStates = null;
          }
        }

        if (fallbackOpeningStates) {
          const replayFallbackToCheckpoint = (
            candidateMovements: HistoricalSalesRepairMovement[]
          ) => {
            const replayStates = new Map<number, HistoricalForwardReplayState>();
            for (const [locationId, opening] of fallbackOpeningStates!) {
              replayStates.set(
                locationId,
                createHistoricalForwardReplayState(opening)
              );
            }

            const replayProposals = new Map<number, HistoricalSalesRepairProposal>();
            let peakNegativeLayerQuantity = new Decimal(0);
            for (const movement of candidateMovements) {
              const current =
                replayStates.get(movement.locationId) ??
                createHistoricalForwardReplayState(stateForZeroOpening(openingRate));
              if (movement.sale && checkpointTargetKeys.has(movementKey(movement))) {
                replayProposals.set(
                  movement.sale.salesItemId,
                  historicalSaleProposalFromState(movement, current.inventory)
                );
              }
              const next = applyHistoricalForwardReplayMovement(current, movement);
              if (next.negativeLayerQuantity.gt(peakNegativeLayerQuantity)) {
                peakNegativeLayerQuantity = next.negativeLayerQuantity;
              }
              replayStates.set(movement.locationId, next);
            }

            let exact = true;
            let detail: string | null = null;
            for (const locationId of fallbackLocationIds) {
              const key = historicalInventoryKey(companyId, locationId, stockItemId);
              const actual =
                replayStates.get(locationId)?.inventory ??
                stateForZeroOpening(openingRate);
              const expected = checkpointStates.get(key);
              if (expected) {
                if (!historicalInventoryStatesEqual(actual, expected)) {
                  exact = false;
                  detail =
                    "location " +
                    locationId +
                    " expected " +
                    repairQuantity(expected.quantity).toFixed(3) +
                    "|" +
                    repairRate(expected.averageRate).toFixed(2) +
                    "|" +
                    repairMoney(expected.totalValue).toFixed(2) +
                    " actual " +
                    repairQuantity(actual.quantity).toFixed(3) +
                    "|" +
                    repairRate(actual.averageRate).toFixed(2) +
                    "|" +
                    repairMoney(actual.totalValue).toFixed(2);
                  break;
                }
              } else if (
                !repairQuantity(actual.quantity).isZero() ||
                repairMoney(actual.totalValue).abs().gt(MONEY_TOLERANCE)
              ) {
                exact = false;
                detail =
                  "location " +
                  locationId +
                  " has no checkpoint row but replay ends " +
                  repairQuantity(actual.quantity).toFixed(3) +
                  "|" +
                  repairRate(actual.averageRate).toFixed(2) +
                  "|" +
                  repairMoney(actual.totalValue).toFixed(2);
                break;
              }
            }
            return { exact, detail, replayProposals, peakNegativeLayerQuantity };
          };

          const fallbackRawReplay = replayFallbackToCheckpoint(fallbackRawMovements);
          let fallbackAcceptedReplay = fallbackRawReplay;
          let fallbackUsedNormalizedPos = false;
          const fallbackRawPosFingerprint = fallbackRawMovements
            .filter((movement) => movement.sourceType === "pos-sale")
            .map(
              (movement) =>
                `${movement.movementId}:${movement.quantityDelta}:${movement.unitCost ?? ""}`
            )
            .join("|");
          const fallbackNormalizedPosFingerprint = fallbackNormalizedMovements
            .filter(
              (movement) =>
                movement.sourceType === "pos-sale" ||
                movement.sourceType === "pos-sale-normalized"
            )
            .map(
              (movement) =>
                `${movement.movementId}:${movement.quantityDelta}:${movement.unitCost ?? ""}`
            )
            .join("|");

          if (
            !fallbackAcceptedReplay.exact &&
            fallbackNormalizedQuantityCompatible &&
            fallbackRawPosFingerprint !== fallbackNormalizedPosFingerprint
          ) {
            const normalizedFallbackReplay = replayFallbackToCheckpoint(
              fallbackNormalizedMovements
            );
            if (normalizedFallbackReplay.exact) {
              fallbackAcceptedReplay = normalizedFallbackReplay;
              fallbackUsedNormalizedPos = true;
            }
          }

          if (fallbackAcceptedReplay.exact) {
            fallbackProofCandidate = {
              replay: fallbackAcceptedReplay,
              openingTotal: fallbackOpeningTotal,
              openingProofBasis: fallbackOpeningProofBasis,
              usedNormalizedPos: fallbackUsedNormalizedPos,
              movementCount: fallbackItemMovements.length,
            };
          }
        }
      }

      const locationIds = new Set<number>([
        ...checkpoint.rows
          .filter((row) => Number(row.stock_item_id) === stockItemId)
          .map((row) => Number(row.location_id)),
        ...itemMovements.map((movement) => movement.locationId),
        ...normalizedItemMovements.map((movement) => movement.locationId),
      ]);
      if (locationIds.size === 0) continue;

      const movementDeltaByLocation = new Map<number, Decimal>();
      for (const movement of itemMovements) {
        movementDeltaByLocation.set(
          movement.locationId,
          repairQuantity(
            (movementDeltaByLocation.get(movement.locationId) ?? new Decimal(0)).plus(
              d(movement.quantityDelta)
            )
          )
        );
      }
      const normalizedMovementDeltaByLocation = new Map<number, Decimal>();
      for (const movement of normalizedItemMovements) {
        normalizedMovementDeltaByLocation.set(
          movement.locationId,
          repairQuantity(
            (normalizedMovementDeltaByLocation.get(movement.locationId) ?? new Decimal(0)).plus(
              d(movement.quantityDelta)
            )
          )
        );
      }
      const normalizedQuantityCompatible = [...locationIds].every((locationId) =>
        (normalizedMovementDeltaByLocation.get(locationId) ?? new Decimal(0)).eq(
          movementDeltaByLocation.get(locationId) ?? new Decimal(0)
        )
      );
      const rawPosFingerprint = itemMovements
        .filter((movement) => movement.sourceType === "pos-sale")
        .map((movement) => `${movement.movementId}:${movement.quantityDelta}:${movement.unitCost ?? ""}`)
        .join("|");
      const normalizedPosFingerprint = normalizedItemMovements
        .filter(
          (movement) =>
            movement.sourceType === "pos-sale" || movement.sourceType === "pos-sale-normalized"
        )
        .map((movement) => `${movement.movementId}:${movement.quantityDelta}:${movement.unitCost ?? ""}`)
        .join("|");
      const normalizedLifecycleChanged = rawPosFingerprint !== normalizedPosFingerprint;

      const inferredOpeningQtyByLocation = new Map<number, Decimal>();
      let inferredOpeningTotal = new Decimal(0);
      let hasNegativeInferredOpening = false;
      for (const locationId of locationIds) {
        const checkpointState = checkpointStates.get(
          historicalInventoryKey(companyId, locationId, stockItemId)
        );
        let inferred = repairQuantity(
          (checkpointState?.quantity ?? new Decimal(0)).minus(
            movementDeltaByLocation.get(locationId) ?? new Decimal(0)
          )
        );
        if (inferred.abs().lte(QTY_TOLERANCE)) inferred = new Decimal(0);
        if (inferred.lt(0)) hasNegativeInferredOpening = true;
        inferredOpeningQtyByLocation.set(locationId, inferred);
        inferredOpeningTotal = repairQuantity(inferredOpeningTotal.plus(inferred));
      }

      const pinnedOpeningQuantityMatches = inferredOpeningTotal.eq(openingQty);
      let openingProofBasis:
        | "stock-opening"
        | "location-import-inferred"
        | "signed-location-import-inferred" = "stock-opening";

      if (hasNegativeInferredOpening) {
        checks.push({
          companyId,
          locationId: null,
          stockItemId,
          code: "OPENING_FORWARD_NEGATIVE_INFERRED_QTY",
          status: "warning",
          expected: openingQty.toFixed(3),
          actual: inferredOpeningTotal.toFixed(3),
          detail:
            "Checkpoint minus durable movement deltas implies a signed per-location opening. V15 will try the historical signed location-import shape only when a pinned nonzero opening rate exists, and will accept it only on an exact checkpoint replay.",
        });
        if (!openingRate.gt(0)) continue;
        openingProofBasis = "signed-location-import-inferred";
      } else if (!pinnedOpeningQuantityMatches) {
        checks.push({
          companyId,
          locationId: null,
          stockItemId,
          code: "OPENING_FORWARD_QTY_MISMATCH",
          status: "warning",
          expected: openingQty.toFixed(3),
          actual: inferredOpeningTotal.toFixed(3),
          detail:
            "Item-level opening quantity differs from checkpoint-implied location opening. The repair will try the historical location-import shape only when a pinned nonzero opening rate exists, and will accept it only on an exact checkpoint replay.",
        });
        if (!openingRate.gt(0)) continue;
        openingProofBasis = "location-import-inferred";
      }

      const positiveOpeningLocations = [...inferredOpeningQtyByLocation.entries()].filter(
        ([, quantity]) => quantity.gt(0)
      );
      const openingStates = new Map<number, HistoricalInventoryState>();

      if (openingProofBasis === "signed-location-import-inferred") {
        // The historical location-import route accepted signed quantities and
        // defaulted value to quantity × rate before writing the inventory row
        // directly. Preserve that exact signed shape as a candidate. The
        // candidate remains untrusted unless the complete historical replay
        // reproduces the immutable checkpoint quantity, rate and value.
        for (const [locationId, quantity] of inferredOpeningQtyByLocation) {
          openingStates.set(
            locationId,
            createHistoricalSignedLocationImportState(quantity, openingRate)
          );
        }
      } else if (openingProofBasis === "location-import-inferred") {
        // Historical /api/locations/:locationId/import-inventory writes location
        // quantity/value directly and does not update the item-level frozen
        // opening quantity. Reconstruct those per-location quantities from the
        // immutable checkpoint and durable net movement, but keep the separately
        // pinned item opening rate as the independent cost anchor. This remains a
        // candidate until the full quantity/rate/value replay matches exactly.
        for (const [locationId, quantity] of inferredOpeningQtyByLocation) {
          if (quantity.gt(0)) {
            const value = repairMoney(quantity.times(openingRate));
            openingStates.set(
              locationId,
              createHistoricalInventoryStateFromSnapshot(quantity, openingRate, value)
            );
          } else {
            openingStates.set(locationId, stateForZeroOpening(openingRate));
          }
        }
      } else if (openingQty.isZero()) {
        if (openingValue.abs().gt(MONEY_TOLERANCE)) {
          checks.push({
            companyId,
            locationId: null,
            stockItemId,
            code: "OPENING_FORWARD_ZERO_QTY_VALUE_MISMATCH",
            status: "warning",
            expected: "0.00",
            actual: openingValue.toFixed(2),
            detail: "Pinned opening quantity is zero but pinned opening value is nonzero.",
          });
          continue;
        }
        for (const locationId of locationIds) {
          openingStates.set(locationId, stateForZeroOpening(openingRate));
        }
      } else if (positiveOpeningLocations.length === 1) {
        const [openingLocationId, locationQty] = positiveOpeningLocations[0];
        if (!locationQty.eq(openingQty)) continue;
        for (const locationId of locationIds) {
          openingStates.set(
            locationId,
            locationId === openingLocationId
              ? createHistoricalInventoryStateFromSnapshot(
                  locationQty,
                  openingRate,
                  openingValue
                )
              : stateForZeroOpening(openingRate)
          );
        }
      } else {
        let allocatedValue = new Decimal(0);
        for (const [locationId, quantity] of inferredOpeningQtyByLocation) {
          const value = repairMoney(quantity.times(openingRate));
          openingStates.set(
            locationId,
            createHistoricalInventoryStateFromSnapshot(quantity, openingRate, value)
          );
          allocatedValue = repairMoney(allocatedValue.plus(value));
        }
        if (!allocatedValue.eq(openingValue)) {
          checks.push({
            companyId,
            locationId: null,
            stockItemId,
            code: "OPENING_FORWARD_VALUE_ALLOCATION_MISMATCH",
            status: "warning",
            expected: openingValue.toFixed(2),
            actual: allocatedValue.toFixed(2),
            detail: "Multiple inferred opening locations cannot reproduce the pinned opening value at the pinned opening rate.",
          });
          continue;
        }
      }

      const replayToCheckpoint = (candidateMovements: HistoricalSalesRepairMovement[]) => {
        const replayStates = new Map<number, HistoricalForwardReplayState>();
        for (const [locationId, opening] of openingStates) {
          replayStates.set(
            locationId,
            createHistoricalForwardReplayState(opening)
          );
        }

        const replayProposals = new Map<number, HistoricalSalesRepairProposal>();
        let peakNegativeLayerQuantity = new Decimal(0);
        for (const movement of candidateMovements) {
          const current =
            replayStates.get(movement.locationId) ??
            createHistoricalForwardReplayState(stateForZeroOpening(openingRate));
          if (movement.sale) {
            const key = movementKey(movement);
            if (checkpointTargetKeys.has(key)) {
              replayProposals.set(
                movement.sale.salesItemId,
                historicalSaleProposalFromState(movement, current.inventory)
              );
            }
          }
          const next = applyHistoricalForwardReplayMovement(current, movement);
          if (next.negativeLayerQuantity.gt(peakNegativeLayerQuantity)) {
            peakNegativeLayerQuantity = next.negativeLayerQuantity;
          }
          replayStates.set(movement.locationId, next);
        }

        let exact = true;
        let detail: string | null = null;
        for (const locationId of locationIds) {
          const key = historicalInventoryKey(companyId, locationId, stockItemId);
          const actualReplay =
            replayStates.get(locationId) ??
            createHistoricalForwardReplayState(stateForZeroOpening(openingRate));
          const actual = actualReplay.inventory;
          const expected = checkpointStates.get(key);
          if (expected) {
            if (!historicalInventoryStatesEqual(actual, expected)) {
              exact = false;
              detail =
                "location " +
                locationId +
                " expected " +
                repairQuantity(expected.quantity).toFixed(3) +
                "|" +
                repairRate(expected.averageRate).toFixed(2) +
                "|" +
                repairMoney(expected.totalValue).toFixed(2) +
                " actual " +
                repairQuantity(actual.quantity).toFixed(3) +
                "|" +
                repairRate(actual.averageRate).toFixed(2) +
                "|" +
                repairMoney(actual.totalValue).toFixed(2) +
                " peakLayerQty " +
                peakNegativeLayerQuantity.toFixed(3);
              break;
            }
          } else if (
            !repairQuantity(actual.quantity).isZero() ||
            repairMoney(actual.totalValue).abs().gt(MONEY_TOLERANCE)
          ) {
            exact = false;
            detail =
              "location " +
              locationId +
              " has no checkpoint row but replay ends " +
              repairQuantity(actual.quantity).toFixed(3) +
              "|" +
              repairRate(actual.averageRate).toFixed(2) +
              "|" +
              repairMoney(actual.totalValue).toFixed(2) +
              " peakLayerQty " +
              peakNegativeLayerQuantity.toFixed(3);
            break;
          }
        }

        return { exact, detail, replayProposals, peakNegativeLayerQuantity };
      };

      const rawReplay = replayToCheckpoint(itemMovements);
      let acceptedReplay = rawReplay;
      let proofMode: "raw" | "normalized-pos-lifecycle" = "raw";
      let normalizedReplay:
        | ReturnType<typeof replayToCheckpoint>
        | undefined;

      if (
        !rawReplay.exact &&
        normalizedQuantityCompatible &&
        normalizedLifecycleChanged
      ) {
        normalizedReplay = replayToCheckpoint(normalizedItemMovements);
        if (normalizedReplay.exact) {
          acceptedReplay = normalizedReplay;
          proofMode = "normalized-pos-lifecycle";
        }
      }

      if (!acceptedReplay.exact) {
        if (fallbackProofCandidate) {
          acceptedReplay = fallbackProofCandidate.replay;
          inferredOpeningTotal = fallbackProofCandidate.openingTotal;
          openingProofBasis = fallbackProofCandidate.openingProofBasis;
          proofMode = fallbackProofCandidate.usedNormalizedPos
            ? "normalized-pos-lifecycle"
            : "raw";
          fallbackProvenItemIds.add(stockItemId);
          checks.push({
            companyId,
            locationId: null,
            stockItemId,
            code: "LEGACY_TRANSFER_FLAG_FALLBACK_REPLAY_PROVEN",
            status: "pass",
            actual: String(fallbackProofCandidate.movementCount),
            detail:
              "Trusted V15 replay failed, but adding the false inventory_applied legacy transfer rows reproduced the immutable Phase 3 checkpoint exactly; only this proven item history uses the fallback.",
          });
        } else {
          checks.push({
            companyId,
            locationId: null,
            stockItemId,
            code: "OPENING_FORWARD_CHECKPOINT_MISMATCH",
            status: "warning",
            detail:
              rawReplay.detail ??
              normalizedReplay?.detail ??
              "Forward replay did not reproduce the immutable checkpoint.",
          });
          continue;
        }
      }

      if (openingProofBasis === "signed-location-import-inferred") {
        checks.push({
          companyId,
          locationId: null,
          stockItemId,
          code: "OPENING_FORWARD_SIGNED_LOCATION_IMPORT_RECONCILED",
          status: "pass",
          expected: openingQty.toFixed(3) + "@" + openingRate.toFixed(2),
          actual: inferredOpeningTotal.toFixed(3) + "@" + openingRate.toFixed(2),
          detail:
            "Checkpoint-implied signed per-location openings seeded at the separately pinned item rate replay exactly to the immutable Phase 3 checkpoint, consistent with the historical signed location-inventory import path.",
        });
      }

      if (openingProofBasis === "location-import-inferred") {
        checks.push({
          companyId,
          locationId: null,
          stockItemId,
          code: "OPENING_FORWARD_LOCATION_IMPORT_RECONCILED",
          status: "pass",
          expected: openingQty.toFixed(3) + "@" + openingRate.toFixed(2),
          actual: inferredOpeningTotal.toFixed(3) + "@" + openingRate.toFixed(2),
          detail:
            "Checkpoint-implied per-location opening quantities seeded at the separately pinned item opening rate replay exactly to the immutable Phase 3 checkpoint, consistent with the historical direct location-inventory import path.",
        });
      }

      if (acceptedReplay.peakNegativeLayerQuantity.gt(0)) {
        checks.push({
          companyId,
          locationId: null,
          stockItemId,
          code: "OPENING_FORWARD_EPOCH_LAYER_REPLAY",
          status: "pass",
          actual: acceptedReplay.peakNegativeLayerQuantity.toFixed(3),
          detail:
            "Forward proof reproduced the checkpoint while simulating the historical negative-layer engine and its production epoch boundaries.",
        });
      }

      if (proofMode === "normalized-pos-lifecycle") {
        checks.push({
          companyId,
          locationId: null,
          stockItemId,
          code: "OPENING_FORWARD_POS_LIFECYCLE_NORMALIZED",
          status: "pass",
          detail:
            "Raw POS edit/delete valuation history missed the checkpoint, but the final-active-sale normalization reproduced the immutable Phase 3 checkpoint exactly.",
        });
      }

      for (const key of itemTargetKeys) {
        forwardReplayResolvedKeys.add(key);
        const locationId = Number(key.split(":")[1]);
        checks.push({
          companyId,
          locationId,
          stockItemId,
          code: "OPENING_FORWARD_REPLAY_PROVEN",
          status: "pass",
          expected: openingQty.toFixed(3) + "|" + openingValue.toFixed(2),
          actual:
            inferredOpeningTotal.toFixed(3) +
            "|" +
            (openingProofBasis === "location-import-inferred" ||
            openingProofBasis === "signed-location-import-inferred"
              ? repairMoney(inferredOpeningTotal.times(openingRate)).toFixed(2)
              : openingValue.toFixed(2)),
          detail:
            openingProofBasis === "signed-location-import-inferred"
              ? "Checkpoint-implied signed location openings at the pinned item rate and all durable movements replay exactly to the immutable Phase 3 checkpoint"
              : openingProofBasis === "location-import-inferred"
                ? "Checkpoint-implied location openings at the pinned item rate and all durable movements replay exactly to the immutable Phase 3 checkpoint"
                : proofMode === "normalized-pos-lifecycle"
                ? "Pinned stock opening balance and normalized final POS lifecycle replay exactly to the immutable Phase 3 checkpoint"
                : "Pinned stock opening balance and all durable movements replay exactly to the immutable Phase 3 checkpoint",
        });
      }
      for (const proposal of acceptedReplay.replayProposals.values()) {
        proposalsBySaleId.set(proposal.salesItemId, proposal);
      }
    }

    for (const stockItemId of legacyTransferFallbackItemIds) {
      const itemKeys = targetKeysByItem.get(stockItemId) ?? [];
      if (itemKeys.length === 0 || fallbackProvenItemIds.has(stockItemId)) continue;
      checks.push({
        companyId,
        locationId: null,
        stockItemId,
        code: "LEGACY_TRANSFER_FLAG_FALLBACK_IGNORED",
        status: "warning",
        actual: String(itemKeys.length),
        detail:
          "False inventory_applied legacy transfer rows did not reproduce the immutable checkpoint, so V17 ignores them and retains the trusted V15 movement history for this item.",
      });
    }

    // A priced receipt that crosses an item/location from zero or negative
    // quantity to positive quantity resets cost memory: the post-receipt
    // valuation is determined entirely by the receipt rate and the positive
    // remainder. Derive quantities backwards from the immutable checkpoint,
    // then replay forward from each reset candidate. Accept the earliest
    // candidate that reproduces the checkpoint exactly, which proves every
    // target legacy sale after that reset without needing older cost memory.
    const forwardResetProvenSaleIds = new Set<number>();
    const movementsByTargetKey = new Map<string, HistoricalSalesRepairMovement[]>();
    for (const movement of movementsAscending) {
      const key = movementKey(movement);
      if (!checkpointTargetKeys.has(key) || unavailableKeys.has(key)) continue;
      const rows = movementsByTargetKey.get(key) ?? [];
      rows.push(movement);
      movementsByTargetKey.set(key, rows);
    }

    for (const key of checkpointTargetKeys) {
      if (unavailableKeys.has(key) || forwardReplayResolvedKeys.has(key)) continue;
      const checkpointState = checkpointStates.get(key);
      if (!checkpointState) continue;
      const movements = movementsByTargetKey.get(key) ?? [];
      if (movements.length === 0) continue;

      const quantityBefore = new Array<Decimal>(movements.length);
      let quantityAfter = repairQuantity(checkpointState.quantity);
      for (let index = movements.length - 1; index >= 0; index -= 1) {
        const delta = repairQuantity(movements[index].quantityDelta);
        const before = repairQuantity(quantityAfter.minus(delta));
        quantityBefore[index] = before;
        quantityAfter = before;
      }

      let accepted:
        | {
            anchor: HistoricalSalesRepairMovement;
            stateAtCheckpoint: HistoricalInventoryState;
            proposals: HistoricalSalesRepairProposal[];
          }
        | undefined;

      for (let anchorIndex = 0; anchorIndex < movements.length; anchorIndex += 1) {
        const anchor = movements[anchorIndex];
        const delta = repairQuantity(anchor.quantityDelta);
        const beforeQty = quantityBefore[anchorIndex];
        const afterQty = repairQuantity(beforeQty.plus(delta));
        if (
          !delta.gt(0) ||
          anchor.unitCost === null ||
          anchor.unitCost === undefined ||
          posJournalCostIsNotInventoryRate(anchor) ||
          beforeQty.gt(0) ||
          !afterQty.gt(0)
        ) {
          continue;
        }

        let state = applyHistoricalSalesRepairMovement(createHistoricalInventoryStateFromSnapshot(beforeQty, "0", "0"), anchor);
        const candidateProposals: HistoricalSalesRepairProposal[] = [];
        for (let index = anchorIndex + 1; index < movements.length; index += 1) {
          const movement = movements[index];
          if (movement.sale) {
            candidateProposals.push(historicalSaleProposalFromState(movement, state));
          }
          state = applyHistoricalSalesRepairMovement(state, movement);
        }

        if (!historicalInventoryStatesEqual(state, checkpointState)) continue;
        if (candidateProposals.length === 0) continue;

        accepted = {
          anchor,
          stateAtCheckpoint: state,
          proposals: candidateProposals,
        };
        break;
      }

      if (!accepted) continue;

      let provenCount = 0;
      for (const proposal of accepted.proposals) {
        proposalsBySaleId.set(proposal.salesItemId, proposal);
        forwardResetProvenSaleIds.add(proposal.salesItemId);
        provenCount += 1;
      }
      const [, locationIdText, stockItemIdText] = key.split(":");
      checks.push({
        companyId,
        locationId: Number(locationIdText),
        stockItemId: Number(stockItemIdText),
        code: "FORWARD_RESET_SEGMENT_PROVEN",
        status: "pass",
        expected: `${repairQuantity(checkpointState.quantity).toFixed(3)}|${repairMoney(
          checkpointState.totalValue
        ).toFixed(2)}|${repairRate(checkpointState.averageRate).toFixed(2)}`,
        actual: `${repairQuantity(accepted.stateAtCheckpoint.quantity).toFixed(
          3
        )}|${repairMoney(accepted.stateAtCheckpoint.totalValue).toFixed(
          2
        )}|${repairRate(accepted.stateAtCheckpoint.averageRate).toFixed(2)}`,
        detail: `Reset anchor ${accepted.anchor.movementId} proves ${provenCount} later legacy sale(s) by exact checkpoint replay`,
      });
    }

    const rewindBoundaryReached = new Set<string>();
    // V34 diagnostic: rewinding a receipt divides any value error by the
    // smaller pre-receipt quantity, so the reconstructed rate's sensitivity to
    // a one-cent model error at the checkpoint grows by Q_after/Q_before at
    // every rewound receipt (issues leave it unchanged). Low-stock keys that
    // never reach zero (company 1, location 134, item 702 hovered at one unit
    // for nine months) amplify a 2-cent drift into 536M/unit. Recorded as a
    // warning to measure before any threshold becomes a blocker.
    const rewindSensitivity = new Map<string, Decimal>();
    const REWIND_AMPLIFICATION_LIMIT = new Decimal(100);
    const rewindAmplification = new Map<
      string,
      { max: Decimal; maxSalesItemId: number; proposals: number; over10: number; over100: number }
    >();

    for (const movement of movementsInCheckpoint) {
      const key = movementKey(movement);
      if (
        !checkpointTargetKeys.has(key) ||
        unavailableKeys.has(key) ||
        forwardReplayResolvedKeys.has(key) ||
        rewindBoundaryReached.has(key)
      ) {
        continue;
      }
      const stateAfter = rewindStates.get(key);
      if (!stateAfter) continue;
      const reversed = reverseHistoricalSalesRepairMovement(stateAfter, movement, {
          priorCostMemoryRate: priorCostMemoryRateHints.get(movement.movementId) ?? null,
        });
      if (!reversed.reversible) {
        const priorRateHint = priorCostMemoryRateHints.get(movement.movementId) ?? null;
        checks.push({
          companyId,
          locationId: movement.locationId,
          stockItemId: movement.stockItemId,
          code: "REWIND_BOUNDARY_DIAGNOSTIC",
          status: "warning",
          expected:
            repairQuantity(stateAfter.quantity).toFixed(3) +
            "|" +
            repairRate(stateAfter.averageRate).toFixed(2) +
            "|" +
            repairMoney(stateAfter.totalValue).toFixed(2),
          actual:
            repairQuantity(movement.quantityDelta).toFixed(3) +
            "|" +
            (movement.unitCost == null ? "null" : String(movement.unitCost)) +
            "|" +
            (priorRateHint == null ? "null" : repairRate(priorRateHint).toFixed(2)),
          detail:
            "reason=" +
            reversed.reason +
            " boundary=" +
            movement.movementId +
            " sourceType=" +
            movement.sourceType +
            " evidence=" +
            movement.evidence +
            " stateAfter=qty|rate|value delta|unitCost|priorRateHint occurredAt=" +
            movement.occurredAt,
        });
        const unresolvedSales = (targetLegacySaleMovementsByKey.get(key) ?? []).filter(
          (saleMovement) =>
            compareMovementMutationAscending(saleMovement, movement) <= 0 &&
            !forwardResetProvenSaleIds.has(saleMovement.sale!.salesItemId)
        );
        rewindBoundaryReached.add(key);

        if (unresolvedSales.length === 0) {
          checks.push({
            companyId,
            locationId: movement.locationId,
            stockItemId: movement.stockItemId,
            code: "REWIND_RESET_BOUNDARY_REACHED",
            status: "pass",
            detail: `Stopped safely at ${movement.movementId} because no target historical sale exists before the irreversible valuation boundary`,
          });
          continue;
        }

        for (const saleMovement of unresolvedSales) {
          checks.push({
            companyId,
            locationId: saleMovement.locationId,
            stockItemId: saleMovement.stockItemId,
            salesItemId: saleMovement.sale!.salesItemId,
            code: `${movement.evidence === "canonical" ? "CHECKPOINT" : "LEGACY"}_REWIND_${reversed.reason}`,
            status: "block",
            detail: `Sales item ${saleMovement.sale!.salesItemId} predates irreversible valuation boundary ${movement.movementId}`,
          });
        }
        continue;
      }

      if (reversed.recovery === "CANONICAL_RATE_ONLY") {
        checks.push({
          companyId,
          locationId: movement.locationId,
          stockItemId: movement.stockItemId,
          code: "CANONICAL_REWIND_RATE_ONLY_RECOVERED",
          status: "pass",
          expected:
            repairQuantity(stateAfter.quantity).toFixed(3) +
            "|" +
            repairMoney(stateAfter.totalValue).toFixed(2),
          actual:
            repairQuantity(stateAfter.quantity).toFixed(3) +
            "|" +
            repairMoney(stateAfter.totalValue).toFixed(2),
          detail:
            "Canonical boundary " +
            movement.movementId +
            " recovered because forward replay reproduced quantity and total value exactly; only the reconstructed intermediate average-rate field disagreed. Prior rate=" +
            repairRate(reversed.stateBefore.averageRate).toFixed(2),
        });
      }

      if (reversed.recovery === "LEGACY_ISSUE_RATE_ONLY") {
        checks.push({
          companyId,
          locationId: movement.locationId,
          stockItemId: movement.stockItemId,
          code: "LEGACY_REWIND_RATE_ONLY_RECOVERED",
          status: "pass",
          expected:
            repairQuantity(stateAfter.quantity).toFixed(3) +
            "|" +
            repairMoney(stateAfter.totalValue).toFixed(2),
          actual:
            repairQuantity(stateAfter.quantity).toFixed(3) +
            "|" +
            repairMoney(stateAfter.totalValue).toFixed(2),
          detail:
            "Legacy sale boundary " +
            movement.movementId +
            " recovered from the unique self-consistent pre-issue rate because replay reproduced quantity and total value exactly; no ambiguous rate candidate was accepted. Prior rate=" +
            repairRate(reversed.stateBefore.averageRate).toFixed(2),
        });
      }

      if (reversed.recovery === "CANONICAL_RECORDED_ISSUE_RATE") {
        checks.push({
          companyId,
          locationId: movement.locationId,
          stockItemId: movement.stockItemId,
          code: "CANONICAL_RECORDED_SALE_RATE_RECOVERED",
          status: "pass",
          expected: repairRate(movement.unitCost ?? "0").toFixed(2),
          actual: repairRate(reversed.stateBefore.averageRate).toFixed(2),
          detail:
            "Canonical sale boundary " +
            movement.movementId +
            " used its recorded transaction-time issue rate because that rate replayed quantity and total value exactly and the generic inverse selected a conflicting rate.",
        });
      }

      if (reversed.recovery === "CANONICAL_ADJUSTMENT_EDIT_VALUE") {
        checks.push({
          companyId,
          locationId: movement.locationId,
          stockItemId: movement.stockItemId,
          code: "CANONICAL_ADJUSTMENT_EDIT_VALUE_RECOVERED",
          status: "pass",
          expected:
            repairQuantity(stateAfter.quantity).toFixed(3) +
            "|" +
            repairMoney(stateAfter.totalValue).toFixed(2),
          actual:
            repairQuantity(stateAfter.quantity).toFixed(3) +
            "|" +
            repairMoney(stateAfter.totalValue).toFixed(2),
          detail:
            "Canonical stock-adjustment edit apply boundary " +
            movement.movementId +
            " recovered by adding back its persisted line value and replaying the source-specific consumption semantics exactly. Prior rate=" +
            repairRate(reversed.stateBefore.averageRate).toFixed(2),
        });
      }

      if (reversed.recovery === "LEGACY_RECEIPT_RATE_ONLY") {
        checks.push({
          companyId,
          locationId: movement.locationId,
          stockItemId: movement.stockItemId,
          code: "LEGACY_RECEIPT_RATE_ONLY_RECOVERED",
          status: "pass",
          expected:
            repairQuantity(stateAfter.quantity).toFixed(3) +
            "|" +
            repairMoney(stateAfter.totalValue).toFixed(2),
          actual:
            repairQuantity(stateAfter.quantity).toFixed(3) +
            "|" +
            repairMoney(stateAfter.totalValue).toFixed(2),
          detail:
            "Legacy offload boundary " +
            movement.movementId +
            " recovered from the exact stored offload total_value because replay reproduced quantity and total value exactly; only the reconstructed intermediate average-rate field disagreed. Prior rate=" +
            repairRate(reversed.stateBefore.averageRate).toFixed(2),
        });
      }

      // V33: only an original POS sale issue journals the locked live rate. An
      // edit re-issue journals the preserved old sale-line cost, so it is not
      // evidence about the inventory rate and must not be compared with it.
      if (
        movement.evidence === "canonical" &&
        CANONICAL_SALE_SOURCE_TYPES.has(movement.sourceType) &&
        !posJournalCostIsNotInventoryRate(movement) &&
        d(movement.quantityDelta).lt(0)
      ) {
        const recorded = repairRate(movement.unitCost ?? "0");
        const inferred = repairRate(reversed.stateBefore.averageRate);
        if (!recorded.eq(inferred)) {
          const unresolvedSales = (targetLegacySaleMovementsByKey.get(key) ?? []).filter(
            (saleMovement) =>
              compareMovementMutationAscending(saleMovement, movement) < 0 &&
              !forwardResetProvenSaleIds.has(saleMovement.sale!.salesItemId)
          );
          rewindBoundaryReached.add(key);
          if (unresolvedSales.length === 0) {
            checks.push({
              companyId,
              locationId: movement.locationId,
              stockItemId: movement.stockItemId,
              code: "CANONICAL_SALE_COST_EVIDENCE_MISMATCH",
              status: "warning",
              expected: recorded.toFixed(2),
              actual: inferred.toFixed(2),
              detail: `Canonical movement ${movement.movementId} disagrees with checkpoint rewind after all target legacy sales were already reconstructed`,
            });
          } else {
            for (const saleMovement of unresolvedSales) {
              checks.push({
                companyId,
                locationId: saleMovement.locationId,
                stockItemId: saleMovement.stockItemId,
                salesItemId: saleMovement.sale!.salesItemId,
                code: "CANONICAL_SALE_COST_EVIDENCE_MISMATCH",
                status: "block",
                expected: recorded.toFixed(2),
                actual: inferred.toFixed(2),
                detail: `Sales item ${saleMovement.sale!.salesItemId} predates canonical cost boundary ${movement.movementId}`,
              });
            }
          }
          continue;
        }
      }

      const afterQty = repairQuantity(stateAfter.quantity);
      const beforeQty = repairQuantity(reversed.stateBefore.quantity);
      let sensitivity =
        rewindSensitivity.get(key) ??
        (afterQty.gt(0) ? new Decimal(1).dividedBy(afterQty) : new Decimal(1));
      if (d(movement.quantityDelta).gt(0) && afterQty.gt(0) && beforeQty.gt(0)) {
        sensitivity = Decimal.min(sensitivity.times(afterQty).dividedBy(beforeQty), new Decimal("1e15"));
      }
      rewindSensitivity.set(key, sensitivity);

      if (movement.sale && !forwardResetProvenSaleIds.has(movement.sale.salesItemId)) {
        proposalsBySaleId.set(
          movement.sale.salesItemId,
          historicalSaleProposalFromState(movement, reversed.stateBefore)
        );
        const amplification = rewindAmplification.get(key) ?? {
          max: new Decimal(0),
          maxSalesItemId: movement.sale.salesItemId,
          proposals: 0,
          over10: 0,
          over100: 0,
        };
        amplification.proposals += 1;
        if (sensitivity.gt(REWIND_AMPLIFICATION_LIMIT)) {
          // V35: a reconstruction this ill-conditioned is not proven even when
          // every local inverse replays exactly: one cent of model drift near
          // the checkpoint moves this sale's cost by more than a dollar.
          checks.push({
            companyId,
            locationId: movement.locationId,
            stockItemId: movement.stockItemId,
            salesItemId: movement.sale.salesItemId,
            code: "LEGACY_REWIND_ERROR_AMPLIFICATION_EXCEEDED",
            status: "block",
            expected: `<=${REWIND_AMPLIFICATION_LIMIT.toFixed(0)}`,
            actual: sensitivity.toFixed(2),
            detail: `Sales item ${movement.sale.salesItemId} rewound cost moves ${sensitivity.toFixed(
              2
            )} cents per cent of checkpoint-side model error`,
          });
        }
        if (sensitivity.gt(10)) amplification.over10 += 1;
        if (sensitivity.gt(100)) amplification.over100 += 1;
        if (sensitivity.gt(amplification.max)) {
          amplification.max = sensitivity;
          amplification.maxSalesItemId = movement.sale.salesItemId;
        }
        rewindAmplification.set(key, amplification);
      }
      rewindStates.set(key, reversed.stateBefore);
    }

    for (const [key, amplification] of rewindAmplification) {
      if (!amplification.max.gt(1)) continue;
      const [, locationIdText, stockItemIdText] = key.split(":");
      checks.push({
        companyId,
        locationId: Number(locationIdText),
        stockItemId: Number(stockItemIdText),
        code: "REWIND_ERROR_AMPLIFICATION",
        status: "warning",
        expected: "<=1.00",
        actual: amplification.max.toFixed(2),
        detail: `Rewound rate moves up to ${amplification.max.toFixed(
          2
        )} cents per cent of checkpoint-side model error (worst: sales item ${amplification.maxSalesItemId}); ${
          amplification.proposals
        } rewound proposals, ${amplification.over10} above 10x, ${amplification.over100} above 100x`,
      });
    }

    for (const sale of legacySales) {
      if (!sale.location_id) continue;
      if (!proposalsBySaleId.has(Number(sale.sales_item_id))) {
        proposalsBySaleId.set(Number(sale.sales_item_id), originalProposalForSale(companyId, sale));
      }
    }

    const rewindReadyKeys =
      [...checkpointTargetKeys].filter((key) => !unavailableKeys.has(key)).length +
      mergedRecovery.recoveredKeys.size;
    checks.push({
      companyId,
      locationId: null,
      stockItemId: null,
      code: "CHECKPOINT_REWIND_COVERAGE",
      status: rewindReadyKeys === targetKeys.size ? "pass" : "warning",
      expected: String(targetKeys.size),
      actual: String(rewindReadyKeys),
      detail: "Legacy sale item/location keys with a fully provable checkpoint rewind",
    });
  }

  // V32: a moving weighted average is a convex combination of the rates that
  // fed it, so a reconstructed sale cost can never leave the range of every
  // rate the item ever carried. Run #33 marked legacy proposals of 536M/unit
  // (item normally ~107) "ready": a rewind chain amplified a small inverse
  // error geometrically while every local step still looked consistent. Any
  // reconstructed proposal outside the evidenced range proves the chain for
  // that item/location is wrong, so every legacy proposal there is blocked.
  checks.push(
    ...rateHullBlocks({
      companyId,
      proposals: [...proposalsBySaleId.values()],
      stockItems,
      canonical,
      legacy,
      offloadEvidence,
      checkpoint,
      historicalMerges,
    })
  );

  const proposals = [
    ...directCanonicalProposals.values(),
    ...proposalsBySaleId.values(),
  ].sort((a, b) => a.salesItemId - b.salesItemId);
  const report = {
    companyId,
    canonicalStart: canonicalStart ? canonicalStart.toISOString() : null,
    sourceCutoff: sourceCutoff.toISOString(),
    checkpointAt: checkpoint?.createdAt.toISOString() ?? null,
    checkpointMovementCutoffId: checkpoint?.movementCutoffId ?? null,
    sourceEvidenceHash,
    activeInventoryRows: inventoryResult.rows.length,
    checkpointRows: checkpoint?.rows.length ?? 0,
    stockItems: stockItems.length,
    canonicalMovements: canonical.length,
    legacyMovements: legacy.length + manual.movements.length,
    saleRows: sales.length,
    canonicalSaleRows: directCanonicalProposals.size,
    legacySaleRows: legacySales.length,
    historicalMerges: historicalMerges.length,
    exactOffloadEvidenceRows: offloadEvidence.length,
    valuationResetEvidenceRows: valuationResetMovements.length,
    proposedRows: proposals.length,
    changedSaleRows: proposals.filter((proposal) => proposal.changed).length,
    blockedItemLocations: distinctBlockedItemLocations(checks),
  };

  return { proposals, checks, report };
}

function proposalHashSource(
  proposal: HistoricalSalesRepairProposal,
  status: string,
  blockerCode?: string | null
): string {
  return [
    proposal.salesItemId,
    proposal.voucherId,
    proposal.companyId,
    proposal.locationId,
    proposal.stockItemId,
    proposal.occurredAt,
    proposal.originalCostPrice,
    proposal.originalTotalCost,
    proposal.originalProfit,
    proposal.proposedCostPrice,
    proposal.proposedTotalCost,
    proposal.proposedProfit,
    status,
    blockerCode ?? "",
  ].join("|");
}

async function persistProposalRows(
  client: PoolClient,
  runId: number,
  proposals: HistoricalSalesRepairProposal[],
  checks: RepairCheck[]
): Promise<void> {
  const blockers = buildRepairBlockerIndex(checks);

  const batchSize = 300;
  for (let offset = 0; offset < proposals.length; offset += batchSize) {
    const batch = proposals.slice(offset, offset + batchSize);
    const values: unknown[] = [];
    const placeholders = batch.map((proposal, index) => {
      const blocked = blockerForProposal(blockers, proposal);
      const status = blocked ? "blocked" : proposal.changed ? "ready" : "unchanged";
      const base = index * 20;
      values.push(
        runId,
        proposal.companyId,
        proposal.locationId,
        proposal.stockItemId,
        proposal.voucherId,
        proposal.salesItemId,
        proposal.occurredAt,
        proposal.evidence,
        proposal.sourceType,
        proposal.sourceId,
        proposal.originalCostPrice,
        proposal.originalTotalCost,
        proposal.originalProfit,
        proposal.proposedCostPrice,
        proposal.proposedTotalCost,
        proposal.proposedProfit,
        proposal.changed,
        status,
        blocked?.code ?? null,
        blocked?.detail ?? null
      );
      const p = Array.from({ length: 20 }, (_, i) => "$" + (base + i + 1));
      return `(${p.join(",")})`;
    });
    await client.query(
      `INSERT INTO historical_sales_cost_repair_rows
       (run_id,company_id,location_id,stock_item_id,voucher_id,sales_item_id,occurred_at,
        evidence,source_type,source_id,original_cost_price,original_total_cost,original_profit,
        proposed_cost_price,proposed_total_cost,proposed_profit,changed,status,blocker_code,
        blocker_detail)
       VALUES ${placeholders.join(",")}
       ON CONFLICT (run_id,sales_item_id) DO NOTHING`,
      values
    );
  }
}

async function persistChecks(client: PoolClient, runId: number, checks: RepairCheck[]): Promise<void> {
  const batchSize = 400;
  for (let offset = 0; offset < checks.length; offset += batchSize) {
    const batch = checks.slice(offset, offset + batchSize);
    const values: unknown[] = [];
    const placeholders = batch.map((check, index) => {
      const base = index * 9;
      values.push(
        runId,
        check.companyId,
        check.locationId,
        check.stockItemId,
        check.code,
        check.status,
        check.expected ?? null,
        check.actual ?? null,
        check.detail ?? null
      );
      return `(${Array.from({ length: 9 }, (_, i) => `$${base + i + 1}`).join(",")})`;
    });
    await client.query(
      `INSERT INTO historical_sales_cost_repair_checks
       (run_id,company_id,location_id,stock_item_id,check_code,status,expected_value,actual_value,detail)
       VALUES ${placeholders.join(",")}`,
      values
    );
  }
}

export type HistoricalSalesCostDryRunResult = {
  runId: number;
  status: "blocked" | "ready";
  auditHash: string;
  sourceCutoff: string;
  totalSalesRows: number;
  changedRows: number;
  blockedRows: number;
  blockedItemLocations: number;
  originalTotalCost: string;
  proposedTotalCost: string;
  originalTotalProfit: string;
  proposedTotalProfit: string;
  companies: Record<string, unknown>[];
};

export async function buildHistoricalSalesCostRepairDryRun(input: {
  createdBy: string;
  companyIds?: number[];
}): Promise<HistoricalSalesCostDryRunResult> {
  await ensureHistoricalSalesCostRepairSchema(pool);
  const client = await pool.connect();
  let runId = 0;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    await enableMaintenanceScope(client);
    await client.query("SELECT pg_advisory_xact_lock(hashtext('historical-sales-cost-repair-dry-run'))");

    const cutoffResult = await client.query<{ cutoff: Date }>("SELECT clock_timestamp() AS cutoff");
    const sourceCutoff = cutoffResult.rows[0].cutoff;
    const companyIds = await companyIdsForRun(client, input.companyIds);

    const created = await client.query<{ id: number }>(
      `INSERT INTO historical_sales_cost_repair_runs
       (algorithm_version,status,source_cutoff_at,requested_company_ids,created_by)
       VALUES ($1,'building',$2,$3,$4)
       RETURNING id`,
      [HISTORICAL_SALES_COST_REPAIR_ALGORITHM_VERSION, sourceCutoff, companyIds, input.createdBy]
    );
    runId = Number(created.rows[0].id);

    const companyReports: Record<string, unknown>[] = [];
    const allProposals: HistoricalSalesRepairProposal[] = [];
    const allChecks: RepairCheck[] = [];
    for (const companyId of companyIds) {
      const result = await dryRunCompany(client, companyId, sourceCutoff);
      companyReports.push(result.report);
      allProposals.push(...result.proposals);
      allChecks.push(...result.checks);
    }

    await persistChecks(client, runId, allChecks);
    await persistProposalRows(client, runId, allProposals, allChecks);

    const blockers = buildRepairBlockerIndex(allChecks);
    const blockedRows = allProposals.filter((proposal) => blockerForProposal(blockers, proposal)).length;
    const changedRows = allProposals.filter(
      (proposal) => proposal.changed && !blockerForProposal(blockers, proposal)
    ).length;

    // V34: run totals describe what apply would actually write. A blocked row
    // keeps its original values, so only unblocked proposals contribute their
    // proposed cost/profit. The rejected candidates of blocked rows are still
    // reported separately for diagnostics, but never mixed into the headline
    // totals (run #36 showed 3.2B "proposed" that lived entirely in blocked rows).
    const sumMoney = (
      proposals: HistoricalSalesRepairProposal[],
      field: "originalTotalCost" | "proposedTotalCost" | "originalProfit" | "proposedProfit"
    ) => repairMoney(proposals.reduce((sum, proposal) => sum.plus(proposal[field]), new Decimal(0)));
    const blockedProposals = allProposals.filter((proposal) => blockerForProposal(blockers, proposal));
    const applicableProposals = allProposals.filter((proposal) => !blockerForProposal(blockers, proposal));
    const originalTotalCost = sumMoney(allProposals, "originalTotalCost");
    const proposedTotalCost = repairMoney(
      sumMoney(applicableProposals, "proposedTotalCost").plus(sumMoney(blockedProposals, "originalTotalCost"))
    );
    const originalTotalProfit = sumMoney(allProposals, "originalProfit");
    const proposedTotalProfit = repairMoney(
      sumMoney(applicableProposals, "proposedProfit").plus(sumMoney(blockedProposals, "originalProfit"))
    );

    const hash = createHash("sha256");
    hash.update(HISTORICAL_SALES_COST_REPAIR_ALGORITHM_VERSION);
    hash.update("|");
    hash.update(sourceCutoff.toISOString());
    for (const proposal of [...allProposals].sort((a, b) => a.salesItemId - b.salesItemId)) {
      const blocked = blockerForProposal(blockers, proposal);
      hash.update("\n");
      hash.update(
        proposalHashSource(proposal, blocked ? "blocked" : proposal.changed ? "ready" : "unchanged", blocked?.code)
      );
    }
    for (const check of [...allChecks].sort((a, b) =>
      [a.companyId, a.locationId ?? 0, a.stockItemId ?? 0, a.salesItemId ?? 0, a.code]
        .join(":")
        .localeCompare(
          [b.companyId, b.locationId ?? 0, b.stockItemId ?? 0, b.salesItemId ?? 0, b.code].join(":")
        )
    )) {
      hash.update("\ncheck|");
      hash.update(JSON.stringify(check));
    }
    const auditHash = hash.digest("hex");
    const status: "blocked" | "ready" = allChecks.some((check) => check.status === "block") ? "blocked" : "ready";

    const report = {
      algorithmVersion: HISTORICAL_SALES_COST_REPAIR_ALGORITHM_VERSION,
      sourceCutoff: sourceCutoff.toISOString(),
      companies: companyReports,
      totals: {
        basis: "apply-effective: unblocked rows at proposed values, blocked rows at original values",
        applicableRows: applicableProposals.length,
        applicableOriginalTotalCost: sumMoney(applicableProposals, "originalTotalCost").toFixed(2),
        applicableProposedTotalCost: sumMoney(applicableProposals, "proposedTotalCost").toFixed(2),
        blockedRows: blockedProposals.length,
        blockedOriginalTotalCost: sumMoney(blockedProposals, "originalTotalCost").toFixed(2),
        blockedRejectedCandidateTotalCost: sumMoney(blockedProposals, "proposedTotalCost").toFixed(2),
      },
      checks: {
        total: allChecks.length,
        pass: allChecks.filter((check) => check.status === "pass").length,
        warning: allChecks.filter((check) => check.status === "warning").length,
        block: allChecks.filter((check) => check.status === "block").length,
      },
    };

    await client.query(
      `UPDATE historical_sales_cost_repair_runs
          SET status=$2,
              completed_at=NOW(),
              audit_hash=$3,
              total_sales_rows=$4,
              changed_rows=$5,
              blocked_rows=$6,
              blocked_item_locations=$7,
              original_total_cost=$8,
              proposed_total_cost=$9,
              original_total_profit=$10,
              proposed_total_profit=$11,
              report=$12::jsonb
        WHERE id=$1`,
      [
        runId,
        status,
        auditHash,
        allProposals.length,
        changedRows,
        blockedRows,
        distinctBlockedItemLocations(allChecks),
        originalTotalCost.toFixed(2),
        proposedTotalCost.toFixed(2),
        originalTotalProfit.toFixed(2),
        proposedTotalProfit.toFixed(2),
        JSON.stringify(report),
      ]
    );

    await client.query("COMMIT");

    logger.info("Historical sales cost repair dry-run complete", {
      module: "historical-sales-cost-repair",
      action: "dry-run",
      runId,
      status,
      auditHash,
      companies: companyIds.length,
      totalSalesRows: allProposals.length,
      changedRows,
      blockedRows,
    });

    return {
      runId,
      status,
      auditHash,
      sourceCutoff: sourceCutoff.toISOString(),
      totalSalesRows: allProposals.length,
      changedRows,
      blockedRows,
      blockedItemLocations: distinctBlockedItemLocations(allChecks),
      originalTotalCost: originalTotalCost.toFixed(2),
      proposedTotalCost: proposedTotalCost.toFixed(2),
      originalTotalProfit: originalTotalProfit.toFixed(2),
      proposedTotalProfit: proposedTotalProfit.toFixed(2),
      companies: companyReports,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (runId) {
      await pool
        .query(
          `UPDATE historical_sales_cost_repair_runs
            SET status='failed',completed_at=NOW(),error=$2
          WHERE id=$1 AND status='building'`,
          [runId, error instanceof Error ? error.message : String(error)]
        )
        .catch(() => undefined);
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function getHistoricalSalesCostRepairRun(runId: number): Promise<Record<string, unknown> | null> {
  await ensureHistoricalSalesCostRepairSchema(pool);
  const run = await pool.query(
    `SELECT id,algorithm_version,status,source_cutoff_at,requested_company_ids,created_by,created_at,
            completed_at,applied_by,applied_at,audit_hash,total_sales_rows,changed_rows,blocked_rows,
            blocked_item_locations,original_total_cost,proposed_total_cost,original_total_profit,
            proposed_total_profit,report,error
       FROM historical_sales_cost_repair_runs
      WHERE id=$1`,
    [runId]
  );
  if (!run.rows[0]) return null;

  const [blockers, monthly, rowStatus] = await Promise.all([
    pool.query(
      `SELECT company_id,location_id,stock_item_id,check_code,status,expected_value,actual_value,detail
         FROM historical_sales_cost_repair_checks
        WHERE run_id=$1 AND status IN ('block','warning')
        ORDER BY company_id,stock_item_id,location_id NULLS FIRST,check_code
        LIMIT 500`,
      [runId]
    ),
    pool.query(
      `SELECT company_id,
              to_char(date_trunc('month',occurred_at),'YYYY-MM') AS month,
              COUNT(*)::int AS sale_lines,
              COUNT(*) FILTER (WHERE changed)::int AS changed_lines,
              SUM(original_total_cost)::text AS original_cogs,
              SUM(proposed_total_cost)::text AS proposed_cogs,
              SUM(original_profit)::text AS original_profit,
              SUM(proposed_profit)::text AS proposed_profit
         FROM historical_sales_cost_repair_rows
        WHERE run_id=$1
        GROUP BY company_id,date_trunc('month',occurred_at)
        ORDER BY company_id,month`,
      [runId]
    ),
    pool.query(
      `SELECT status,COUNT(*)::int AS rows
         FROM historical_sales_cost_repair_rows
        WHERE run_id=$1
        GROUP BY status
        ORDER BY status`,
      [runId]
    ),
  ]);
  return {
    ...run.rows[0],
    blockers: blockers.rows,
    monthlyReconciliation: monthly.rows,
    rowStatus: rowStatus.rows,
  };
}

export async function applyHistoricalSalesCostRepair(input: {
  runId: number;
  auditHash: string;
  appliedBy: string;
}): Promise<{ runId: number; appliedRows: number; auditHash: string }> {
  await ensureHistoricalSalesCostRepairSchema(pool);
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await enableMaintenanceScope(client);
    await client.query("SELECT pg_advisory_xact_lock(hashtext('historical-sales-cost-repair-apply'))");

    const runResult = await client.query<{
      id: number;
      status: string;
      audit_hash: string;
      algorithm_version: string;
      blocked_rows: number;
      source_cutoff_at: Date;
      requested_company_ids: number[] | null;
    }>(
      `SELECT id,status,audit_hash,algorithm_version,blocked_rows,source_cutoff_at,requested_company_ids
         FROM historical_sales_cost_repair_runs
        WHERE id=$1
        FOR UPDATE`,
      [input.runId]
    );
    const run = runResult.rows[0];
    if (!run) throw hscrError("HSCR_RUN_NOT_FOUND");
    if (run.algorithm_version !== HISTORICAL_SALES_COST_REPAIR_ALGORITHM_VERSION) {
      throw hscrError("HSCR_ALGORITHM_VERSION_MISMATCH");
    }
    if (run.status !== "ready") {
      throw hscrError(`HSCR_RUN_NOT_READY:${input.runId}:${run.status}`);
    }
    if (!run.audit_hash || run.audit_hash !== input.auditHash) {
      throw hscrError("HSCR_AUDIT_HASH_MISMATCH");
    }

    const blockerCount = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM historical_sales_cost_repair_checks
        WHERE run_id=$1 AND status='block'`,
      [input.runId]
    );
    if (Number(blockerCount.rows[0]?.count ?? 0) !== 0) {
      throw hscrError("HSCR_RUN_HAS_BLOCKERS");
    }

    const targetCompanyIds = (run.requested_company_ids ?? []).map(Number);
    if (targetCompanyIds.length === 0) {
      throw hscrError("HSCR_RUN_SCOPE_EMPTY");
    }

    // Recompute the exact V2 evidence bundle that was reviewed during dry-run.
    // This pins the immutable checkpoint/cutoff, canonical + legacy movements,
    // merge aliases/source openings, and every target sale original.
    const evidenceChecks = await client.query<{ company_id: number; expected_value: string }>(
      `SELECT company_id,expected_value
         FROM historical_sales_cost_repair_checks
        WHERE run_id=$1
          AND check_code='V2_SOURCE_EVIDENCE_HASH'
          AND status='pass'
        ORDER BY company_id`,
      [input.runId]
    );
    const expectedEvidenceByCompany = new Map(
      evidenceChecks.rows.map((row) => [Number(row.company_id), String(row.expected_value)])
    );
    if (expectedEvidenceByCompany.size !== targetCompanyIds.length) {
      throw hscrError("HSCR_V2_EVIDENCE_HASH_SCOPE_MISMATCH");
    }
    for (const companyId of targetCompanyIds) {
      const expected = expectedEvidenceByCompany.get(companyId);
      if (!expected) throw hscrError(`HSCR_V2_EVIDENCE_HASH_MISSING:${companyId}`);
      const actual = await recomputeHistoricalSalesCompanyEvidenceHash(client, companyId, run.source_cutoff_at);
      if (actual !== expected) {
        throw hscrError(`HSCR_V2_SOURCE_EVIDENCE_DRIFT:${companyId}`);
      }
    }

    await assertSalesItemsUpdateHasNoSideEffectTriggers(client);
    const inventoryBeforeApply = await inventoryEvidenceFingerprint(client, targetCompanyIds);

    // Keep targeted "changed-after-cutoff" checks as a second line of defense.
    // Normal new stock activity after the source cutoff is allowed.
    const sourceDrift = await client.query<{
      kind: string;
      evidence_id: string;
    }>(
      `SELECT 'backdated-canonical'::text AS kind,id::text AS evidence_id
         FROM canonical_stock_movements
        WHERE company_id = ANY($1::int[])
          AND created_at > $2
          AND occurred_at <= $2
        UNION ALL
       SELECT 'historical-voucher-edit'::text AS kind,a.id::text AS evidence_id
         FROM audit_log a
         JOIN vouchers v
           ON a.table_name='vouchers'
          AND a.record_id=v.id
          AND v.company_id=a.company_id
        WHERE a.company_id = ANY($1::int[])
          AND a.created_at > $2
          AND v.created_at <= $2
        UNION ALL
       SELECT 'historical-container-edit'::text AS kind,a.id::text AS evidence_id
         FROM audit_log a
         JOIN containers c
           ON a.table_name='containers'
          AND a.record_id=c.id
          AND c.company_id=a.company_id
        WHERE a.company_id = ANY($1::int[])
          AND a.created_at > $2
          AND c.created_at <= $2
        ORDER BY kind,evidence_id
        LIMIT 25`,
      [targetCompanyIds, run.source_cutoff_at]
    );
    if (sourceDrift.rows.length > 0) {
      throw new Error(
        `Historical sales cost repair source evidence changed after dry run: ${sourceDrift.rows
          .map((row) => `${row.kind}#${row.evidence_id}`)
          .join(", ")}. Build and review a new dry run.`
      );
    }

    const drift = await client.query<{ sales_item_id: number }>(
      `SELECT r.sales_item_id
         FROM historical_sales_cost_repair_rows r
         LEFT JOIN sales_items si ON si.id=r.sales_item_id
        WHERE r.run_id=$1
          AND r.status='ready'
          AND (
            si.id IS NULL
            OR si.cost_price IS DISTINCT FROM r.original_cost_price
            OR si.total_cost IS DISTINCT FROM r.original_total_cost
            OR si.profit IS DISTINCT FROM r.original_profit
          )
        ORDER BY r.sales_item_id
        LIMIT 25`,
      [input.runId]
    );
    if (drift.rows.length > 0) {
      throw new Error(
        `Historical sales cost repair refused because target sale rows changed after dry run: ${drift.rows
          .map((row) => row.sales_item_id)
          .join(", ")}`
      );
    }

    await client.query(
      `UPDATE historical_sales_cost_repair_runs
          SET status='applying',applied_by=$2
        WHERE id=$1`,
      [input.runId, input.appliedBy]
    );

    await client.query(
      `INSERT INTO historical_sales_cost_repair_apply_log
       (run_id,company_id,sales_item_id,before_cost_price,before_total_cost,before_profit,
        after_cost_price,after_total_cost,after_profit,applied_by)
       SELECT r.run_id,r.company_id,r.sales_item_id,
              r.original_cost_price,r.original_total_cost,r.original_profit,
              r.proposed_cost_price,r.proposed_total_cost,r.proposed_profit,$2
         FROM historical_sales_cost_repair_rows r
        WHERE r.run_id=$1 AND r.status='ready'
       ON CONFLICT (run_id,sales_item_id) DO NOTHING`,
      [input.runId, input.appliedBy]
    );

    const updated = await client.query(
      `UPDATE sales_items si
          SET cost_price=r.proposed_cost_price,
              total_cost=r.proposed_total_cost,
              profit=r.proposed_profit
         FROM historical_sales_cost_repair_rows r
        WHERE r.run_id=$1
          AND r.status='ready'
          AND r.sales_item_id=si.id
        RETURNING si.id`,
      [input.runId]
    );

    await client.query(
      `UPDATE historical_sales_cost_repair_rows
          SET status='applied',applied_at=NOW()
        WHERE run_id=$1 AND status='ready'`,
      [input.runId]
    );

    const verify = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM historical_sales_cost_repair_rows r
         JOIN sales_items si ON si.id=r.sales_item_id
        WHERE r.run_id=$1
          AND r.status='applied'
          AND (
            si.cost_price IS DISTINCT FROM r.proposed_cost_price
            OR si.total_cost IS DISTINCT FROM r.proposed_total_cost
            OR si.profit IS DISTINCT FROM r.proposed_profit
          )`,
      [input.runId]
    );
    if (Number(verify.rows[0]?.count ?? 0) !== 0) {
      throw hscrError("HSCR_POST_APPLY_VERIFY_FAILED");
    }

    const inventoryAfterApply = await inventoryEvidenceFingerprint(client, targetCompanyIds);
    if (
      inventoryAfterApply.hash !== inventoryBeforeApply.hash ||
      inventoryAfterApply.rowCount !== inventoryBeforeApply.rowCount
    ) {
      throw hscrError("HSCR_INVENTORY_CHANGED_DURING_APPLY");
    }

    await client.query(
      `UPDATE historical_sales_cost_repair_runs
          SET status='applied',
              applied_at=NOW(),
              completed_at=NOW(),
              report=COALESCE(report,'{}'::jsonb) || jsonb_build_object(
                'applyInventorySnapshot',
                jsonb_build_object(
                  'beforeHash',$2::text,
                  'afterHash',$3::text,
                  'rowCount',$4::int,
                  'unchanged',true
                )
              )
        WHERE id=$1`,
      [input.runId, inventoryBeforeApply.hash, inventoryAfterApply.hash, inventoryAfterApply.rowCount]
    );

    await client.query("COMMIT");

    logger.info("Historical sales cost repair applied", {
      module: "historical-sales-cost-repair",
      action: "apply",
      runId: input.runId,
      auditHash: input.auditHash,
      appliedRows: updated.rowCount ?? 0,
      appliedBy: input.appliedBy,
    });

    return {
      runId: input.runId,
      appliedRows: updated.rowCount ?? 0,
      auditHash: input.auditHash,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
