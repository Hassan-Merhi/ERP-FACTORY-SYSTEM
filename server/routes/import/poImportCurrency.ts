/**
 * PO import helpers of phase 24 (M5): the import's currency and dated rate,
 * and the PO lines in USD with their native figures (see
 * services/accounting/fx/purchaseOrderCurrency.ts).
 */
import type { StockItem } from "@shared/schema";

import { db } from "../../db";
import { checkedDocumentRate, isDocumentRateError } from "../../services/accounting/fx/clientRateCheck";
import {
  poImportCurrency,
  poUsd,
  poUsdRate,
  type PoCurrencyContext,
} from "../../services/accounting/fx/purchaseOrderCurrency";
import { storage } from "../../storage";
import { MoneyDecimal, sumMoney } from "../../lib/money";
import type { PoImportPreviewContainer, PoImportPreviewItem } from "./po-import-preview";
import type { PoChargeSplit } from "./poChargeAllocation";

export interface PoImportRefusal {
  status: number;
  body: Record<string, unknown>;
}

/** One currency's checked rate on the import date, or the refusal (409 rate). */
async function datedPoCurrency(
  companyId: number,
  code: string,
  importDate: string,
  clientRate: unknown
): Promise<{ currency: PoCurrencyContext } | { refusal: PoImportRefusal }> {
  try {
    const dated = await checkedDocumentRate(db, {
      companyId,
      currency: code,
      documentDate: String(importDate).slice(0, 10),
      clientRate,
    });
    return { currency: { currency: dated.currency, unitsPerUsd: dated.rate ?? "1" } };
  } catch (error: unknown) {
    if (isDocumentRateError(error)) return { refusal: { status: error.statusCode, body: error.body } };
    throw error;
  }
}

/**
 * Each PO group's currency and rate on the import date (review finding: a
 * container may hold POs in different currencies; each PO is in one). Only a
 * PO whose own items mix currencies is refused. The client rate (one figure)
 * is checked against the one foreign currency it can belong to; with several
 * foreign currencies it is ambiguous and refused. A container whose POs are in
 * different currencies cannot carry container charges: the charges state no
 * currency, so they could be neither split by item value nor stated in USD.
 */
export async function resolvePoImportGroupCurrencies(input: {
  companyId: number;
  groups: ReadonlyArray<readonly PoImportPreviewItem[]>;
  importDate: string;
  clientRate: unknown;
  hasContainerCharges: boolean;
}): Promise<{ currencies: PoCurrencyContext[] } | { refusal: PoImportRefusal }> {
  const codes: string[] = [];
  for (const items of input.groups) {
    const code = poImportCurrency(items);
    if (!code) {
      return {
        refusal: {
          status: 400,
          body: {
            code: "PO_IMPORT_MIXED_CURRENCY",
            message: "All items of a purchase order import must be in the same currency.",
          },
        },
      };
    }
    codes.push(code);
  }
  const distinct = new Set(codes);
  if (distinct.size > 1 && input.hasContainerCharges) {
    return {
      refusal: {
        status: 400,
        body: {
          code: "PO_IMPORT_MIXED_CURRENCY_CHARGES",
          message:
            "Container charges cannot be imported for a container whose purchase orders are in different currencies. Import the charges separately.",
        },
      },
    };
  }
  const foreign = [...distinct].filter((code) => code !== "USD");
  const clientRatePresent = input.clientRate !== undefined && input.clientRate !== null && input.clientRate !== "";
  if (foreign.length > 1 && clientRatePresent) {
    return {
      refusal: {
        status: 400,
        body: {
          code: "PO_IMPORT_CLIENT_RATE_AMBIGUOUS",
          message:
            "One exchange rate was sent for purchase orders in several foreign currencies. Send no rate to use the recorded rates.",
        },
      },
    };
  }
  const byCode = new Map<string, PoCurrencyContext>();
  for (const code of distinct) {
    const resolved = await datedPoCurrency(input.companyId, code, input.importDate, input.clientRate);
    if ("refusal" in resolved) return resolved;
    byCode.set(code, resolved.currency);
  }
  const currencies: PoCurrencyContext[] = [];
  for (const code of codes) {
    const context = byCode.get(code);
    if (context) currencies.push(context);
  }
  return { currencies };
}

export interface PoImportLine {
  stockItemId: number;
  itemName: string;
  quantity: string;
  /** USD. */
  rate: string;
  /** USD. */
  lineTotal: string;
  nativeRate: string;
  nativeLineTotal: string;
}

