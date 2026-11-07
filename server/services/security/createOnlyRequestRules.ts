/**
 * Pure request rules for handler-verified Create Only creates.
 *
 * Each rule returns true when a request must be REFUSED for Create Only: it
 * would set a field that belongs to an existing record's later lifecycle, post
 * an opening balance or opening stock, re-link history, reach another company,
 * or date a record outside today. Rules are pure so they can be tested without
 * a database; company-ownership lookups live in createOnlyVerifiedCreates.ts.
 */
type Body = Record<string, unknown>;

export type CreateOnlyRequestBody = Body;

/** Normalize an Express request body to a plain object for rule checks. */
export function requestBody(value: unknown): Body {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Body) : {};
}

/** True when a field is present with a value other than null/undefined/"". */
export function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

/** True when a money/quantity field is present and is not exactly zero. */
export function isNonZeroAmount(value: unknown): boolean {
  if (!isPresent(value)) return false;
  const amount = Number(value);
  return !Number.isFinite(amount) || amount !== 0;
}

/** First day of the month containing `isoDate` (YYYY-MM-DD). */
export function firstDayOfMonth(isoDate: string): string {
  return `${isoDate.slice(0, 7)}-01`;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Maximum bales one Create Only request may create in a pressing batch. */
export const CREATE_ONLY_MAX_BALES_PER_BATCH = 200;
/** Upper bound for one bale's planned weight in kg; larger values are refused. */
export const CREATE_ONLY_MAX_KG_PER_BALE = 2000;

/** Customer order fields that belong to later lifecycle steps, never to a new draft. */
export const CUSTOMER_ORDER_LIFECYCLE_FIELDS = [
  "previousStatus",
  "verifiedByUserId",
  "verifiedAt",
  "loadingStartedAt",
  "loadingFinalizedAt",
  "finalizedAt",
  "invoiceNumber",
  "dispatchBatchId",
  "deletedAt",
  "bookingInfo",
] as const;

/** Customer order totals are computed later from lines; a new draft starts at zero. */
export const CUSTOMER_ORDER_TOTAL_FIELDS = [
  "subtotalBales",
  "freightAmount",
  "otherChargesTotal",
  "grandTotal",
  "totalQtyBales",
] as const;

export const createOnlyRequestRules = {
  /** Opening balances post a financial balance; a linked ledger re-attributes history. */
  customer(b: Body): boolean {
    return isNonZeroAmount(b.openingBalance) || isPresent(b.ledgerAccountId) || isPresent(b.deletedAt);
  },
  /** Opening quantity/rate/value create opening stock without a source document. */
  stockItem(b: Body): boolean {
    return (
      isNonZeroAmount(b.openingQty) ||
      isNonZeroAmount(b.openingRate) ||
      isNonZeroAmount(b.openingValue) ||
      isPresent(b.deletedAt)
    );
  },
  /** Bale batches create PENDING_PRESSING bales only; cap volume and require sane weights. */
  baleBatch(b: Body): boolean {
    const quantity = Number(b.quantity);
    const weight = Number(b.weightPerBale);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > CREATE_ONLY_MAX_BALES_PER_BATCH) return true;
    return !Number.isFinite(weight) || weight <= 0 || weight > CREATE_ONLY_MAX_KG_PER_BALE;
  },
  /**
   * A new order is a DRAFT dated today: no lifecycle, invoice, booking or total
   * fields, and no backdated or future-dated order date.
   */
  customerOrderFields(b: Body, today: string): boolean {
    const orderDate = typeof b.orderDate === "string" ? b.orderDate.slice(0, 10) : "";
    if (orderDate !== today) return true;
    if (isPresent(b.status) && b.status !== "DRAFT") return true;
    if (b.isHidden === true) return true;
    if (CUSTOMER_ORDER_LIFECYCLE_FIELDS.some((field) => isPresent(b[field]))) return true;
    return CUSTOMER_ORDER_TOTAL_FIELDS.some((field) => isNonZeroAmount(b[field]));
  },
  /** A new unit starts active; creating it inactive is a later state change. */
  rentalUnit(b: Body): boolean {
    return b.active === false;
  },
  /**
   * A new contract starts ACTIVE, belongs to this company only, carries no
   * guarantee posting state and cannot accrue receivables for earlier months.
   */
  rentalContract(b: Body, today: string): boolean {
    if (isPresent(b.status) && b.status !== "ACTIVE") return true;
    if (isPresent(b.linkedCompanyId)) return true;
    if (b.isInternal === true) return true;
    if (b.guaranteePostedToStatement === true) return true;
    if (isNonZeroAmount(b.guaranteePostedAmount)) return true;
    const startDate = typeof b.startDate === "string" ? b.startDate.slice(0, 10) : "";
    if (!ISO_DATE.test(startDate)) return true;
    return startDate < firstDayOfMonth(today);
  },
  /** A new product may not carry opening stock or edit markers on its variants. */
  retailProduct(b: Body): boolean {
    const variants = b.variants;
    if (variants === undefined) return false;
    if (!Array.isArray(variants)) return true;
    return variants.some((variant) => {
      if (!variant || typeof variant !== "object") return true;
      const v = variant as Body;
      if (isPresent(v.id)) return true;
      const stocks = v.stocks;
      if (stocks === undefined || stocks === null) return false;
      return !Array.isArray(stocks) || stocks.length > 0;
    });
  },
  /** A Create Only SP sale is dated today; no backdated or future-dated sales. */
  spSale(b: Body, today: string): boolean {
    if (!isPresent(b.saleDate)) return false;
    return String(b.saleDate).slice(0, 10) !== today;
  },
};
