/**
 * Standalone browser offline mode (Phase 13–15): the business operations a
 * laptop's browser may record while it has no internet and later deliver
 * straight to the cloud. No factory LAN server is involved.
 *
 * A browser sends only what the person entered (the same body the live route
 * takes). The cloud adds the signed-in user and company itself and builds the
 * same evidence envelope the Phase 9 replay handlers already apply exactly
 * once, so a browser can never assert another user, company or a computed
 * figure (prices, costs, balances).
 */
import { randomUUID } from "node:crypto";
import { inventoryMoney, inventoryQuantity } from "../../lib/inventoryMath";
import { toMoney } from "../../lib/money";
import { paymentReceiptEvidence } from "../../edge/phase9PaymentOutbox";
import { PHASE9_PAYMENT_KIND, phase9PaymentEnvelope } from "../../edge/phase9PaymentEnvelope.mjs";
import {
  PHASE9_STOCK_ADJUST_KIND,
  PHASE9_STOCK_TRANSFER_KIND,
  phase9StockAdjustEnvelope,
  phase9StockTransferEnvelope,
} from "../../edge/phase9StockEnvelope.mjs";
import {
  PHASE9_STOCK_ITEM_CREATE_KIND,
  phase9StockItemCreateEnvelope,
} from "../../edge/phase9StockItemLifecycleEnvelope.mjs";
import { PHASE9_POS_SALE_KIND, phase9PosSaleEnvelope } from "../../edge/phase9PosSaleEnvelope.mjs";
import { stockTransferEvidence } from "../../routes/fiscal-transfers/stockTransferOfflineEvidence";

/** Browser-created records name themselves by a local id in this range, never a cloud id. */
export const BROWSER_LOCAL_REF_BASE = 1_000_000_000;
export const BROWSER_LOCAL_REF_MAX = 2_147_483_647;

export interface BrowserActor {
  companyId: number;
  userId: string;
  username: string;
}

export class BrowserOperationRefusal extends Error {
  constructor(code: string) {
    super(code);
    this.name = "BrowserOperationRefusal";
  }
}

type Body = Record<string, unknown>;

interface BuildContext {
  actor: BrowserActor;
  /** The laptop's device id (a UUID). */
  deviceId: string;
  operationId: string;
  localRef: number;
  /** When the person saved it on the laptop (ISO-8601 UTC). */
  capturedAt: string;
}

export interface BrowserOperationKind {
  stream: "payments" | "stock" | "pos";
  /** The live route whose body this operation carries. */
  route: { method: "POST"; path: string };
  build(input: Body, context: BuildContext): object;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function body(value: unknown): Body {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BrowserOperationRefusal("OFFLINE_BROWSER_INPUT_INVALID");
  }
  return value as Body;
}

function day(value: unknown, fallback: string): string {
  const text = value == null || value === "" ? fallback : String(value).slice(0, 10);
  if (!DAY.test(text)) throw new BrowserOperationRefusal("OFFLINE_BROWSER_DATE_INVALID");
  return text;
}

function positiveId(value: unknown, code: string): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new BrowserOperationRefusal(code);
  return id;
}

