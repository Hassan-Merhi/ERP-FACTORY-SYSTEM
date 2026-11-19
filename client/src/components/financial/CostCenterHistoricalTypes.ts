// Extracted from ./CostCenterHistorical.tsx to keep that module under the source-size cap.

export type Kind = "VOUCHER_ENTRY" | "FACTORY_DAYBOOK";

export type Split = { costCenterId: string; percent: string };

type Source = {
  sourceId: number;
  voucherId: number | null;
  voucherNumber: string | null;
  sourceDate: string;
  accountName: string;
  sourceModule: string;
  currency: string;
  amountNative: string;
  amountUsd: string;
  allocations: Array<{ costCenterId: number; amountNative: string; amountUsd: string }>;
};

export type Preview = {
  batchId: string;
  status: string;
  candidateCount: number;
  sourceHash: string;
  sourceNativeTotal: string;
  sourceUsdTotal: string;
  allocatedNativeTotal: string;
  allocatedUsdTotal: string;
  expiresInMinutes: number;
  rows: Source[];
  warning: string;
};

export type Reconciliation = {
  kind: Kind;
  basis: string;
  sourceCount: number;
  postedUsd: string;
  allocatedUsd: string;
  unallocatedUsd: string;
  allocatedSources: number;
  overallocatedSources: number;
  nativeCurrencies: Array<{
    currency: string;
    sourceCount: number;
    sourceNative: string;
    allocatedNative: string;
    unallocatedNative: string;
    overallocatedSources: number;
  }>;
};

export type Account = { id: number; code: string; name: string };

export type Batch = {
  id: string;
  status: string;
  sourceKind: Kind;
  candidateCount: number;
  sourceUsdTotal: string;
  createdAt: string;
  expiresAt: string;
  appliedAt: string | null;
  createdBy: string;
  request: { fromDate: string; toDate: string; reason: string };
};

export const amountPattern = /^(?:0|[1-9]\d{0,2})(?:\.\d{1,4})?$/;

/** Server-side batch cap (HISTORICAL_BATCH_MAX). */
export const MAX_BATCH = 10000;

export function startDate() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-01";
}

export function dateToday() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

export const fmt = (n: string | number | undefined) =>
  Number(n || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

export const err = (e: unknown) => (e instanceof Error ? e.message : "Historical allocation operation failed");
