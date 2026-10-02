/** Shared row types, constants and small helpers for the historical sales-cost repair. */
import Decimal from "decimal.js";

import {
  repairMoney,
  repairQuantity,
  repairRate,
  type HistoricalInventoryState,
  type HistoricalSalesRepairMovement,
  type HistoricalSalesRepairProposal,
} from "./historicalSalesCostRepairEngine";

export type RepairCheck = {
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

export type InventoryRow = {
  location_id: number;
  stock_item_id: number;
  quantity: string;
  average_rate: string;
  total_value: string;
};

export type ValuationCheckpoint = {
  movementCutoffId: number;
  createdAt: Date;
  rows: InventoryRow[];
};

export type StockItemRow = {
  id: number;
  code: string | null;
  opening_qty: string;
  opening_rate: string;
  opening_value: string;
  active: boolean;
  deleted_at: Date | null;
  created_at: Date;
};

export type HistoricalMergeRow = {
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

export type CanonicalRow = {
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

export type SaleRow = {
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

export type LegacyRow = {
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

export type OffloadValueEvidenceRow = {
  offload_id: number;
  stock_item_id: number;
  quantity: string;
  rate: string;
  total_value: string;
  offloaded_at: Date;
};

export type AuditInventoryRow = {
  id: number;
  stock_item_id: number | null;
  location_name: string | null;
  old_quantity: string | null;
  new_quantity: string | null;
  created_at: Date;
};

export type CompanyDryRun = {
  proposals: HistoricalSalesRepairProposal[];
  checks: RepairCheck[];
  report: Record<string, unknown>;
};

export const QTY_TOLERANCE = new Decimal("0.001");

export const REWIND_TRACE_LIMIT = 160;

export const MONEY_TOLERANCE = new Decimal("0.02");

export const OFFLOAD_EVIDENCE_SOURCE_TYPES = new Set([
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

export const HISTORICAL_VALUATION_RESETS: HistoricalValuationResetEvidence[] = [
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

export type ValuationOverrideRow = {
  id: number;
  location_id: number;
  stock_item_id: number;
  source_type: string;
  before_quantity: string;
  before_average_rate: string;
  before_total_value: string;
  after_quantity: string;
  after_average_rate: string;
  after_total_value: string;
  created_at: Date;
};

export function offloadEvidenceKey(offloadId: string | number, stockItemId: string | number): string {
  return `${String(offloadId)}:${Number(stockItemId)}`;
}

export function legacyInverseNotUniqueBlock(
  companyId: number,
  movement: HistoricalSalesRepairMovement,
  primaryBefore: HistoricalInventoryState,
  alternatives: HistoricalInventoryState[],
  path: string
): RepairCheck {
  return {
    companyId,
    locationId: movement.locationId,
    stockItemId: movement.stockItemId,
    salesItemId: movement.sale!.salesItemId,
    code: "LEGACY_SALE_INVERSE_NOT_UNIQUE",
    status: "block",
    expected: repairRate(primaryBefore.averageRate).toFixed(2),
    actual: alternatives.map((candidate) => repairRate(candidate.averageRate).toFixed(2)).join(","),
    detail: `Sales item ${movement.sale!.salesItemId}: the ${path} admits more than one exact pre-sale rate, so its cost is not uniquely proven`,
  };
}

export function reanchorCodePrefix(
  transition: "UNRECORDED_REVALUATION" | "COST_MEMORY_RESET" | "COLLAPSED_POS_LINES"
): string {
  if (transition === "UNRECORDED_REVALUATION") return "LEGACY_UNRECORDED_REVALUATION";
  if (transition === "COST_MEMORY_RESET") return "LEGACY_COST_MEMORY_RESET";
  return "LEGACY_COLLAPSED_POS_LINES";
}

export function traceState(state: HistoricalInventoryState): string {
  return (
    repairQuantity(state.quantity).toFixed(3) +
    "|" +
    repairRate(state.averageRate).toFixed(2) +
    "|" +
    repairMoney(state.totalValue).toFixed(2)
  );
}

export function hscrError(code: string): Error {
  const error = new Error();
  error.message = code;
  return error;
}

export function d(value: Decimal.Value | null | undefined): Decimal {
  const parsed = new Decimal(value ?? 0);
  if (!parsed.isFinite()) throw hscrError(`HSCR_NON_FINITE_VALUE:${String(value)}`);
  return parsed;
}

export function iso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw hscrError(`HSCR_INVALID_TIMESTAMP:${String(value)}`);
  return date.toISOString();
}

export function beforeCutoff(value: Date, canonicalStart: Date | null): boolean {
  return canonicalStart === null || value.getTime() < canonicalStart.getTime();
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

export function buildRepairBlockerIndex(checks: RepairCheck[]): RepairBlockerIndex {
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

export function blockerForProposal(
  blockers: RepairBlockerIndex,
  proposal: Pick<HistoricalSalesRepairProposal, "salesItemId" | "companyId" | "locationId" | "stockItemId" | "evidence">
): RepairCheck | undefined {
  const saleSpecific = blockers.saleSpecific.get(proposal.salesItemId);
  if (saleSpecific) return saleSpecific;

  const locationKey = `${proposal.companyId}:${proposal.locationId}:${proposal.stockItemId}`;
  const itemKey = `${proposal.companyId}:${proposal.stockItemId}`;
  const general = blockers.locationSpecific.get(locationKey) ?? blockers.itemWide.get(itemKey);
  if (general) return general;

  if (proposal.evidence === "legacy") {
    return blockers.legacyLocationSpecific.get(locationKey) ?? blockers.legacyItemWide.get(itemKey);
  }
  return undefined;
}

export function distinctBlockedItemLocations(checks: RepairCheck[]): number {
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

export const CANONICAL_SALE_SOURCE_TYPES = new Set(["pos-sale", "pos-import", "credit-sales-import"]);

export type RewindAlternate = { state: HistoricalInventoryState; history: Map<number, HistoricalSalesRepairProposal> };

export type ReanchorRequest = {
  key: string;
  anchor: HistoricalSalesRepairMovement;
  beforeQuantity: Decimal;
  recorded: Decimal;
  inferred: Decimal;
  unresolvedSales: HistoricalSalesRepairMovement[];
  transition: "UNRECORDED_REVALUATION" | "COST_MEMORY_RESET" | "COLLAPSED_POS_LINES";
  transitionMovementId: string;
};

export type LegacyInverseAmbiguity = { sales: number; maxSpread: Decimal };

export type RewindAmplification = {
  max: Decimal;
  maxSalesItemId: number;
  proposals: number;
  over10: number;
  over100: number;
};
