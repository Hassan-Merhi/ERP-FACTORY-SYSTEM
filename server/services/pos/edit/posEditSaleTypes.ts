/**
 * server/services/pos/edit/posEditSaleTypes.ts
 *
 * Shared types for the POS edit-sale flow (PHASE 20 structural split).
 * Pure type definitions only — no behavior.
 */
import type { salesItems, voucherEntries, vouchers } from "@shared/schema";
import { POS_INTERNAL_TOTAL_SALES_OVERRIDE } from "./posEditInternalSymbols";

export type VoucherRow = typeof vouchers.$inferSelect;
export type VoucherEntryRow = typeof voucherEntries.$inferSelect;
export type SalesItemRow = typeof salesItems.$inferSelect;

/**
 * One sale line entering the edit flow. JSON clients send quantity and price
 * as strings or numbers; the trusted in-process caller (item replacement)
 * additionally carries the non-serializable symbol marker that preserves an
 * exact historical rounded line total.
 */
export interface PosEditSaleItemInput {
  id?: number;
  stockItemId: number;
  quantity: string | number | null | undefined;
  sellingPrice: string | number | null | undefined;
  totalSales?: string | number | null;
  [POS_INTERNAL_TOTAL_SALES_OVERRIDE]?: boolean;
}

/**
 * Body returned by updatePosSale: an error message on non-200 results, the
 * updated sale payload on success. Extra payload fields stay indexable so the
 * route can forward the body unchanged to res.json().
 */
export type PosSaleUpdateResponseBody = {
  message?: string;
  voucher?: VoucherRow;
  [key: string]: unknown;
};

export interface HandlerErrorResult {
  status: number;
  body: Record<string, unknown>;
}

/** Result of fetching the supplier-partner accounting configuration for edit-sale. */
export interface SpEditAccountingContext {
  isSpCompanyEdit: boolean;
  editSpPayableAccountId: number | null;
  editSpProfitAccountId: number | null;
  editSpCostClrAccountId: number | null;
  editSpDeductionClrAccountId: number | null;
}

export interface UpdatePosSaleParams {
  voucherId: number;
  currentCompanyId: number;
  userId: string;
  username: string;
  userRole: string | undefined;
  canSellNegativeStock: boolean;
  body: {
    description: unknown;
    items: unknown[];
    paymentAccountType: unknown;
    paymentAccountId: unknown;
    isCreditSale: unknown;
    voucherDate: unknown;
    locationId: unknown;
  };
}
