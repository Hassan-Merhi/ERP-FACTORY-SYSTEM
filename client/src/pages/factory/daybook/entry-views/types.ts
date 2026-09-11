import type { ComponentProps } from "react";

import type { Badge } from "@/components/ui/badge";

export type { DaybookEntry } from "../types";

/** Values returned by JSON APIs for numeric database columns. */
export type ApiValue = string | number | null | undefined;

export function apiNumber(value: ApiValue): number {
  return parseFloat(value == null || value === "" ? "0" : String(value));
}

export type DisplayDate = (value: string) => string;
export type Navigate = (path: string) => void;
export type BadgeVariant = ComponentProps<typeof Badge>["variant"];

export interface ContainerDetail {
  containerNumber?: string | null;
  supplierName?: string | null;
  supplierId?: ApiValue;
  origin?: string | null;
}

export interface ContainerImportDetail extends ContainerDetail {
  currencyCode?: string | null;
  fxRateToUsd?: ApiValue;
  totalKg?: ApiValue;
  ratePerKg?: ApiValue;
  freight?: ApiValue;
  commissionAmount?: ApiValue;
  finalPayableAmount?: ApiValue;
  finalPayableAmountUsd?: ApiValue;
  actualReceivedKg?: ApiValue;
  freightCurrencyCode?: string | null;
  commissionCurrencyCode?: string | null;
}

export interface SupplierBalance {
  balance?: ApiValue;
  outstandingUsd?: ApiValue;
}

export interface MixBatchDetail {
  totalWeightKg?: ApiValue;
  totalCost?: ApiValue;
  costPerKg?: ApiValue;
  batchCode?: string | null;
  name?: string | null;
  operatorUser?: string | null;
  status?: string | null;
}

export interface MixBatchSource {
  id?: ApiValue;
  weightKg?: ApiValue;
  costPerKg?: ApiValue;
  totalCost?: ApiValue;
  sourceType?: string | null;
  sourceBatchCode?: string | null;
  supplierName?: string | null;
  containerNumber?: string | null;
}

export interface LoadingLine {
  id?: ApiValue;
  quantity?: ApiValue;
  pricePerBale?: ApiValue;
  unitPrice?: ApiValue;
  totalAmount?: ApiValue;
  lineTotal?: ApiValue;
  articleCode?: string | null;
  productName?: string | null;
}

export interface LoadingBale {
  productName?: string | null;
  baleName?: string | null;
  weightKg?: ApiValue;
  quantity?: ApiValue;
  bales?: ApiValue;
  totalAmount?: ApiValue;
  totalCost?: ApiValue;
  pricePerBale?: ApiValue;
  unitPrice?: ApiValue;
  articleCode?: string | null;
}

export interface LoadingDetail {
  reference?: string | null;
  destination?: string | null;
  customerName?: string | null;
  totalAmount?: ApiValue;
  totalBales?: ApiValue;
  lines?: LoadingLine[] | null;
  bales?: LoadingBale[] | null;
}

export interface ProductionDetail {
  producedKg?: ApiValue;
  totalWeightKg?: ApiValue;
  totalBales?: ApiValue;
  quantity?: ApiValue;
  productName?: string | null;
  baleName?: string | null;
  mixBatchCode?: string | null;
  batchCode?: string | null;
}

export interface PaymentDetail {
  amount?: ApiValue;
  accountName?: string | null;
  supplierName?: string | null;
  customerName?: string | null;
  currency?: string | null;
  reference?: string | null;
}

export interface TransferDetail {
  amount?: ApiValue;
  sourceAccountName?: string | null;
  destinationAccountName?: string | null;
  currency?: string | null;
  reference?: string | null;
}

export interface ManualEntryDetail {
  description?: string | null;
  amount?: ApiValue;
  debitAmount?: ApiValue;
  creditAmount?: ApiValue;
  accountName?: string | null;
}

export interface FactoryExpenseDetail {
  description?: string | null;
  amount?: ApiValue;
  currency?: string | null;
  accountName?: string | null;
}

export interface DaybookEntryViewProps {
  entry: DaybookEntry;
  displayDate: DisplayDate;
  navigate: Navigate;
}
