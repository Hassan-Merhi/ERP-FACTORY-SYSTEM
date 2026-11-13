/**
 * Phase 4 source-aware, opt-in column schemas.
 *
 * This file defines how columns will appear when Phase 5–8 page handlers are
 * migrated. It does NOT fetch data, authorize exports, or change any current
 * export button. Monetary data and voucher balances come from each page's
 * authoritative existing data services.
 */
import type { UniversalExcelColumn, UniversalExcelColumnType } from "./engine";
import {
  buildAttributeColumns,
  buildCurrencyColumns,
  buildLocationPriceColumns,
  buildProductionMonthColumns,
  composeUniversalExcelColumns,
  selectUniversalExcelConditionalColumns,
  type UniversalExcelLocation,
  type UniversalExcelMonth,
  type UniversalExcelDimension,
} from "./columns";

export type UniversalExcelSchemaId =
  | "erp.stock-items"
  | "factory.production-monthly"
  | "factory.daybook-summary"
  | "factory.daybook-detailed"
  | "finance.currency-comparison"
  | "finance.agent-statement"
  | "erp.custom-attributes";

export const UNIVERSAL_EXCEL_REPORT_SCHEMA_IDS: readonly UniversalExcelSchemaId[] = [
  "erp.stock-items",
  "factory.production-monthly",
  "factory.daybook-summary",
  "factory.daybook-detailed",
  "finance.currency-comparison",
  "finance.agent-statement",
  "erp.custom-attributes",
] as const;

export const EXCEL_STOCK_RATES_TAG = "stock-rates";
export const EXCEL_STOCK_COST_TAG = "stock-cost";
export const EXCEL_FINANCIAL_COST_TAG = "financial-cost";

/** Stock Items: dynamic location prices are inserted before Active. */
export function buildStockItemReportColumns(
  locations: readonly UniversalExcelLocation[],
): UniversalExcelColumn[] {
  const fixed: UniversalExcelColumn[] = [
    { key: "code", header: "Code", type: "text", width: 20, required: true },
    { key: "name", header: "Name", type: "text", width: 40 },
    { key: "barcode", header: "Barcode", type: "text", width: 20 },
    { key: "aliasCodes", header: "Alias Codes", type: "text", width: 26 },
    { key: "uom", header: "UOM", type: "text", width: 10 },
    { key: "stockGroup", header: "Stock Group", type: "text", width: 24 },
    { key: "grade", header: "Grade", type: "text", width: 16 },
    { key: "category", header: "Category", type: "text", width: 22 },
    {
      key: "defaultSellingPrice", header: "Default Selling Price",
      type: "money", width: 23, permissionTag: EXCEL_STOCK_RATES_TAG,
    },
    {
      key: "costDubai", header: "Cost Dubai",
      type: "money", width: 18, permissionTag: EXCEL_STOCK_COST_TAG,
    },
    { key: "active", header: "Active", type: "text", width: 12 },
  ];
  const dynamicColumns = buildLocationPriceColumns(locations, {
    fallbackPriceKey: "defaultSellingPrice",
    permissionTag: EXCEL_STOCK_RATES_TAG,
  });
  return composeUniversalExcelColumns(fixed, [{
    after: "costDubai",
    columns: dynamicColumns,
  }]);
}

/** Production: month columns sorted by YYYY-MM, but array indices unchanged. */
export function buildProductionReportColumns(
  months: readonly UniversalExcelMonth[],
  options: { sourceFormat?: "record" | "array"; sourceKey?: string } = {},
): UniversalExcelColumn[] {
  const fixed: UniversalExcelColumn[] = [
    { key: "name", header: "Item Name", type: "text", width: 38 },
    { key: "articleCode", header: "Article Code", type: "text", width: 22 },
    { key: "categoryName", header: "Category", type: "text", width: 24 },
    { key: "totalBales", header: "Total Bales", type: "integer", width: 18 },
  ];
  return composeUniversalExcelColumns(fixed, [{
    before: "totalBales",
    columns: buildProductionMonthColumns(months, options),
  }]);
}