function decimalOrNull(value: unknown): string | null {
  if (value == null || value === "") return null;
  return toMoney(String(value)).toFixed();
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * Reference number for a POS sale saved on a laptop, in the existing offline
 * invoice format (LAN-<4 hex of the device>-<6+ digits>). It is only a
 * reference recorded on the cloud voucher; the sale's own id keeps it from
 * posting twice, and the cloud gives the voucher its normal number.
 */
export function browserInvoiceNumber(deviceId: string, localRef: number): string {
  const device = deviceId.replace(/-/g, "").slice(0, 4).toUpperCase();
  return `LAN-${device}-${String(localRef - BROWSER_LOCAL_REF_BASE).padStart(6, "0")}`;
}

export const BROWSER_OPERATION_KINDS: Readonly<Record<string, BrowserOperationKind>> = Object.freeze({
  // POST /api/vouchers/payment-receipt
  [PHASE9_PAYMENT_KIND]: {
    stream: "payments",
    route: { method: "POST", path: "/api/vouchers/payment-receipt" },
    build(raw, { actor, operationId, localRef }) {
      const input = body(raw);
      if (!Array.isArray(input.entries)) throw new BrowserOperationRefusal("OFFLINE_BROWSER_INPUT_INVALID");
      return phase9PaymentEnvelope({
        companyId: actor.companyId,
        localVoucherId: localRef,
        actorUserId: actor.userId,
        actorUsername: actor.username,
        requestId: operationId,
        voucher: paymentReceiptEvidence({
          voucherType: input.voucherType as string,
          voucherDate: day(input.voucherDate, ""),
          paymentAccountType: input.paymentAccountType as string,
          paymentAccountId: positiveId(input.paymentAccountId, "OFFLINE_BROWSER_ACCOUNT_INVALID"),
          entries: input.entries as Array<{ accountType: string; accountId: number; amount: string }>,
          notes: textOrNull(input.notes),
          optional: input.optional === true,
          currency: String(input.currency || "USD"),
          exchangeRate: input.exchangeRate == null || input.exchangeRate === "" ? null : String(input.exchangeRate),
          effectiveDate: input.effectiveDate ? String(input.effectiveDate) : null,
        }),
      });
    },
  },
  // POST /api/inventory/quick-adjust
  [PHASE9_STOCK_ADJUST_KIND]: {
    stream: "stock",
    route: { method: "POST", path: "/api/inventory/quick-adjust" },
    build(raw, { actor, operationId, localRef, capturedAt }) {
      const input = body(raw);
      if (input.type !== "add" && input.type !== "subtract") {
        throw new BrowserOperationRefusal("OFFLINE_BROWSER_INPUT_INVALID");
      }
      return phase9StockAdjustEnvelope({
        companyId: actor.companyId,
        localMovementId: localRef,
        stockItemId: positiveId(input.stockItemId, "OFFLINE_BROWSER_ITEM_INVALID"),
        locationId: positiveId(input.locationId, "OFFLINE_BROWSER_LOCATION_INVALID"),
        actorUserId: actor.userId,
        actorUsername: actor.username,
        requestId: operationId,
        direction: input.type,
        quantity: inventoryQuantity(String(input.quantity ?? "")),
        occurredAt: capturedAt,
        businessDate: capturedAt.slice(0, 10),
      });
    },
  },
  // POST /api/stock-transfers
  [PHASE9_STOCK_TRANSFER_KIND]: {
    stream: "stock",
    route: { method: "POST", path: "/api/stock-transfers" },
    build(raw, { actor, operationId, localRef, capturedAt }) {
      const input = body(raw);
      if (!Array.isArray(input.items)) throw new BrowserOperationRefusal("OFFLINE_BROWSER_INPUT_INVALID");
      return phase9StockTransferEnvelope(
        stockTransferEvidence(
          { session: { userId: actor.userId, username: actor.username } } as never,
          { transfer: { id: localRef } },
          {
            companyId: actor.companyId,
            requestId: operationId,
            items: input.items as Array<{ stockItemId: unknown; quantity: unknown }>,
            sourceLocationId: input.sourceLocationId,
            destinationLocationId: input.destinationLocationId,
            effectiveDate: day(input.effectiveDate ?? input.transferDate, capturedAt.slice(0, 10)),
            notes: input.notes,
            optional: input.optional,
            allowNegativeInventory: input.allowNegativeInventory,
          }
        )
      );
    },
  },
  // POST /api/stock-items
  [PHASE9_STOCK_ITEM_CREATE_KIND]: {
    stream: "stock",
    route: { method: "POST", path: "/api/stock-items" },
    build(raw, { actor, operationId, localRef, capturedAt }) {
      const input = body(raw);
      return phase9StockItemCreateEnvelope({
        companyId: actor.companyId,
        actorUserId: actor.userId,
        actorUsername: actor.username,
        requestId: operationId,
        businessDate: capturedAt.slice(0, 10),
        localStockItemId: localRef,
        item: {
          active: input.active !== false,
          categoryId: input.categoryId ? positiveId(input.categoryId, "OFFLINE_BROWSER_INPUT_INVALID") : null,
          code: String(input.code ?? "").trim(),
          gradeId: input.gradeId ? positiveId(input.gradeId, "OFFLINE_BROWSER_INPUT_INVALID") : null,
          name: String(input.name ?? "").trim(),
          openingQty: decimalOrNull(input.openingQty),
          openingRate: decimalOrNull(input.openingRate),
          openingValue: decimalOrNull(input.openingValue),
          reorderLevel: decimalOrNull(input.reorderLevel),
          sellingPrice: decimalOrNull(input.sellingPrice),
          stockGroupId: positiveId(input.stockGroupId, "OFFLINE_BROWSER_INPUT_INVALID"),
          uom: String(input.uom ?? "").trim(),
        },
      });
    },
  },
  // POST /api/pos/sales
  [PHASE9_POS_SALE_KIND]: {
    stream: "pos",
    route: { method: "POST", path: "/api/pos/sales" },
    build(raw, { actor, deviceId, operationId, localRef, capturedAt }) {
      const input = body(raw);
      if (!Array.isArray(input.items)) throw new BrowserOperationRefusal("OFFLINE_BROWSER_INPUT_INVALID");
      const credit = input.isCreditSale === true;
      const accountId = input.paymentAccountId ?? input.cashAccountId;
      // Offline, the till's session cash account cannot be looked up: the
      // sale must name the account it was paid into (or be a credit sale).
      const paymentAccountId = positiveId(accountId, "OFFLINE_POS_ACCOUNT_REQUIRED");
      const type = credit
        ? "credit"
        : input.paymentAccountType === "bank" || input.paymentMethod === "bank"
          ? "bank"
          : "cash";
      const currency = String(input.currency || "USD").toUpperCase();
      if (currency !== "USD" && (input.exchangeRate == null || input.exchangeRate === "")) {
        throw new BrowserOperationRefusal("OFFLINE_POS_RATE_REQUIRED");
      }
      return phase9PosSaleEnvelope({
        companyId: actor.companyId,
        localVoucherId: localRef,
        lanInvoiceNumber: browserInvoiceNumber(deviceId, localRef),
        locationId: positiveId(input.locationId, "OFFLINE_BROWSER_LOCATION_INVALID"),
        paymentAccountType: type,
        paymentAccountId,
        actorUserId: actor.userId,
        actorUsername: actor.username,
        requestId: operationId,
        currency,
        exchangeRate: currency === "USD" ? null : String(input.exchangeRate),
        voucherDate: day(input.voucherDate, capturedAt.slice(0, 10)),
        notes: textOrNull(input.notes),
        items: (input.items as Body[]).map((item) => ({
          stockItemId: positiveId(item.stockItemId, "OFFLINE_BROWSER_ITEM_INVALID"),
          quantity: inventoryQuantity(String(item.quantity ?? "")),
          rate: inventoryMoney(String(item.rate ?? "")),
          originalCurrencyRate:
            item.originalCurrencyRate == null || item.originalCurrencyRate === ""
              ? null
              : String(item.originalCurrencyRate),
        })),
      });
    },
  },
});

export function browserOperationKind(kind: unknown): BrowserOperationKind | null {
  return typeof kind === "string" && Object.prototype.hasOwnProperty.call(BROWSER_OPERATION_KINDS, kind)
    ? BROWSER_OPERATION_KINDS[kind]
    : null;
}

/** Fresh id for tests and server-side callers; browsers create their own. */
export function newBrowserOperationId(): string {
  return randomUUID();
}
