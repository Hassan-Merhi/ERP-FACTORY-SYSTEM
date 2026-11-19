// Extracted from ./rawMaterialReconciliation.ts
import { type LockedRateDiagnosticRow } from "./rawStockLockedRate";

export interface KgSummary {
  receivedKg: number;
  usedKg: number;
  reservedKg: number;
  freeKg: number;
  negativeStockCount: number;
  negativeStockRows: Array<{ rawStockId: number; containerId: number; containerNumber: string | null; freeKg: number }>;
}

export interface SupplierCurrencyExposureRow {
  supplierId: number;
  supplierName: string;
  byCurrency: Record<string, { resolvedNative: number; unresolvedNative: number; unresolvedCount: number }>;
}

export interface UnresolvedFxRow {
  supplierId: number;
  supplierName: string;
  currencyCode: string;
  source: "container" | "offload_charge" | "commission" | "container_other_charge" | "voucher_payment";
  rowId: number;
  nativeAmount: number;
}

/**
 * A supplier's true net balance by currency — NOT the same thing as gross
 * exposure. grossExposureByCurrency is everything ever owed to the supplier
 * (opening balance + container liabilities + freight/charges/commissions),
 * before any payment is netted off; it must never be presented to a user as
 * "the balance". paymentsByCurrency nets off supplier payments, voucher
 * payments, and FX transfers/settlements. netBalanceByCurrency is the actual
 * per-currency amount still owed (gross − payments, computed from native
 * amounts, so it never depends on FX resolution). netBalanceUsd converts each
 * currency's net balance using that row's OWN resolved FX rate and excludes
 * any amount whose FX could not be resolved (see unresolvedFxRows on the
 * parent report) rather than guessing at a rate.
 */
export interface SupplierBalanceByCurrencyRow {
  supplierId: number;
  supplierName: string;
  grossExposureByCurrency: Record<string, number>;
  paymentsByCurrency: Record<string, number>;
  netBalanceByCurrency: Record<string, number>;
  netBalanceUsd: number;
  hasUnresolvedFx: boolean;
}

export interface CrossCompanyContaminationRow {
  table: "factory_containers" | "factory_raw_stock" | "factory_mix_batch_sources";
  rowId: number;
  rowCompanyId: number;
  referencedEntity: string;
  referencedCompanyId: number;
  detail: string;
}

export interface DoubleReservedRow {
  containerId: number;
  containerNumber: string | null;
  remainingKg: number;
  reservedKg: number;
  overCommittedKg: number;
}

export interface RawMaterialReconciliation {
  companyId: number;
  scannedAt: string;
  kgSummary: KgSummary;
  lockedRateDiagnostics: LockedRateDiagnosticRow[];
  lockedRateDriftCount: number;
  supplierCurrencyExposure: SupplierCurrencyExposureRow[];
  supplierBalanceByCurrency: SupplierBalanceByCurrencyRow[];
  unresolvedFxRows: UnresolvedFxRow[];
  crossCompanyContamination: CrossCompanyContaminationRow[];
  doubleReservedDeductions: DoubleReservedRow[];
  negativeStockCount: number;
}

export interface DoubleReservedCheckResult {
  expectedFreeKg: number;
  discrepancyKg: number;
  provenDoubleSubtraction: boolean;
}
