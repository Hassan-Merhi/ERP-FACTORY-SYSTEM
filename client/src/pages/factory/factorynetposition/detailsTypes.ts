/** Response shape of GET /api/factory/net-position as the Details page reads it. */
export interface AccountItem {
  id?: number;
  name: string;
  code: string;
  value: number;
  category: string;
}

export interface BreakdownItem {
  name: string;
  value: number;
}

export interface FactoryNetPositionData {
  companyId?: number;
  asOf?: string;
  businessToday?: string;
  historyCompleteness?: "current" | "partial" | "complete";
  historyWarnings?: string[];
  forUsTotal: number;
  onUsTotal: number;
  netPosition: number;
  netPositionLabel: string;
  forUs: { total: number; breakdown: BreakdownItem[]; accounts: AccountItem[] };
  onUs: { total: number; breakdown: BreakdownItem[]; accounts: AccountItem[] };
  supplierLiabilities: number;
  inventoryValue: number;
  rawMaterialValue: number;
  ledgerAssets: number;
  ledgerLiabilities: number;
}
