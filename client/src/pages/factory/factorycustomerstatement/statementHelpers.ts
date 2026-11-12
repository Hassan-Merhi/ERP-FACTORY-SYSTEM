import * as XLSX from "xlsx-js-style";
import { type LedgerSplitFields, type NotInLedgerRowFields } from "./NotInLedgerParts";

export interface CustomerInfo {
  id: number;
  code: string;
  legalName: string;
  phone: string | null;
  openingBalance: string | null;
  openingBalanceSide: string | null;
  active: boolean;
  statementNote: string | null;
}

export interface BalanceEntry extends NotInLedgerRowFields {
  id: number | string; // numeric for customerBalances rows, "ve-{n}" for voucher-entry rows
  transactionDate: string;
  transactionType: string;
  description: string | null;
  referenceType: string | null;
  referenceId: number | null;
  debitAmount: string;
  creditAmount: string;
  balance: string;
  currency: string;
  containerNumber: string | null;
  destination: string | null;
  totalQtyBales: number | null;
  totalWeightKg: number | null;
  runningBalance: number;
  runningBalanceSide: string;
  rowNote: string | null;
}

export interface StatementData extends LedgerSplitFields {
  customer: CustomerInfo;
  invoices: unknown[];
  balanceHistory: BalanceEntry[];
  currentBalance: number;
  currentBalanceSide: string;
  openingBalance: number;
  openingBalanceSide: string;
}

export interface PriceListEntry {
  article_code: string;
  item_name: string;
  price_per_bale: string;
  updated_at: string;
}

// Older customer-wide prices are retained for reference, but never used as
// destination-specific agreed prices on new proformas.
export const LEGACY_PRICE_DESTINATION = "__legacy__";

export function priceListUrl(customerId: string | undefined, destination: string, articleCode?: string): string {
  const base = `/api/factory/customer-price-lists/${customerId}`;
  const path = articleCode ? `${base}/${encodeURIComponent(articleCode)}` : base;
  return destination === LEGACY_PRICE_DESTINATION ? path : `${path}?destination=${encodeURIComponent(destination)}`;
}

export function normalizePriceDestination(value: string): string {
  const normalized = value
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase()
    .replace(/[\u2019\u2018]/g, "'");
  if (["LUBUMBASHI", "LSHI", "L'SHI", "L SHI"].includes(normalized)) return "L'SHI";
  if (normalized === "MALI 53") return "MALI";
  return normalized;
}

export function fmtMoney(value: number | null | undefined): string {
  if (value == null || isNaN(value)) return "$0";
  const abs = Math.abs(value);
  if (abs % 1 === 0) {
    return `$${Math.round(abs).toLocaleString()}`;
  }
  return `$${abs.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function fmtNum(value: number | null | undefined): string {
  if (value == null || isNaN(value)) return "0";
  if (value % 1 === 0) return Math.round(value).toLocaleString();
  return value.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

export interface PriceListLine {
  articleCode: string;
  pricePerBale: string | number;
}

/** Reads article_code / price rows from an uploaded price-list sheet; skips blank and non-positive prices. */
export function parsePriceListRows(rows: Record<string, unknown>[]): PriceListLine[] {
  const lines: PriceListLine[] = [];
  for (const row of rows) {
    const code = String(row["article_code"] ?? row["Article Code"] ?? row["ARTICLE_CODE"] ?? row["code"] ?? "").trim();
    const price = row["price"] ?? row["price_per_bale"] ?? row["Price"] ?? row["Price Per Bale"] ?? row["PRICE"] ?? "";
    if (code && price !== "") {
      const p = parseFloat(String(price));
      if (!isNaN(p) && p > 0) lines.push({ articleCode: code, pricePerBale: p });
    }
  }
  return lines;
}

/** Downloads the agreed-price upload template (rejects if the browser cannot save it). */
export async function downloadPriceListTemplate(): Promise<void> {
  // The first sheet matches the importer headers and contains no fake example articles.
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([["article_code", "price"]]);
  sheet["!cols"] = [{ wch: 28 }, { wch: 18 }];
  sheet["!rows"] = [{ hpt: 26 }];
  sheet["!autofilter"] = { ref: "A1:B1" };
  for (const cell of ["A1", "B1"]) {
    sheet[cell].s = {
      font: { bold: true, color: { rgb: "FFFFFF" } },
      fill: { patternType: "solid", fgColor: { rgb: "1E293B" } },
      alignment: { vertical: "center" },
    };
  }
  XLSX.utils.book_append_sheet(workbook, sheet, "Price List");

  const guide = XLSX.utils.aoa_to_sheet([
    ["How to upload agreed prices"],
    ["1. In Price List, enter existing article codes under article_code and positive USD prices per bale under price."],
    ["2. Keep both headers unchanged. Enter prices as numbers without a dollar sign."],
    ["3. In the ERP, select the correct customer and destination, then use Upload Excel."],
    ["4. Only that customer and destination are updated; existing proforma line prices are not changed."],
  ]);
  guide["!cols"] = [{ wch: 110 }];
  guide["A1"].s = {
    font: { bold: true, color: { rgb: "FFFFFF" } },
    fill: { patternType: "solid", fgColor: { rgb: "1E293B" } },
  };
  XLSX.utils.book_append_sheet(workbook, guide, "Instructions");
  await XLSX.writeFile(workbook, "agreed-prices-upload-template.xlsx");
}
