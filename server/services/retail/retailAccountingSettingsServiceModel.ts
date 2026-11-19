// Extracted from ./retailAccountingSettingsService.ts

export interface RetailAccountingSettingsResolved {
  id: number;
  companyId: number;
  locationId: number | null;
  cashLedgerAccountId: number;
  cardLedgerAccountId: number;
  bankLedgerAccountId: number;
  bankAccountId: number | null;
  mobileLedgerAccountId: number;
  otherLedgerAccountId: number;
  salesRevenueLedgerAccountId: number;
  inventoryAssetLedgerAccountId: number;
  cogsLedgerAccountId: number;
  discountsLedgerAccountId: number;
  taxPayableLedgerAccountId: number;
  storeCreditLedgerAccountId: number;
}

/** The settings field each Retail default account fills, by registry code. */
export const RETAIL_DEFAULT_ACCOUNTS = {
  cashLedgerAccountId: "RETAIL-CASH",
  cardLedgerAccountId: "RETAIL-CARD",
  bankLedgerAccountId: "RETAIL-BANK",
  mobileLedgerAccountId: "RETAIL-MOBILE",
  otherLedgerAccountId: "RETAIL-OTHER",
  salesRevenueLedgerAccountId: "RETAIL-SALES",
  inventoryAssetLedgerAccountId: "RETAIL-INVENTORY",
  cogsLedgerAccountId: "RETAIL-COGS",
  discountsLedgerAccountId: "RETAIL-DISCOUNTS",
  taxPayableLedgerAccountId: "RETAIL-TAX",
  storeCreditLedgerAccountId: "RETAIL-STORE-CREDIT",
} as const;

export type RetailAccountField = keyof typeof RETAIL_DEFAULT_ACCOUNTS;

export interface RetailAccountConflict {
  code: string;
  accountId: number;
  issue: "type_differs" | "deleted";
  expectedType: string;
  actualType: string | null;
}

export type RetailAccountingSettingsPatch = Partial<{
  cashLedgerAccountId: number | null;
  cardLedgerAccountId: number | null;
  bankLedgerAccountId: number | null;
  bankAccountId: number | null;
  mobileLedgerAccountId: number | null;
  otherLedgerAccountId: number | null;
  salesRevenueLedgerAccountId: number | null;
  inventoryAssetLedgerAccountId: number | null;
  cogsLedgerAccountId: number | null;
  discountsLedgerAccountId: number | null;
  taxPayableLedgerAccountId: number | null;
  storeCreditLedgerAccountId: number | null;
}>;
