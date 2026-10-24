/**
 * Phase 8: explicit purchase-import currency.
 *
 * The Excel parser labels each line with the sheet's optional "Currency"
 * column, defaulting to USD. For a company configured USD base / ZMW display a
 * Kwacha invoice without that column would otherwise be posted as USD: raw
 * Kwacha prices would enter inventory, goods-in-transit and the parent's
 * supplier credit as dollars. The wizard therefore states the invoice currency
 * explicitly for such a company, and the server applies it to every line
 * before any rate lookup, conversion or write. Mali (USD/CFA) and every other
 * company keep the sheet-driven behaviour unchanged.
 */
import type { PoImportPreviewItem } from "./po-import-preview";

export const IMPORT_CURRENCY_CHOICES = ["USD", "ZMW"] as const;
export type PurchaseImportCurrency = (typeof IMPORT_CURRENCY_CHOICES)[number];

export interface ImportCurrencyCompany {
  baseCurrency?: string | null;
  displayCurrency?: string | null;
}

export function requiresExplicitImportCurrency(company: ImportCurrencyCompany | null | undefined): boolean {
  return (
    String(company?.baseCurrency ?? "").toUpperCase() === "USD" &&
    String(company?.displayCurrency ?? "").toUpperCase() === "ZMW"
  );
}

/**
 * Stamps the selected currency on the preview lines (mutating them, as the
 * import route already does for converted values) and returns the validation
 * errors. With no selection, a Kwacha-enabled company fails closed; other
 * companies keep the sheet's own labels.
 */
export function applyExplicitImportCurrency(
  items: PoImportPreviewItem[],
  requested: unknown,
  company: ImportCurrencyCompany | null | undefined
): string[] {
  const errors: string[] = [];
  const selected = typeof requested === "string" && requested.trim() ? requested.trim().toUpperCase() : null;
  if (selected !== null && !(IMPORT_CURRENCY_CHOICES as readonly string[]).includes(selected)) {
    return [`Unsupported import currency "${selected}". Choose USD or ZMW.`];
  }
  if (selected === "ZMW" && !requiresExplicitImportCurrency(company)) {
    return ["Kwacha purchase imports require the active company to be configured USD base / ZMW display."];
  }
  if (selected === null) {
    if (requiresExplicitImportCurrency(company)) {
      errors.push("Select the invoice currency (USD or ZMW) before validating a purchase import for this company.");
    }
    return errors;
  }
  items.forEach((item, index) => {
    const sheetCurrency = item.currency ? item.currency.trim().toUpperCase() : "";
    if (sheetCurrency && sheetCurrency !== selected) {
      errors.push(
        `Row ${index + 1}: the spreadsheet Currency column says ${sheetCurrency} but ${selected} was selected for this import.`
      );
      return;
    }
    item.currency = selected;
  });
  return errors;
}
