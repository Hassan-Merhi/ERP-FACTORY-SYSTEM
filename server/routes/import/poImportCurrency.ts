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
import type { PoImportPreviewItem } from "./po-import-preview";

export interface PoImportRefusal {
  status: number;
  body: Record<string, unknown>;
}

/** The PO currency and its rate on the import date, or the refusal to send (400 mixed, 409 rate). */
export async function resolvePoImportCurrency(input: {
  companyId: number;
  items: readonly PoImportPreviewItem[];
  importDate: string;
  clientRate: unknown;
}): Promise<{ currency: PoCurrencyContext } | { refusal: PoImportRefusal }> {
  const code = poImportCurrency(input.items);
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
  try {
    const dated = await checkedDocumentRate(db, {
      companyId: input.companyId,
      currency: code,
      documentDate: String(input.importDate).slice(0, 10),
      clientRate: input.clientRate,
    });
    return { currency: { currency: dated.currency, unitsPerUsd: dated.rate ?? "1" } };
  } catch (error: unknown) {
    if (isDocumentRateError(error)) return { refusal: { status: error.statusCode, body: error.body } };
    throw error;
  }
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
