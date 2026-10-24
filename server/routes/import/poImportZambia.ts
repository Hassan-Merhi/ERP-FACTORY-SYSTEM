/**
 * Phase 8: native Kwacha handling for the Excel purchase import.
 *
 * A ZMW container preview is converted ONCE at the company's approved rate of
 * the import date, before any container, voucher, parent or stock write. The
 * preview's money fields become historical USD (what every downstream writer
 * stores) while each line and each PO keeps its original Kwacha evidence.
 */
import { getErrorMessage } from "../../lib/httpHandlers";
import { HttpError } from "../../lib/httpError";
import { isUnsupportedNativeZmwPurchase } from "../../services/accounting/zambiaPurchaseCurrencyGuard";
import { prepareZmwPurchaseCost } from "../../services/accounting/zambiaPurchaseCosting";
import { allocatePoCharges, type PoChargeSplit } from "./poChargeAllocation";
import type { PoImportPreviewContainer, PoImportPreviewItem } from "./po-import-preview";

export type ZambiaNativeValuation = Awaited<ReturnType<typeof prepareZmwPurchaseCost>>;

export interface ZmwImportRateInput {
  companyId: number;
  date: string;
  exchangeRate: unknown;
}

const MIXED_CURRENCY_MESSAGE = "Mixed ZMW/USD purchase containers are not supported.";

export function isNativeZmwPreview(preview: PoImportPreviewContainer): boolean {
  return preview.items.some((item) => isUnsupportedNativeZmwPurchase(item.currency));
}

function isMixedCurrencyPreview(preview: PoImportPreviewContainer): boolean {
  return isNativeZmwPreview(preview) && preview.items.some((item) => !isUnsupportedNativeZmwPurchase(item.currency));
}

function valueAtApprovedRate(preview: PoImportPreviewContainer, input: ZmwImportRateInput) {
  return prepareZmwPurchaseCost({
    companyId: input.companyId,
    date: input.date,
    exchangeRate: input.exchangeRate as string | number | null | undefined,
    lines: preview.items.map((item) => ({ quantity: item.quantity, rate: item.rate })),
    charges: preview.charges,
  });
}

/** Validation-time check of a Kwacha preview: error messages only, no writes. */
export async function validateZmwContainerPreview(
  preview: PoImportPreviewContainer,
  input: ZmwImportRateInput
): Promise<string[]> {
  if (!isNativeZmwPreview(preview)) return [];
  if (isMixedCurrencyPreview(preview)) return ["Do not mix ZMW and other currencies in one container import."];
  try {
    await valueAtApprovedRate(preview, input);
    return [];
  } catch (error) {
    return [getErrorMessage(error)];
  }
}

/**
 * Converts a Kwacha preview to historical USD in place (rates, line totals,
 * charges and totals) while stamping each line's native price and total.
 * Returns null for a non-ZMW preview; refuses a mixed-currency one (409).
 */
export async function convertZmwContainerPreview(
  preview: PoImportPreviewContainer,
  input: ZmwImportRateInput
): Promise<ZambiaNativeValuation | null> {
  if (!isNativeZmwPreview(preview)) return null;
  if (isMixedCurrencyPreview(preview)) throw new HttpError(409, MIXED_CURRENCY_MESSAGE);
  const valued = await valueAtApprovedRate(preview, input);
  preview.items.forEach((item, index) => {
    const converted = valued.lines[index];
    item.nativeRate = converted.nativeRate;
    item.nativeLineTotal = converted.nativeLineTotal;
    item.rate = Number(converted.rate);
    item.lineTotal = Number(converted.lineTotal);
  });
  preview.charges = {
    freight: Number(valued.freight),
    surcharge: Number(valued.surcharge),
    fumigation: Number(valued.fumigation),
    documentCharges: Number(valued.documentCharges),
    discount: Number(valued.discount),
    otherCharges: Number(valued.otherCharges),
  };
  preview.itemsTotal = Number(valued.itemsTotal);
  preview.chargesTotal = Number(valued.chargesTotal);
  preview.grandTotal = Number(valued.grandTotal);
  return valued;
}

/** Splits the native Kwacha charges across the POs the same way the USD ones are split; never mixes units. */
export function splitNativeCharges(
  valued: ZambiaNativeValuation | null,
  poEntries: ReadonlyArray<readonly [string, PoImportPreviewItem[]]>,
  freightPaidByParent: boolean
): PoChargeSplit[] | null {
  if (!valued) return null;
  return allocatePoCharges(
    poEntries.map(([, items]) => items.map((item) => item.nativeLineTotal ?? "0")),
    {
      freight: valued.nativeFreight,
      surcharge: valued.nativeSurcharge,
      fumigation: valued.nativeFumigation,
      documentCharges: valued.nativeDocumentCharges,
      discount: valued.nativeDiscount,
      otherCharges: valued.nativeOtherCharges,
    },
    freightPaidByParent
  );
}

/** The PO's native Kwacha evidence and locked rate; empty for a USD import. */
export function nativePurchaseOrderFields(
  valued: ZambiaNativeValuation | null,
  splits: PoChargeSplit[] | null,
  poIndex: number,
  lineCount: number,
  importDate: string
): Record<string, string | number> {
  if (!valued || !splits) return {};
  const split = splits[poIndex];
  return {
    historicalExchangeRate: valued.historicalExchangeRate,
    historicalRateDate: importDate,
    nativeLineCount: lineCount,
    nativeItemsTotal: split.itemsTotal.toFixed(2),
    nativeFreight: split.freight.toFixed(2),
    nativeSurcharge: split.surcharge.toFixed(2),
    nativeFumigation: split.fumigation.toFixed(2),
    nativeDocumentCharges: split.documentCharges.toFixed(2),
    nativeDiscount: split.discount.toFixed(2),
    nativeOtherCharges: split.otherCharges.toFixed(2),
  };
}