/**
 * The PO's lines with their stock items re-resolved (code/alias first, then
 * name), in USD with the imported figures alongside; the refusal when an item
 * is not found. Nothing is written.
 */
export async function resolvePoImportLines(input: {
  companyId: number;
  items: readonly PoImportPreviewItem[];
  freshStockItems: readonly StockItem[];
  currency: PoCurrencyContext;
}): Promise<{ lines: PoImportLine[] } | { refusal: PoImportRefusal }> {
  const lines: PoImportLine[] = [];
  for (const item of input.items) {
    // Re-lookup stock item by code/alias or name to get fresh ID (not stale preview data)
    let stockItemId = item.stockItemId;
    let stockItem = null;
    if (item.barcode) stockItem = await storage.getStockItemByCodeOrAlias(item.barcode, input.companyId);
    if (!stockItem && item.itemName) stockItem = input.freshStockItems.find((si) => si.name === item.itemName);
    if (stockItem) stockItemId = stockItem.id;
    if (!stockItemId) {
      return {
        refusal: {
          status: 400,
          body: {
            message: `Stock item not found: ${item.barcode || item.itemName}. Please ensure all items exist before importing.`,
          },
        },
      };
    }
    lines.push({
      stockItemId,
      itemName: item.itemName,
      quantity: item.quantity.toString(),
      rate: poUsdRate(item.rate, input.currency).toFixed(2),
      lineTotal: poUsd(item.lineTotal, input.currency).toFixed(2),
      nativeRate: item.rate.toString(),
      nativeLineTotal: item.lineTotal.toString(),
    });
  }
  return { lines };
}

const CONTAINER_CHARGE_TYPES = [
  { key: "freight", type: "Freight", negative: false },
  { key: "surcharge", type: "Surcharge", negative: false },
  { key: "fumigation", type: "Fumigation", negative: false },
  { key: "discount", type: "Discount", negative: true },
  { key: "documentCharges", type: "Document Charges", negative: false },
  { key: "otherCharges", type: "Other Charges", negative: false },
] as const;

export interface PoImportContainerUsd {
  totals: { itemsTotal: string; chargesTotal: string; grandTotal: string };
  /** The container_charges records (a discount negative). */
  charges: Array<{ type: string; amount: string }>;
}

/**
 * The container's totals and charge records in USD (review finding): the
 * `containers` and `container_charges` money columns are read as USD (net
 * position, costing, reporting, PO deletion), like the POs' columns. An
 * all-USD import keeps the preview's figures; otherwise each PO's items and
 * charge shares are converted at that PO's rate — the same cents written on
 * the POs — and summed. Containers have no native columns: the native figures
 * stay on the POs (native_items_total / native_grand_total).
 */
export function poImportContainerUsd(
  preview: PoImportPreviewContainer,
  groups: ReadonlyArray<readonly [string, readonly PoImportPreviewItem[]]>,
  splits: readonly PoChargeSplit[],
  currencies: readonly PoCurrencyContext[]
): PoImportContainerUsd {
  const stated = CONTAINER_CHARGE_TYPES.filter(({ key }) => (preview.charges[key] ?? 0) > 0);
  if (currencies.every((context) => context.currency === "USD")) {
    return {
      totals: {
        itemsTotal: preview.itemsTotal.toString(),
        chargesTotal: preview.chargesTotal.toString(),
        grandTotal: preview.grandTotal.toString(),
      },
      charges: stated.map(({ key, type, negative }) => {
        const amount = preview.charges[key] ?? 0;
        return { type, amount: (negative ? -amount : amount).toString() };
      }),
    };
  }
  const itemsTotal = sumMoney(
    groups.flatMap(([, items], index) => items.map((item) => poUsd(item.lineTotal, currencies[index])))
  );
  const charges = stated.map(({ key, type, negative }) => {
    const usd = sumMoney(splits.map((split, index) => poUsd(split[key], currencies[index])));
    return { type, amount: negative ? usd.negated() : usd };
  });
  const chargesTotal = charges.reduce((sum, charge) => sum.plus(charge.amount), new MoneyDecimal(0));
  return {
    totals: {
      itemsTotal: itemsTotal.toFixed(2),
      chargesTotal: chargesTotal.toFixed(2),
      grandTotal: itemsTotal.plus(chargesTotal).toFixed(2),
    },
    charges: charges.map((charge) => ({ type: charge.type, amount: charge.amount.toFixed(2) })),
  };
}
