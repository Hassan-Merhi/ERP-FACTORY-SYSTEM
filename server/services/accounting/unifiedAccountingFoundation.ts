/**
 * Unified accounting foundation — ERP, Factory and Rentals (Phase 1).
 *
 * This is a semantic contract, not a new ledger, a data migration, or a second
 * posting engine. The existing accountClassification, centralPostingEngine,
 * and systemAccounts services remain authoritative for stored account types,
 * voucher writes, and system account creation.
 *
 * In particular, Rentals is a business accounting domain embedded in three
 * existing UI/route modules (ERP, FACTORY, PROPERTIES). Historic vouchers can
 * have source_module='ERP' even when they were posted by Rentals. Never
 * rewrite that persisted value to change their accounting domain.
 */
import { classifyAccountType, type AccountClass } from "./accountClassification";

export type AccountingDomain = "ERP" | "FACTORY" | "RENTALS";
export type RentalOriginModule = "ERP" | "FACTORY" | "PROPERTIES";
export type FinancialStatementCategory = AccountClass | "cost_of_sales";

/**
 * The names passed to the existing rental account find-or-create paths.
 * These are names, NOT account codes. Keep the ERP, Factory and Properties
 * distinctions even though all three participate in the Rentals domain.
 */
export const RENTAL_MODULE_ACCOUNTS: Readonly<
  Record<RentalOriginModule, Readonly<{ income: string; expense: string }>>
> = Object.freeze({
  ERP: Object.freeze({ income: "Rental Income - ERP", expense: "Rent Expense - ERP Shops" }),
  FACTORY: Object.freeze({ income: "Rental Income - Factory", expense: "Rent Expense - Factory Shops" }),
  PROPERTIES: Object.freeze({ income: "Rental Income - Properties", expense: "Rent Expense - Property Shops" }),
});

/**
 * Existing code-resolved rental ledger accounts, including historical aliases
 * still found in separate posting paths. These must not be renamed, re-coded,
 * created in every company, or consolidated into one account by Phase 1.
 *
 * The account codes below originate from routes/rental/shared,
 * rentalPaymentPostingService and rental guarantee workflows.
 */
export const RENTAL_POSTING_ACCOUNT_CODES: readonly string[] = Object.freeze([
  "SHOP-RENT-EXP",
  "RENT-EXP",
  "RENT-INC",
  "ACCR-RENT-PAY",
  "ACC-RENT-PAY",
  "ADV-RENT-PAID",
  "PREP-RENT",
  "PREPAID-RENT",
  "DEF-RENT-REV",
  "SEC-DEP-PAID",
  "TENANT-DEP",
]);

/**
 * Semantic control-account roles per business domain. Codes are references
 * to already-used posting accounts, not instructions to create or retype them.
 * An individual company's ledger may not contain every code.
 */
export const ACCOUNTING_CONTROL_ACCOUNTS = Object.freeze({
  ERP: Object.freeze({
    purchases: "PURCHASES",
    inventory: "INVENTORY",
    goodsInTransit: "GOODS_IN_TRANSIT",
    costOfSales: "COGS",
  }),
  FACTORY: Object.freeze({
    goodsInTransit: "FACTORY_GOODS_IN_TRANSIT",
    rawMaterials: "FACTORY_RAW_MATERIAL_STOCK",
    workInProgress: "FACTORY_WIP",
    finishedGoods: "FACTORY_FINISHED_GOODS",
    baleSalesIncome: "FACTORY_BALE_SALES_INCOME",
    productionVariance: "PRODUCTION_VARIANCE",
  }),
  RENTALS: Object.freeze({
    rentIncome: "RENT-INC",
    rentExpense: "SHOP-RENT-EXP",
    accruedRentPayable: "ACCR-RENT-PAY",
    advanceRentPaid: "ADV-RENT-PAID",
    deferredRentRevenue: "DEF-RENT-REV",
    tenantDepositLiability: "TENANT-DEP",
    securityDepositAsset: "SEC-DEP-PAID",
  }),
});

/**
 * Cost of sales must be distinguished from other expenses in formal reports;
 * both are still class 'expense' for existing ledger/net-position/fiscal-close
 * calculations. An arbitrary 'Direct Expense' must NOT become COGS.
 */
const COST_OF_SALES_CODES = new Set(["COGS", "RETAIL-COGS"]);

export function financialStatementCategory(input: {
  code?: string | null;
  accountType: string | null | undefined;
  subType?: string | null;
}): FinancialStatementCategory {
  const accountClass = classifyAccountType(input.accountType, input.subType);
  if (accountClass !== "expense") return accountClass;
  const code = (input.code ?? "").trim().toUpperCase();
  const type = (input.accountType ?? "").trim().toLowerCase();
  const subType = (input.subType ?? "").trim().toLowerCase();
  return COST_OF_SALES_CODES.has(code) || type === "cogs" || subType === "cogs"
    ? "cost_of_sales"
    : "expense";
}

/**
 * Posting provenance is read from the existing voucher and durable posting
 * identity; it is never guessed from an account name or from a description.
 * This avoids modifying source_module, currency, historical dates or amounts.
 */
export interface AccountingPostingProvenance {
  companyId: number;
  domain: AccountingDomain | "UNKNOWN";
  storedSourceModule: string | null;
  rentalOrigin: RentalOriginModule | null;
  sourceType: string;
  sourceId: string;
  effectiveBusinessDate: string;
  transactionCurrency: string | null;
}

export function describeAccountingPosting(input: {
  companyId: number;
  sourceModule?: string | null;
  sourceType: string;
  sourceId: string;
  voucherDate: string;
  effectiveDate?: string | null;
  currency?: string | null;
}): AccountingPostingProvenance {
  const sourceType = input.sourceType.trim();
  const sourceModule = input.sourceModule?.trim().toUpperCase() || null;
  const isRental = sourceType.toLowerCase().startsWith("rental-") ||
    sourceType.toLowerCase().startsWith("rent-");
  const rentalOrigin: RentalOriginModule | null = isRental &&
    (sourceModule === "ERP" || sourceModule === "FACTORY" || sourceModule === "PROPERTIES")
      ? sourceModule
      : null;
  const domain: AccountingDomain | "UNKNOWN" = isRental || sourceModule === "PROPERTIES"
    ? "RENTALS"
    : sourceModule === "FACTORY"
      ? "FACTORY"
      : sourceModule === "ERP"
        ? "ERP"
        : "UNKNOWN";

  return {
    companyId: input.companyId,
    domain,
    storedSourceModule: sourceModule,
    rentalOrigin,
    sourceType,
    sourceId: input.sourceId.trim(),
    effectiveBusinessDate: input.effectiveDate?.trim() || input.voucherDate.trim(),
    transactionCurrency: input.currency?.trim().toUpperCase() || null,
  };
}
