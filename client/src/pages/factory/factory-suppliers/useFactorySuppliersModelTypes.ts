// Extracted from ./useFactorySuppliersModel.tsx to keep that module under the source-size cap.

export type SupplierFilter =
  "all" | "brokers" | "standalone" | "with-balance" | "zero-balance" | "has-foreign" | "has-recent";

export type FxSourceType = "supplier" | "commission" | "both";

export interface SupplierFormData {
  name: string;
  contactPerson: string;
  phone: string;
  email: string;
  address: string;
  notes: string;
  parentId: number | null;
}

export interface PaymentForm {
  supplierId: number;
  date: string;
  amount: string;
  currencyCode: string;
  fxRateToUsd: string;
  paidFromAccountId: string;
  notes: string;
  effectiveDate: string;
}

export interface FxConversionForm {
  fromSupplierId: number;
  toSupplierId: number;
  selectedCurrency: string;
  amount: string;
  availableBalance: string;
  supplierBalance: string;
  commissionBalance: string;
  fxRateToUsd: string;
  date: string;
  notes: string;
  effectiveDate: string;
  sourceType?: string;
}

export interface BulkFxForm {
  fromCurrencyCode: string;
  totalAmount: string;
  fxRateToUsd: string;
  date: string;
  notes: string;
  order: "oldest" | "newest";
}

export interface OpeningBalanceEdit {
  id: number;
  name: string;
  currentBalance: string;
}

export interface OpeningCommissionEdit {
  rawStockId: number;
  amount: string;
  currencyCode: string;
  personName: string;
  notes: string;
}

export interface OpeningCommissionUpdatePayload {
  rawStockId: number;
  commissionAmount: string;
  commissionCurrencyCode: string;
  commissionPersonName: string;
  commissionNotes: string;
}

export interface DueContainer {
  id: number;
  containerNumber: string;
  offloadDate: string;
  currencyCode: string;
  value: string;
  daysPastDue: number;
}

export interface MoveContainerState {
  open: boolean;
  containerId: number | null;
  containerRef: string;
}

export interface MoveResult {
  toSupplierName: string;
  fromSupplierName: string;
}

export interface SupplierPatch extends Partial<SupplierFormData> {
  id: number;
  isBroker?: boolean;
}

export function responseMessage(body: unknown, fallback: string): string {
  return typeof body === "object" && body !== null && "message" in body && typeof body.message === "string"
    ? body.message
    : fallback;
}
