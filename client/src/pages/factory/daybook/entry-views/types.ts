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
  articleCode?: string | null;
  weight?: ApiValue;
  weightKg?: ApiValue;
}

export interface LoadingOrder {
  lines?: LoadingLine[];
  bales?: LoadingBale[];
  customerName?: string | null;
  customerId?: ApiValue;
  customerCode?: string | null;
  destination?: string | null;
  containerNotes?: string | null;
  status?: string | null;
  proformaName?: string | null;
  loadingStartedAt?: string | null;
  grandTotal?: ApiValue;
  subtotalBales?: ApiValue;
  freightAmount?: ApiValue;
}

export interface PayrollSummary {
  baseSalary?: ApiValue;
  baleEarnings?: ApiValue;
  kgEarnings?: ApiValue;
  overtimePay?: ApiValue;
  bonuses?: ApiValue;
  transport?: ApiValue;
  deductions?: ApiValue;
  advances?: ApiValue;
  netSalary?: ApiValue;
  periodStart?: string | null;
  periodEnd?: string | null;
  workerName?: string | null;
  workerId?: ApiValue;
  workerPosition?: string | null;
  workerCode?: string | null;
  status?: string | null;
  cashAccountName?: string | null;
  balesCount?: ApiValue;
  kgProcessed?: ApiValue;
  overtimeHours?: ApiValue;
  presentDays?: ApiValue;
  absentDays?: ApiValue;
  totalWorkingDays?: ApiValue;
  notes?: string | null;
}

export interface VoucherViewEntry {
  id: number;
  accountName?: string | null;
  debitAmount?: ApiValue;
  creditAmount?: ApiValue;
  bankAccountId?: ApiValue;
  customerId?: ApiValue;
  employeeId?: ApiValue;
  factorySupplierId?: ApiValue;
  ledgerAccountId?: ApiValue;
  supplierId?: ApiValue;
}
