/**
 * server/services/pos/posSaleTypes.ts
 *
 * Shared types for the POS sale-creation flow (PHASE 19 structural split).
 * Pure type definitions only — no behavior.
 */
import type { ledgerAccounts, locations, vouchers, salesItems } from "@shared/schema";

/** A ledger account row as stored — customer receivable, cash, or sales revenue. */
export type PosLedgerAccount = typeof ledgerAccounts.$inferSelect;
/** The selling location a sale is booked against. */
export type PosLocation = typeof locations.$inferSelect;
/** The voucher a completed sale writes. */
export type PosSaleVoucher = typeof vouchers.$inferSelect;
/** One persisted sale line. */
export type PosSaleItemRow = typeof salesItems.$inferSelect;

export interface HandlerErrorResult {
  status: number;
  body: Record<string, unknown>;
}

/**
 * One sale line exactly as a POS client submits it. Numeric fields arrive
 * unparsed — the flow validates and coerces them before use.
 */
export interface PosSaleItemInput {
  stockItemId: number;
  quantity: number | string;
  rate: number | string;
  /** Original ZMW unit price, supplied when currency is ZMW (not USD). */
  originalCurrencyRate?: number | string;
}

/** The inventory row backing one sale line, as read by the availability pre-check. */
export interface PosInventoryRecord {
  id: number;
  locationId: number;
  stockItemId: number;
  quantity: string;
  averageRate: string;
  itemName: string | null;
}

export interface ResolvedPaymentAccount {
  accountType: "cash" | "bank" | "credit";
  accountId: number;
  customerAccount: PosLedgerAccount | null;
}

export interface ValidatedInventoryItem {
  item: PosSaleItemInput;
  inventoryRecord: PosInventoryRecord;
  currentQty: number;
  saleQty: number;
  newQty: number;
  currentRate: number;
}

export interface SupplierPartnerAccountingContext {
  isSpCompany: boolean;
  spPosPayableAccountId: number | null;
  spPosProfitAccountId: number | null;
  spPosCostClrAccountId: number | null;
  spPosDeductionClrAccountId: number | null;
  totalSupplierCost: number;
  spPosDeductionPerQty: number;
  spPosTotalQtySold: number;
}

/** The POST /api/pos/sales request body. Every field arrives unvalidated. */
export interface PosSaleRequestBody {
  locationId?: number | string | null;
  cashAccountId?: number | null;
  paymentAccountType?: string | null;
  paymentAccountId?: number | null;
  items: PosSaleItemInput[];
  notes?: string | null;
  isCreditSale?: boolean | null;
  voucherDate?: string | null;
  shiftId?: number | null;
  clientSaleId?: string;
  currency?: string | null;
  exchangeRate?: string | number | null;
  targetCompanyId?: number | string | null;
}

/**
 * An enriched sale line echoed back for a freshly created sale. A replayed
 * (idempotent) sale returns the persisted rows instead.
 */
export interface PosSaleItemEcho extends PosSaleItemInput {
  stockItemName: string;
  stockItemCode: string;
  amount: string;
  configuredPrice: string;
  profitPerUnit: string;
  totalProfitVsConfigured: string;
}

/** A sale line as the response carries it: a persisted row, or a fresh echo. */
export type PosSaleResponseItem = PosSaleItemRow | PosSaleItemEcho;

/** The success body returned for a created (or replayed) POS sale. */
export interface PosSaleResponseBody {
  voucher: PosSaleVoucher;
  location: PosLocation | null;
  items: PosSaleResponseItem[];
  grandTotal: string | number;
  voucherNumber: string | null;
  saleDate: string | null;
  isCreditSale: boolean | null | undefined;
  customer: { id: number; code: string | null; name: string } | null;
  _idempotent?: boolean;
}

/** The created sale, exactly as the endpoint returns it. */
export type CreatedPosSaleResult = { status: number; body: PosSaleResponseBody };

/** Either the created sale or a mapped handler error. */
export type CreatePosSaleResult = CreatedPosSaleResult | HandlerErrorResult;

/**
 * Narrows a sale result to the created-sale branch. The error body is an open
 * record, so the two branches only separate on the values the handler actually
 * returns: a 200 carrying a voucher.
 */
export function isCreatedPosSale(result: CreatePosSaleResult): result is CreatedPosSaleResult {
  return result.status === 200 && "voucher" in result.body;
}

export interface CreatePosSaleParams {
  currentCompanyId: number;
  userId: string;
  username: string;
  userRole: string | undefined;
  canSellNegativeStock: boolean;
  sessionCashAccountId: number | null | undefined;
  voucherDateFallback: string;
  body: PosSaleRequestBody;
}
