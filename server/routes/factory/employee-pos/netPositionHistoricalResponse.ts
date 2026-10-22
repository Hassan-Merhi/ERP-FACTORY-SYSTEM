/**
 * The last step of GET /api/factory/net-position: a past date gets its dated
 * stock overlay, totals rebuilt from the displayed rows, the integrity guard
 * and readable warnings. Today's body is returned with only the date
 * metadata added.
 */
import type { FactoryNetPositionAsOf } from "@shared/factoryNetPositionAsOf";
import { reconcileHistoricalPosition, sumPositionRows } from "../../../services/factory/netPositionReportTotals";
import { assertHistoricalReportIntegrity } from "../../../services/factory/netPositionHistoricalIntegrity";
import type { FactoryHistoricalCoverage } from "../../../services/factory/netPositionHistoryCoverage";
import { applyHistoricalOperationalCorrection } from "./netPositionHistoricalCorrection";

const HISTORICAL_WARNING_TEXT: Record<string, string> = {
  HISTORICAL_RAW_UNPRICED_RECEIPT: "Some older raw-material receipts have no confirmed historical USD unit cost.",
  HISTORICAL_RAW_ADJUSTMENT_BASIS_MISSING: "Some older raw-material additions lack a recorded valuation basis.",
  HISTORICAL_RAW_CONSUMPTION_EXCEEDS_RECEIPTS: "Recorded material consumption exceeds available dated receipt history.",
  HISTORICAL_RAW_LEGACY_RECEIPT_FALLBACK:
    "Some material receipts use legacy cumulative records instead of individual receipt events.",
  HISTORICAL_RAW_LEGACY_DEDUCT_MUTATED_RECEIPT:
    "A legacy raw-material deduction changed a cumulative receipt; its earlier quantity needs audit reconstruction.",
  HISTORICAL_RAW_SOURCE_OWNER_UNKNOWN:
    "Some historic mix materials cannot be assigned reliably to their original supplier.",
  HISTORICAL_RAW_LOCKED_RATE_UNVERSIONED:
    "A supplier's locked raw-material rate changed after the selected date; its earlier stock is valued at the replayed moving-average cost.",
  HISTORICAL_RAW_NEGATIVE_MOVEMENT: "An invalid negative material movement needs historical review.",
  HISTORICAL_STOCK_SCAN_TIME_MISSING: "Some older bale scans have no reliable scan timestamp.",
  HISTORICAL_STOCK_FINALIZATION_TIME_MISSING:
    "Some older bales have no recorded stock-entry (finalization) time; their stock-entry, pressing or creation date is used instead.",
  HISTORICAL_STOCK_REMOVAL_TIME_UNKNOWN: "Some removed/repacked bales have no reliable removal or repack time.",
  HISTORICAL_STOCK_SELLING_PRICE_UNVERSIONED:
    "Historical selling prices are not versioned; the selling-price view uses today's catalogue prices.",
  HISTORICAL_STOCK_COST_EDITS_NOT_VERSIONED:
    "Stock In Hand uses the current catalogue production prices, as today's report does; earlier catalogue price edits are not versioned.",
  HISTORICAL_WIP_BALE_LIFECYCLE_UNVERSIONED:
    "Balance on Table may include earlier baled weight whose subsequent removal/repacking cannot be timed from legacy status-only records.",
  HISTORICAL_OTW_STATUS_HISTORY_MISSING:
    "Some containers have no dated cancellation or status history; their earlier eligibility requires review.",
  HISTORICAL_OTW_LEGACY_OFFLOAD:
    "A container offload uses a legacy cumulative stock record because individual receipt events are missing.",
  HISTORICAL_OTW_PLANNED_WEIGHT_MISSING:
    "Some containers have no reliable planned weight, so their historical OTW amount cannot be calculated.",
  HISTORICAL_OTW_RECEIPTS_EXCEED_PLAN: "Dated receipts exceed their container's currently recorded planned weight.",
  HISTORICAL_OTW_GOODS_RATE_UNVERSIONED:
    "A container lacks an original per-kg goods rate; its current final-payable amount was used provisionally.",
  HISTORICAL_OTW_CHARGES_UNVERSIONED:
    "A container offloaded after the selected date has no pre-offload charge snapshot; its current freight/commission/charges were used provisionally.",
  HISTORICAL_OTW_MASTER_VALUES_UNVERSIONED:
    "Historical container planned quantities and source price edits are not fully versioned.",
  HISTORICAL_ORDER_LIFECYCLE_UNVERSIONED:
    "Some older orders lack dated loading/verification status transitions and cannot be included reliably.",
  HISTORICAL_ORDER_BACKDATED_VERIFICATION_UNPROVEN:
    "Some order verification dates were entered retrospectively, but no corresponding event recorded by the selected day remains.",
  HISTORICAL_ORDER_FINALIZATION_MISSING: "Some finalized orders have no trustworthy finalization timestamp.",
  HISTORICAL_ORDER_RESTORE_TIME_UNKNOWN: "Some bale scans were restored without a separately dated restoration event.",
  HISTORICAL_ORDER_SCAN_TIME_MISSING: "Older bale scans with no timestamp cannot be assigned to a prior day.",
  HISTORICAL_ORDER_CHARGES_UNVERSIONED:
    "Order freight and charges lack creation/version timestamps, so historical scan totals exclude these unproven charges.",
  HISTORICAL_ORDER_SCAN_PRICE_EDITS_UNVERSIONED:
    "An earlier scanned bale's price may have been edited without retaining the original version.",
  HISTORICAL_WORKER_ADVANCE_EDITS_UNVERSIONED:
    "Historical worker advances are rebuilt from original amounts, dated repayments and payroll deductions; edits and deleted repayments or payrolls are not recoverable.",
  HISTORICAL_RENT_EXPECTED_AMOUNTS_UNVERSIONED:
    "Historical rent expected amounts can have been edited without retaining original values.",
  HISTORICAL_RENT_CONTRACT_STATUS_UNVERSIONED:
    "Contract status changes lack a timeline; a contract that is no longer active counts only while its own term covered the selected date.",
  HISTORICAL_RENT_VOID_DATE_UNAVAILABLE:
    "Rental payment void times are unavailable; their previous posting history may be incomplete.",
  HISTORICAL_RENT_POSTING_TIMESTAMP_MISSING:
    "Older posted rent payments lack posting timestamps; the creation date is used provisionally.",
  HISTORICAL_LEDGER_OPENINGS_UNVERSIONED:
    "Historical asset, deposit and loan account opening balances/types lack full version history.",
};

