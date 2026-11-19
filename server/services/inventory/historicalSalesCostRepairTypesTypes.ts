// Extracted from ./historicalSalesCostRepairTypes.ts
import Decimal from "decimal.js";
import {
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

export type HistoricalValuationResetEvidence = {
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

export type RepairBlockerIndex = {
  saleSpecific: Map<number, RepairCheck>;
  itemWide: Map<string, RepairCheck>;
  locationSpecific: Map<string, RepairCheck>;
  legacyItemWide: Map<string, RepairCheck>;
  legacyLocationSpecific: Map<string, RepairCheck>;
};

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
