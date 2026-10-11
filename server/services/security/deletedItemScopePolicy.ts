export type DeletedItemScopeType =
  | "location"
  | "stockItem"
  | "stockGroup"
  | "ledgerAccount"
  | "employee"
  | "customer"
  | "supplier"
  | "bankAccount"
  | "voucher"
  | "orphanedPosSale"
  | "factoryCategory"
  | "factoryBaleProduct"
  | "factoryContainer"
  | "factoryRawStock"
  | "factoryRawMaterialAdjustment"
  | "factoryMixBatch"
  | "factoryBale"
  | "customerProforma"
  | "customerOrder";

export interface DeletedItemScopeMatch {
  type: DeletedItemScopeType;
  id: number;
  operation: "restore" | "permanent";
  globalMaintenance: boolean;
}

const TYPES = new Set<DeletedItemScopeType>([
  "location",
  "stockItem",
  "stockGroup",
  "ledgerAccount",
  "employee",
  "customer",
  "supplier",
  "bankAccount",
  "voucher",
  "orphanedPosSale",
  "factoryCategory",
  "factoryBaleProduct",
  "factoryContainer",
  "factoryRawStock",
  "factoryRawMaterialAdjustment",
  "factoryMixBatch",
  "factoryBale",
  "customerProforma",
  "customerOrder",
]);

export function classifyDeletedItemScope(path: string): DeletedItemScopeMatch | null {
  const match = path.match(/^\/api\/deleted-items\/([^/]+)\/(\d+)\/(restore|permanent)$/);
  if (!match) return null;

  const type = match[1] as DeletedItemScopeType;
  const id = Number(match[2]);
  if (!TYPES.has(type) || !Number.isSafeInteger(id) || id <= 0) return null;

  return {
    type,
    id,
    operation: match[3] as "restore" | "permanent",
    // Wave 18 (B): suppliers are company-owned (suppliers.company_id), so they
    // are scoped to the active company like every other type; no type is
    // global maintenance any more (the field stays for callers).
    globalMaintenance: false,
  };
}
