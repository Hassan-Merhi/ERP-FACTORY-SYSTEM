export interface SaleRow {
  id: string;
  itemName: string;
  stockItemCode?: string;
  quantity: number;
  rate: number;
  rateUSD: number; // Canonical USD rate for storage (never converted)
  amount: number;
  stockItemId?: number;
  salesItemId?: number; // Original sales item ID for edit mode
  configuredPrice?: number; // Configured selling price for P/L calculation (USD)
}

export interface InventoryItem {
  code: string;
  name: string;
  stock: number;
  price: number;
  configuredPrice: number; // Configured selling price (for P/L)
  stockItemId: number;
}

export interface APIInventoryItem {
  inventoryId: number;
  locationId: number;
  stockItemId: number;
  quantity: string;
  averageRate: string;
  totalValue: string;
  lastSellingPrice?: string;
  stockItemCode: string;
  stockItemName: string;
  stockItemUom: string;
  stockGroupId: number | null;
  stockGroupName: string | null;
  stockGroupCode: string | null;
}

export interface Location {
  id: number;
  code: string;
  name: string;
  city: string | null;
  state: string | null;
  country: string | null;
  cashAccountId?: number;
  cashAccountName?: string;
  whatsappGroupChatId?: string | null;
}

export type LedgerPickerAccount = {
  id: number;
  name?: string | null;
  code?: string | null;
  accountType?: string | null;
  balance?: string | number | null;
  balanceSide?: string | null;
};

export type BankAccountRow = {
  id: number;
  name?: string | null;
  code?: string | null;
};

export type CompanySettingsRow = {
  posExcelImportEnabled?: boolean;
};

export type PosDraftSummary = {
  id: number;
  updatedAt?: string | null;
  createdAt?: string | null;
  updated_at?: string | null;
  created_at?: string | null;
  itemCount?: string | number | null;
  item_count?: string | number | null;
  totalQty?: string | number | null;
  total_qty?: string | number | null;
  totalAmount?: string | number | null;
  total_amount?: string | number | null;
  items?: PosDraftItem[];
  paymentAccountType?: "bank" | "cash" | "credit";
  paymentAccountId?: number | null;
  isCreditSale?: boolean;
  notes?: string | null;
};

export type PosDraftItem = {
  stockItemId?: number;
  stockItemName?: string;
  stockItemCode?: string;
  quantity?: string | number;
  rate?: string | number;
  amount?: string | number;
};

export type PosShift = {
  id: number;
};

export type PosSaleItemPayload = {
  stockItemId?: number;
  salesItemId?: number;
  quantity: string | number;
  rate: string | number;
  stockItemName?: string;
  stockItemCode?: string;
  configuredPrice?: number;
};

export type PosSalePayload = {
  locationId?: number;
  shiftId?: number;
  clientSaleId?: string;
  paymentAccountType?: string;
  paymentAccountId?: number;
  isCreditSale?: boolean;
  notes?: string;
  voucherDate?: string;
  currency?: string;
  exchangeRate?: string;
  items: PosSaleItemPayload[];
};

export type PosEditVoucherEntry = {
  debitAmount?: string | number | null;
  bankAccountId?: number | null;
  ledgerAccountId?: number | null;
  narration?: string | null;
};

export type PosEditSalesItem = {
  id?: number;
  stockItemId?: number | string | null;
  stockItemName?: string | null;
  stockItemCode?: string | null;
  quantity?: string | number;
  sellingPrice?: string | number;
  totalSales?: string | number;
  configuredPrice?: string | number | null;
};

export type PosEditVoucher = {
  locationId?: number;
  description?: string | null;
  voucherDate?: string;
  voucherNumber?: string;
  salesItems?: PosEditSalesItem[];
  entries?: PosEditVoucherEntry[];
};

export type PosViewEntry = {
  id?: number;
  isStockItem?: boolean;
  stockItemId?: number | null;
  stockItemName?: string | null;
  accountName?: string | null;
  stockItemCode?: string | null;
  accountCode?: string | null;
  quantity?: string | number;
  rate?: string | number;
  sellingPrice?: string | number;
  totalAmount?: string | number;
  totalSales?: string | number;
  creditAmount?: string | number;
  costPrice?: string | number;
  configuredPrice?: string | number;
};

export type PosMutationPending = {
  isPending?: boolean;
  mutate: (data: PosSalePayload) => void;
};

export type PosStockPrintRow = {
  stockItemName?: string | null;
  stockItemCode?: string | null;
  stock: number;
};

export interface PosAutoSaveState {
  activeLocation: Pick<Location, "id"> | null;
  rows: SaleRow[];
  notes: string;
  isCreditSale: boolean;
  paymentAccountType: string;
  paymentAccountId: string | null;
  selectedCustomerId: string | null;
  currentDraftId: number | null;
  saveDraftIsPending: boolean;
}