type Row = { name: string; code: string; value: number; category: string };
type Side = { total: number; breakdown: Array<{ name: string; value: number }>; accounts: Row[] };
type NetPositionBody = {
  forUs: Side;
  onUs: Side;
  forUsTotal: number;
  onUsTotal: number;
  netPosition: number;
  netPositionLabel: string;
  inventoryValue: number;
  rawMaterialValue: number;
  balanceOnTableValue: number;
  stockOtwValue: number;
  payrollPayable: number;
  supplierLiabilities: number;
  supplierOverpayments: number;
  pendingOrders: Array<{ grandTotal: number }>;
  verifiedOrders: Array<{ grandTotal: number }>;
  loadingOrders: Array<{ grandTotal: number }>;
  pendingTotal: number;
  verifiedTotal: number;
  loadingTotal: number;
};

export async function finishFactoryNetPosition<T extends NetPositionBody>(input: {
  companyId: number;
  scope: FactoryNetPositionAsOf;
  body: T;
  valuationMode: "cost" | "selling";
  historyCoverage: FactoryHistoricalCoverage | null;
  pipelineWarnings: readonly string[];
  assetWarnings: readonly string[];
}) {
  const { companyId, scope, valuationMode, historyCoverage } = input;
  const dateFields = {
    companyId,
    businessToday: scope.businessToday,
    timeZone: scope.timeZone,
    historyBasis: scope.historyBasis,
    historyCoverage,
  };
  if (!scope.isHistorical) {
    return { ...input.body, ...dateFields, historyCompleteness: "current" as const, historyWarnings: [] as string[] };
  }
  // Explicit, awaited operation rather than rewriting res.json in
  // middleware. Any failure MUST be an error, never today's figures
  // falsely presented under yesterday's heading.
  const projected = await applyHistoricalOperationalCorrection(companyId, scope, input.body, valuationMode);
  // A SINGLE dated response is authoritative for overview, details, custom
  // subtotals and all expanded groups.
  const dated = reconcileHistoricalPosition(projected);
  // Financial summary fields must sum the same rounded currency rows as
  // the displayed supplier subaccounts; no separate float accumulation.
  dated.supplierLiabilities = sumPositionRows(dated.onUs.accounts.filter((row) => row.code === "SUPPLIER"));
  dated.supplierOverpayments = sumPositionRows(dated.forUs.accounts.filter((row) => row.code === "SUPPLIER_OVERPAID"));
  assertHistoricalReportIntegrity(dated);
  const inventoryWarnings = (dated as T & { inventoryHistoryWarnings?: string[] }).inventoryHistoryWarnings ?? [];
  const text = (code: string) => HISTORICAL_WARNING_TEXT[code] ?? code;
  return {
    ...dated,
    ...dateFields,
    historyCompleteness: "partial" as const,
    historyWarnings: [
      "Historical category reconstruction remains partial until all operational and financial events are reconciled.",
      ...inventoryWarnings.map(text),
      ...input.pipelineWarnings.map(text),
      ...input.assetWarnings.map(text),
      HISTORICAL_WARNING_TEXT.HISTORICAL_LEDGER_OPENINGS_UNVERSIONED,
      ...(historyCoverage?.gaps ?? []).map(
        (gap) => `${gap.category}: ${gap.explanation} (${gap.records} record${gap.records === 1 ? "" : "s"})`
      ),
    ],
  };
}
