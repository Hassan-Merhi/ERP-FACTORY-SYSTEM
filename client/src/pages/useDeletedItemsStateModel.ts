// Extracted from ./useDeletedItemsState.ts

export interface DeletedItem {
  id: number;
  type: string;
  name: string;
  code: string;
  accountType?: string;
  deletedAt: string;
  amount?: number;
  date?: string;
  locationName?: string;
  voucherType?: string;
}

export interface DeletedItemsResponse {
  locations: DeletedItem[];
  stockItems: DeletedItem[];
  stockGroups: DeletedItem[];
  ledgerAccounts: DeletedItem[];
  employees: DeletedItem[];
  customers: DeletedItem[];
  suppliers: DeletedItem[];
  bankAccounts: DeletedItem[];
  vouchers: DeletedItem[];
  orphanedPosSales: DeletedItem[];
  factoryCategories?: DeletedItem[];
  factoryBaleProducts?: DeletedItem[];
  factoryContainers?: DeletedItem[];
  factoryRawStock?: DeletedItem[];
  factoryRawMaterialAdjustments?: DeletedItem[];
  factoryMixBatches?: DeletedItem[];
  factoryBales?: DeletedItem[];
  customerProformas?: DeletedItem[];
  customerOrders?: DeletedItem[];
  totalCount: number;
}

export const typeLabels: Record<string, string> = {
  location: "Location",
  stockItem: "Stock Item",
  stockGroup: "Stock Group",
  ledgerAccount: "Ledger Account",
  employee: "Employee",
  customer: "Customer",
  supplier: "Supplier",
  bankAccount: "Bank Account",
  voucher: "Voucher",
  orphanedPosSale: "Orphaned POS Sale",
  factoryCategory: "Factory Category",
  factoryBaleProduct: "Bale Product",
  factoryContainer: "Container",
  factoryRawStock: "Raw Stock Receipt",
  factoryRawMaterialAdjustment: "Raw Material Adjustment",
  factoryMixBatch: "Mix Batch",
  factoryBale: "Bale",
  customerProforma: "Proforma Invoice",
  customerOrder: "Customer Invoice/Order",
};
