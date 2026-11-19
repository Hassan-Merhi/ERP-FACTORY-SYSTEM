// Extracted from ./netPositionHelper.ts

export interface AccountLike {
  id: number;
  /** Scopes management-only presentation exceptions; persisted GL rows include this. */
  companyId?: number | null;
  name: string;
  code: string | null;
  accountType: string | null;
  subType?: string | null;
  openingBalance: string | null;
  openingBalanceSide: string | null;
  parentId?: number | null;
}

export interface AccountBalance {
  debit: number;
  credit: number;
}

export interface NetPositionAccount {
  id?: number;
  /** A bank account line (bank_accounts id); `id` is only ever a ledger account id. */
  bankAccountId?: number;
  /**
   * Party lines (balance engine parties): the owner kind and master id, so a
   * current-rate monetary translation can replace exactly this row by its
   * canonical owner (customer:id, bank:id) and never by a ledger id.
   */
  partyKind?: string;
  partyId?: number | null;
  name: string;
  code: string;
  value: number;
  category: string;
}

export interface EquityAccount extends NetPositionAccount {
  balanceSide: "Dr" | "Cr";
}

export interface EquityResult {
  total: number;
  accounts: EquityAccount[];
}

export interface ClassifyOptions {
  /**
   * Extra account codes (uppercase) to skip from net-position classification.
   * Use this to inject factory-specific clearing codes like FACTORY_IMPORT_COST.
   */
  additionalExcludedCodes?: Set<string>;
  /**
   * When false, Supplier-type ledger accounts are excluded from the
   * classification (factory handles suppliers via its own calculation).
   * Defaults to true.
   */
  includeSupplierTypeAccounts?: boolean;
  /**
   * Perpetual inventory (wave 8.5): the company's ledger carries its stock, so
   * the system stock accounts count as assets and the caller adds no computed
   * stock figure. Other stock-named accounts stay excluded.
   */
  ledgerStockAccounts?: boolean;
}

/** The stock accounts the perpetual-inventory postings keep (systemAccounts registry codes). */
export const PERPETUAL_STOCK_ACCOUNT_CODES: ReadonlySet<string> = new Set([
  "INVENTORY",
  "GOODS_IN_TRANSIT",
  "FACTORY_RAW_MATERIAL_STOCK",
  "FACTORY_WIP",
  "FACTORY_FINISHED_GOODS",
]);

export interface ClassifyResult {
  forUsTotal: number;
  onUsTotal: number;
  forUsAccounts: NetPositionAccount[];
  onUsAccounts: NetPositionAccount[];
  /**
   * Raw category → value map.  Caller may push additional entries (e.g.
   * stockOnFloor, workerAdvances) before building the final breakdown arrays.
   * Keys use the prefixes  "asset_"  and  "liability_"  so helpers that build
   * breakdown arrays can strip them.
   */
  categoryTotals: Record<string, number>;
}

/** Types left out of net position although they are balance-sheet types. */
export const excludedBalanceSheetTypes = new Set(["fixed asset", "intercompany"]);

export const fixedAssetNamePatterns = [
  "rover",
  "toyota",
  "mercedes",
  "vehicle",
  "car",
  "truck",
  "land",
  "property",
  "building",
  "house",
  "rolex",
  "watch",
  "luxury",
  "jewelry",
  "guarantee",
  "deposit",
  "caution",
];

export const stockInventoryPatterns = [
  "closing stock",
  "opening stock",
  "stock in hand",
  "stock on hand",
  "inventory",
  "stock account",
  "goods in stock",
  "merchandise",
];

export const stockInventoryCodes = ["CLOSING_STOCK", "OPENING_STOCK", "STOCK", "INVENTORY", "STOCK_IN_HAND"];
