// Extracted from ./mixPhase4ProvenanceAudit.ts
import Decimal from "decimal.js";

export type Money = string | number | null;

export const dec = (v: Money) => new Decimal(v ?? "0");

export const fix = (v: Decimal, p = 3) => v.toDecimalPlaces(p).toFixed(p);

export interface RawRow {
  raw_stock_id: number;
  container_id: number;
  container_number: string | null;
  company_id: number;
  supplier_id: number | null;
  supplier_name: string | null;
  received_kg: string;
  used_kg: string;
  cost_per_kg_usd: string | null;
  offloaded_at: string;
}

export interface OwnershipRow {
  batch_id: number;
  batch_code: string;
  batch_status: string;
  source_id: number;
  source_type: string | null;
  source_supplier_id: number | null;
  inventory_supplier_id: number | null;
  container_supplier_id: number | null;
  container_id: number;
  container_number: string | null;
  container_company_id: number | null;
  source_weight_kg: string;
  source_rate_usd: string;
  source_total_usd: string;
}

export interface AdjustmentRow {
  id: number;
  supplier_id: number | null;
  supplier_name: string | null;
  date: string;
  type: string;
  kg: string;
  cost_per_kg: string | null;
  currency_code: string | null;
  valuation_basis: string | null;
  reference: string | null;
  notes: string | null;
}

export interface SupplierOnlyRow {
  supplier_id: number | null;
  total_kg: string;
  source_count: number;
}

export type RawStockCoverage = "NON_NEGATIVE" | "POTENTIALLY_ADJUSTMENT_BACKED" | "UNBACKED_SHORTAGE";

export interface SupplierStockBalanceReview {
  supplierId: number | null;
  supplierName: string | null;
  receivedContainerKg: string;
  usedContainerKg: string;
  rawRowOverdrawKg: string;
  addAdjustmentKg: string;
  deductAdjustmentKg: string;
  netSupplierKg: string;
  coverage: RawStockCoverage;
  // An ADD matching the receipt-row overdraw is not proof of correct allocation
  // at the historical event date, only evidence for separate timeline review.
  explanation: string;
  affectedRawStockIds: number[];
}

export interface RawStockException {
  rawStockId: number;
  supplierId: number | null;
  containerId: number;
  containerNumber: string | null;
  receivedKg: string;
  usedKg: string;
  excessUsedKg: string;
  stockValueRateUsd: string | null;
  supplierCoverage: RawStockCoverage;
}

export interface OwnershipException {
  batchId: number;
  batchCode: string;
  batchStatus: string;
  sourceId: number;
  containerId: number;
  containerNumber: string | null;
  pricingSupplierId: number | null;
  recordedInventorySupplierId: number | null;
  currentContainerSupplierId: number | null;
  sourceWeightKg: string;
  recordedRateUsd: string;
  recordedSourceTotalUsd: string;
  currentContainerCompanyId: number | null;
  classification: "REQUIRES_HISTORICAL_TRANSFER_PROOF" | "CROSS_COMPANY_REFERENCE";
  readOnly: true;
}

export interface AdjustmentEvidenceException {
  adjustmentId: number;
  date: string;
  supplierId: number | null;
  supplierName: string | null;
  type: string;
  kg: string;
  recordedCostPerKg: string;
  currency: string;
  basis: string | null;
  reference: string | null;
  notes: string | null;
  classification: "FX_AND_BASIS_EVIDENCE_REQUIRED" | "BASIS_EVIDENCE_REQUIRED";
}

export interface Phase4SourceProvenanceReport {
  companyId: number;
  generatedAt: string;
  readOnly: true;
  summary: {
    rawStockRows: number;
    rawStockOverdrawRows: number;
    totalRawRowOverdrawKg: string;
    supplierOverdrawReviewCount: number;
    unbackedShortageSupplierCount: number;
    ownershipSourceExceptions: number;
    ownershipAffectedBatches: number;
    unclassifiedValuedAdds: number;
    unclassifiedNonUsdAdds: number;
    supplierOnlySourceRows: number;
    supplierOnlySourceWeightKg: string;
  };
  supplierBalances: SupplierStockBalanceReview[];
  rawStockExceptions: RawStockException[];
  ownershipExceptions: OwnershipException[];
  adjustmentEvidence: AdjustmentEvidenceException[];
  recommendations: string[];
}

export function groupSupplierKey(id: number | null): string {
  return id === null ? "__unassigned__" : String(id);
}

/** CSV export with fixed columns and formula-injection protection. */
export function phase4MixProvenanceCsv(
  report: Phase4SourceProvenanceReport,
  kind: "ownership" | "stock" | "adjustments"
): string {
  const cell = (value: unknown): string => {
    const raw = String(value ?? "");
    const formula = /^[\s]*[=+@-]/.test(raw) && !/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw.trim());
    return '"' + (formula ? "'" + raw : raw).replace(/\r?\n/g, " ").replace(/"/g, '""') + '"';
  };
  const headers: Record<typeof kind, string[]> = {
    ownership: [
      "Batch",
      "Source ID",
      "Container",
      "Pricing Supplier ID",
      "Recorded Owner ID",
      "Current Container Owner ID",
      "Weight Kg",
      "Recorded USD/kg",
      "Recorded Total USD",
      "Classification",
    ],
    stock: [
      "Raw Stock ID",
      "Container",
      "Supplier ID",
      "Received Kg",
      "Used Kg",
      "Excess Kg",
      "Supplier Stock Coverage",
      "Recorded USD/kg",
    ],
    adjustments: [
      "Adjustment ID",
      "Date",
      "Supplier ID",
      "Type",
      "Kg",
      "Cost/kg",
      "Currency",
      "Valuation Basis",
      "Reference",
      "Notes",
      "Classification",
    ],
  };
  const rows: unknown[][] = [headers[kind]];
  if (kind === "ownership")
    for (const x of report.ownershipExceptions)
      rows.push([
        x.batchCode,
        x.sourceId,
        x.containerNumber,
        x.pricingSupplierId,
        x.recordedInventorySupplierId,
        x.currentContainerSupplierId,
        x.sourceWeightKg,
        x.recordedRateUsd,
        x.recordedSourceTotalUsd,
        x.classification,
      ]);
  if (kind === "stock")
    for (const x of report.rawStockExceptions)
      rows.push([
        x.rawStockId,
        x.containerNumber,
        x.supplierId,
        x.receivedKg,
        x.usedKg,
        x.excessUsedKg,
        x.supplierCoverage,
        x.stockValueRateUsd,
      ]);
  if (kind === "adjustments")
    for (const x of report.adjustmentEvidence)
      rows.push([
        x.adjustmentId,
        x.date,
        x.supplierId,
        x.type,
        x.kg,
        x.recordedCostPerKg,
        x.currency,
        x.basis,
        x.reference,
        x.notes,
        x.classification,
      ]);
  return "\uFEFF" + rows.map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n";
}
