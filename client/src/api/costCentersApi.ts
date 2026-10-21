/** Shared ERP/Factory cost-center HTTP contract. Amounts remain decimal strings. */
import { apiRequest } from "@/lib/queryClient";

export type CostCenter = {
  id: number;
  companyId: number;
  code: string;
  name: string;
  description: string | null;
  parentId: number | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};
export type CostCenterCatalog = { costCenters: CostCenter[] };
export type CostCenterActivity = {
  center: CostCenter;
  activity: Array<{
    id: number;
    voucherId: number | null;
    voucherEntryId: number | null;
    factoryDaybookEntryId: number | null;
    amountNative: string;
    amountBase: string;
    currency: string;
    costTreatment: string;
    allocationOrigin?: "AUTO" | "MANUAL";
    sourceDate: string | null;
    voucherNumber: string | null;
    factoryTxType: string | null;
  }>;
};
export type CostCenterBalance = {
  center: CostCenter;
  baseCurrency: string;
  byTreatment: Array<{ costTreatment: string; amountBase: string; entryCount: number }>;
};
export type VoucherExpenseEntry = {
  entryId: number;
  accountName: string;
  accountCode: string;
  accountType: string;
  costTreatment: "EXPENSE" | "INVENTORY_COST";
  currency: string;
  amountNative: string;
  amountBase: string;
  allocatedNative: string;
  allocatedBase: string;
  allocationCount: number;
};
export type VoucherExpenseEntries = { entries: VoucherExpenseEntry[] };
export type CostCenterSplit = {
  id: number;
  costCenterId: number;
  costCenterCode: string;
  costCenterName: string;
  allocationOrigin?: "AUTO" | "MANUAL";
  autoRuleId?: number | null;
  amountNative: string;
  amountBase: string;
  currency: string;
  costTreatment: "EXPENSE" | "INVENTORY_COST" | "OTHER";
};
export type SourceCostCenterAllocation = {
  sourceType: "voucher_entry" | "factory_daybook";
  sourceId: number;
  currency?: string;
  totalNative?: string;
  totalBase?: string;
  allocatedNative: string;
  allocatedBase: string;
  unallocatedNative: string;
  unallocatedBase: string;
  splits: CostCenterSplit[];
};

export async function readCostCenterApi<T>(path: string): Promise<T> {
  const response = await apiRequest("GET", path);
  return (await response.json()) as T;
}
export async function writeCostCenterApi<T>(method: "POST" | "PATCH" | "PUT", path: string, body: unknown): Promise<T> {
  const response = await apiRequest(method, path, body);
  return (await response.json()) as T;
}