/**
 * Daybook schemas mirror each export's current field order.
 * Optional FX is a real typed field, not a rewritten display amount.
 */
export function buildFactoryDaybookReportColumns(
  mode: "summary" | "detailed",
  options: { includeFxRate?: boolean } = {},
): UniversalExcelColumn[] {
  const fixed: UniversalExcelColumn[] = [
    { key: "date", header: "Date", type: "date", width: 16 },
    { key: "type", header: "Type", type: "text", width: 23 },
    { key: "description", header: "Description", type: "text", width: 42 },
    { key: "currency", header: "Currency", type: "text", width: 13 },
    { key: "amount", header: "Amount", type: "money", width: 20 },
    { key: "amountUsd", header: "Amount (USD)", type: "money", width: 20 },
    { key: "optional", header: "Optional", type: "text", width: 12 },
  ];
  if (mode === "detailed") {
    fixed.push(
      { key: "accountName", header: "Account Name", type: "text", width: 34 },
      { key: "debit", header: "Debit", type: "money", width: 18 },
      { key: "credit", header: "Credit", type: "money", width: 18 },
    );
  }
  const includeFxRate = options.includeFxRate ?? mode === "summary";
  const fx = selectUniversalExcelConditionalColumns([{
    enabled: includeFxRate,
    column: {
      key: "fxRate",
      header: "FX Rate",
      type: "decimal",
      numFmt: "#,##0.000000",
      width: 18,
    },
  }]);
  return composeUniversalExcelColumns(fixed, [{
    after: "amount", columns: fx,
  }]);
}

/** Financial comparison: per-currency amounts and optional FX conversion. */
export function buildFinanceCurrencyReportColumns(
  currencies: readonly string[],
  options: { includeFxRates?: boolean; hideCost?: boolean } = {},
): UniversalExcelColumn[] {
  const base: UniversalExcelColumn[] = [
    { key: "date", header: "Date", type: "date", width: 16 },
    { key: "description", header: "Description", type: "text", width: 40 },
    { key: "totalUsd", header: "Total USD", type: "money", width: 20 },
  ];
  const amountColumns = buildCurrencyColumns(currencies, {
    measure: "amount",
    permissionTag: options.hideCost ? EXCEL_FINANCIAL_COST_TAG : undefined,
  });
  const fxColumns = options.includeFxRates
    ? buildCurrencyColumns(currencies, { measure: "fx-rate" })
    : [];
  return composeUniversalExcelColumns(base, [
    { before: "totalUsd", columns: amountColumns },
    { before: "totalUsd", columns: fxColumns },
  ]);
}

/** Agent statements: preserve opening-balance and optional rate columns. */
export function buildAgentStatementReportColumns(options: { fxRate?: boolean } = {}): UniversalExcelColumn[] {
  return [
    { key: "ledger", header: "Ledger", type: "text", width: 22 },
    { key: "type", header: "Type", type: "text", width: 22 },
    { key: "debit", header: "Debit", type: "money", width: 18 },
    { key: "credit", header: "Credit", type: "money", width: 18 },
    { key: "runningBalance", header: "Running Balance", type: "money", width: 22 },
    { key: "date", header: "Date", type: "date", width: 16 },
    { key: "notes", header: "Notes", type: "text", width: 35 },
    ...selectUniversalExcelConditionalColumns([{
      enabled: options.fxRate === true,
      column: {
        key: "fxRate", header: "FX Rate", type: "decimal",
        numFmt: "#,##0.000000", width: 18,
      },
    }]),
  ];
}

/** User-configured fields are always drawn from an explicit attribute list. */
export function buildCustomAttributeReportColumns(
  base: readonly UniversalExcelColumn[],
  attributes: readonly (UniversalExcelDimension & { type?: UniversalExcelColumnType })[],
): UniversalExcelColumn[] {
  return composeUniversalExcelColumns(base, [{
    columns: buildAttributeColumns(attributes, { order: "label" }),
  }]);
}
