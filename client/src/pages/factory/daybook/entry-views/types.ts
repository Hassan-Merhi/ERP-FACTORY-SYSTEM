import type { ComponentProps } from "react";

import type { Badge } from "@/components/ui/badge";

export type DaybookEntry = { txDate: string; txType: string; referenceId: string | number };
export type DisplayDate = (value: string) => string;
export type Navigate = (path: string) => void;
export type BadgeVariant = ComponentProps<typeof Badge>["variant"];

export type ContainerImportDetail = {
  currencyCode?: string; fxRateToUsd?: string | number; totalKg?: string | number; ratePerKg?: string | number;
  freight?: string | number; commissionAmount?: string | number; finalPayableAmount?: string | number;
  finalPayableAmountUsd?: string | number; supplierName?: string; containerNumber?: string; origin?: string;
  actualReceivedKg?: string | number; freightCurrencyCode?: string; commissionCurrencyCode?: string;
};
export type SupplierBalance = { balance?: number; outstandingUsd?: number };
export type MixBatchDetail = { totalWeightKg?: string | number; totalCost?: string | number; costPerKg?: string | number; batchCode?: string; name?: string; operatorUser?: string; status?: string };
export type MixBatchSource = { id?: string | number; weightKg?: string | number; costPerKg?: string | number; totalCost?: string | number; sourceType?: string; sourceBatchCode?: string; supplierName?: string; containerNumber?: string };
export type LoadingLine = { id?: string | number; quantity?: string | number; pricePerBale?: string | number; unitPrice?: string | number; totalAmount?: string | number; lineTotal?: string | number; articleCode?: string; productName?: string };
export type LoadingBale = { productName?: string; baleName?: string; articleCode?: string; weight?: string | number; weightKg?: string | number };
export type LoadingOrder = { lines?: LoadingLine[]; bales?: LoadingBale[]; customerName?: string; customerId?: string | number; customerCode?: string; destination?: string; containerNotes?: string; status?: string; proformaName?: string; loadingStartedAt?: string; grandTotal?: string | number; subtotalBales?: string | number; freightAmount?: string | number };
export type PayrollSummary = { baseSalary?: string | number; baleEarnings?: string | number; kgEarnings?: string | number; overtimePay?: string | number; bonuses?: string | number; transport?: string | number; deductions?: string | number; advances?: string | number; netSalary?: string | number; periodStart?: string; periodEnd?: string; workerName?: string; workerId?: string | number; workerPosition?: string; workerCode?: string; status?: string; cashAccountName?: string; balesCount?: string | number; kgProcessed?: string | number; overtimeHours?: string | number; presentDays?: string | number; absentDays?: string | number; totalWorkingDays?: string | number; notes?: string };
