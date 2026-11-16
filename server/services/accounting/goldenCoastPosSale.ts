// ── Golden Coast Phase 5: post-cutover POS sale FIFO + accounting planner ─────
//
// Phase 5 owns the *production* Golden Coast sale flow that runs on top of the
// September 1, 2026 cutover:
//
//   * Phase 3 posted the opening balance sheet (Stock in Hand opening value).
//   * Phase 4 populated the canonical post-cutover FIFO lots in
//     `sp_stock_movements` from that same opening value, so every unit on the
//     floor now carries a real acquisition cost.
//   * Phase 5 consumes those lots when a sale is posted and derives COGS from
//     the consumed lots — never from a user-entered estimate.
//
// This module is deliberately pure: it takes plain rows and returns the FIFO
// allocation plan plus the two central-posting requests. Everything that needs
// a database (lot locking, inventory adjustment, voucher writes) lives in the
// route so the accounting arithmetic can be unit tested without one.
//
// Journal shape for one sale (both vouchers carry the sale location):
//
//   Revenue voucher   Dr  Golden Coast sale-side balance   = revenue
//                     Cr  Sales                            = revenue
//   COGS voucher      Dr  Cost of Goods Sold               = FIFO cost
//                     Cr  Stock in Hand                    = FIFO cost
//
// The Phase 1 single-voucher `location_sale` mutation path and the retired
// Supplier Partner `/api/sp/sales` payable-only posting are intentionally NOT
// reused: Phase 4 retired both for Golden Coast companies.

import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import { releaseDebtEnglish } from "../../i18n/finalCloseoutEnglish";
import type { CentralPostingRequest, PostingActor } from "./centralPostingEngine";
import { buildGenericVoucherPostingRequest } from "./genericVoucherPosting";
import { GOLDEN_COAST_CUTOVER_FIFO_SOURCE } from "./goldenCoastCutoverFifo";
import { GOLDEN_COAST_PHASE8_OFFLOAD_FIFO_SOURCE } from "./goldenCoastContainerOffload";

/** Posting `sourceType` every Phase 5 sale voucher is tagged with. */
export const GOLDEN_COAST_PHASE5_SOURCE_TYPE = "golden-coast-phase5-pos-sale";
/** Cost lots created lazily from the current ERP inventory without a cutover journal. */
export const GOLDEN_COAST_CURRENT_INVENTORY_FIFO_SOURCE = "golden-coast-current-inventory";

/**
 * `sp_stock_movements.source_type` values a Golden Coast sale may consume.
 *
 * Legacy movement rows are intentionally excluded. Golden Coast can consume
 * either an existing canonical lot, a Phase 8 offload lot, or a lot lazily
 * created from the current ERP inventory when no cutover was performed.
 */
export const GOLDEN_COAST_POST_CUTOVER_FIFO_SOURCES: readonly string[] = [
  GOLDEN_COAST_CUTOVER_FIFO_SOURCE,
  GOLDEN_COAST_PHASE8_OFFLOAD_FIFO_SOURCE,
  GOLDEN_COAST_CURRENT_INVENTORY_FIFO_SOURCE,
];

/** Keeps the derived voucher numbers inside `vouchers.voucher_number` (100). */
export const GOLDEN_COAST_PHASE5_MAX_REQUEST_ID_LENGTH = 64;

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const QUANTITY_SCALE = 4;
const UNIT_COST_SCALE = 6;
const MONEY_SCALE = 2;

export type GoldenCoastPhase5ErrorCode =
  | "GC_PHASE5_INPUT_INVALID"
  | "GC_PHASE5_FIFO_INSUFFICIENT"
  | "GC_PHASE5_FIFO_COST_INVALID"
  | "GC_PHASE5_SCOPE_MISMATCH"
  | "GC_PHASE5_PRE_CUTOVER_DATE";

export class GoldenCoastPhase5SaleError extends Error {
  readonly code: GoldenCoastPhase5ErrorCode;

  constructor(message: string, code: GoldenCoastPhase5ErrorCode = "GC_PHASE5_INPUT_INVALID") {
    super(releaseDebtEnglish(message));
    this.name = "GoldenCoastPhase5SaleError";
    this.code = code;
  }
}

// ── Input shapes ─────────────────────────────────────────────────────────────

/** One post-cutover FIFO lot, as stored in `sp_stock_movements`. */
export interface GoldenCoastFifoLot {
  id: number;
  companyId: number;
  locationId: number | null;
  stockItemId: number | null;
  articleCode: string;
  description?: string | null;
  sourceType?: string | null;
  qtyRemaining: string | number;
  finalUnitCostUsd: string | number;
  /** Ordering key; `sp_stock_movements.created_at`. */
  createdAt?: string | Date | null;
}

export interface GoldenCoastPhase5SaleLineInput {
  stockItemId: number;
  qty: string | number;
  unitPriceUsd: string | number;
  description?: string | null;
}

export interface GoldenCoastPhase5SaleInput {
  companyId: number;
  locationId: number;
  saleDate: string;
  customerName: string;
  clientRequestId: string;
  lines: readonly GoldenCoastPhase5SaleLineInput[];
  notes?: string | null;
}

export interface GoldenCoastPhase5RoleAccounts {
  /** Golden Coast sale-side / cash balance debited for the revenue. */
  saleSideAccountId: number;
  /** `sp_sales` — Sales revenue. */
  salesRevenueAccountId: number;
  /** `sp_cogs` — Cost of Goods Sold. */
  cogsAccountId: number;
  /** `sp_stock` — Stock in Hand. */
  stockInHandAccountId: number;
}

// ── Output shapes ────────────────────────────────────────────────────────────

export interface GoldenCoastPhase5Allocation {
  lotId: number;
  stockItemId: number;
  locationId: number;
  articleCode: string;
  description: string | null;
  qty: string;
  unitCostUsd: string;
  costUsd: string;
  qtyRemainingBefore: string;
  qtyRemainingAfter: string;
}

export interface GoldenCoastPhase5PlannedLine {
  stockItemId: number;
  qty: string;
  unitPriceUsd: string;
  revenueUsd: string;
  cogsUsd: string;
  grossProfitUsd: string;
  allocations: GoldenCoastPhase5Allocation[];
}

export interface GoldenCoastPhase5SalePlan {
  companyId: number;
  locationId: number;
  saleDate: string;
  customerName: string;
  clientRequestId: string;
  revenueUsd: string;
  cogsUsd: string;
  grossProfitUsd: string;
  totalQty: string;
  lines: GoldenCoastPhase5PlannedLine[];
  allocations: GoldenCoastPhase5Allocation[];
}

// ── Parsing helpers ──────────────────────────────────────────────────────────

function positiveId(value: unknown, label: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new GoldenCoastPhase5SaleError(`${label} must be a positive integer`);
  }
  return id;
}

/**
 * decimal.js keeps a positive sign on zero, so `isPositive()` is true for 0.
 * Every sign test in this module is therefore written as an explicit
 * comparison against zero — a quantity or cost of exactly zero must never pass
 * a "greater than zero" gate.
 */
function decimalOf(value: unknown, label: string, code: GoldenCoastPhase5ErrorCode): Decimal {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new GoldenCoastPhase5SaleError(`${label} must be a number or numeric string`, code);
  }
  let parsed: Decimal;
  try {
    parsed = new Decimal(value);
  } catch {
    throw new GoldenCoastPhase5SaleError(`${label} must be numeric`, code);
  }
  if (!parsed.isFinite()) throw new GoldenCoastPhase5SaleError(`${label} must be a finite number`, code);
  return parsed;
}

function requiredText(value: unknown, label: string, maxLength: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new GoldenCoastPhase5SaleError(`${label} is required`);
  if (text.length > maxLength) {
    throw new GoldenCoastPhase5SaleError(`${label} must be at most ${maxLength} characters`);
  }
  return text;
}

function optionalText(value: unknown, label: string, maxLength: number): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new GoldenCoastPhase5SaleError(`${label} must be a string`);
  const text = value.trim();
  if (!text) return null;
  if (text.length > maxLength) {
    throw new GoldenCoastPhase5SaleError(`${label} must be at most ${maxLength} characters`);
  }
  return text;
}

function saleDate(value: unknown): string {
  const text = requiredText(value, "saleDate", 10);
  if (!ISO_DATE_PATTERN.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) {
    throw new GoldenCoastPhase5SaleError("saleDate must be an ISO calendar date (YYYY-MM-DD)");
  }
  return text;
}

function clientRequestId(value: unknown): string {
  const text = requiredText(value, "clientRequestId", GOLDEN_COAST_PHASE5_MAX_REQUEST_ID_LENGTH);
  if (!REQUEST_ID_PATTERN.test(text)) {
    throw new GoldenCoastPhase5SaleError("clientRequestId contains unsupported characters");
  }
  return text;
}

/**
 * Normalizes an untrusted request body into a Phase 5 sale input. Every failure
 * is a hard error: Phase 5 never silently drops or repairs a sale line.
 */
export function parseGoldenCoastPhase5SaleInput(input: {
  companyId: number;
  body: unknown;
  maxLines?: number;
}): GoldenCoastPhase5SaleInput {
  const companyId = positiveId(input.companyId, "companyId");
  const body = input.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new GoldenCoastPhase5SaleError("A Golden Coast sale request body is required");
  }
  const raw = body as Record<string, unknown>;
  const maxLines = input.maxLines ?? 100;

  if (!Array.isArray(raw.lines) || raw.lines.length === 0) {
    throw new GoldenCoastPhase5SaleError("lines must contain at least one sale line");
  }
  if (raw.lines.length > maxLines) {
    throw new GoldenCoastPhase5SaleError(`lines must contain at most ${maxLines} sale lines`);
  }

  const seenStockItems = new Set<number>();
  const lines: GoldenCoastPhase5SaleLineInput[] = raw.lines.map((rawLine, index) => {
    if (!rawLine || typeof rawLine !== "object" || Array.isArray(rawLine)) {
      throw new GoldenCoastPhase5SaleError(`lines[${index}] must be an object`);
    }
    const line = rawLine as Record<string, unknown>;
    const stockItemId = positiveId(line.stockItemId, `lines[${index}].stockItemId`);
    if (seenStockItems.has(stockItemId)) {
      throw new GoldenCoastPhase5SaleError(
        `lines[${index}] repeats stock item #${stockItemId}; combine repeated items into a single line`
      );
    }
    seenStockItems.add(stockItemId);

    const qty = decimalOf(line.qty, `lines[${index}].qty`, "GC_PHASE5_INPUT_INVALID");
    if (!qty.greaterThan(0)) {
      throw new GoldenCoastPhase5SaleError(`lines[${index}].qty must be greater than zero`);
    }
    if (qty.decimalPlaces() > QUANTITY_SCALE) {
      throw new GoldenCoastPhase5SaleError(`lines[${index}].qty supports at most ${QUANTITY_SCALE} decimal places`);
    }

    const unitPrice = decimalOf(line.unitPriceUsd, `lines[${index}].unitPriceUsd`, "GC_PHASE5_INPUT_INVALID");
    if (unitPrice.lessThan(0)) {
      throw new GoldenCoastPhase5SaleError(`lines[${index}].unitPriceUsd cannot be negative`);
    }
    if (unitPrice.decimalPlaces() > MONEY_SCALE) {
      throw new GoldenCoastPhase5SaleError(
        `lines[${index}].unitPriceUsd supports at most ${MONEY_SCALE} decimal places`
      );
    }

    return {
      stockItemId,
      qty: qty.toFixed(),
      unitPriceUsd: unitPrice.toFixed(),
      description: optionalText(line.description, `lines[${index}].description`, 200),
    };
  });

  return {
    companyId,
    locationId: positiveId(raw.locationId, "locationId"),
    saleDate: saleDate(raw.saleDate),
    customerName: requiredText(raw.customerName, "customerName", 200),
    clientRequestId: clientRequestId(raw.clientRequestId),
    lines,
    notes: optionalText(raw.notes, "notes", 500),
  };
}

// ── FIFO planner ─────────────────────────────────────────────────────────────

function lotSortKey(lot: GoldenCoastFifoLot): [number, number] {
  const raw = lot.createdAt;
  const timestamp = raw == null ? 0 : new Date(raw).getTime();
  return [Number.isFinite(timestamp) ? timestamp : 0, Number(lot.id)];
}

function orderLots(lots: readonly GoldenCoastFifoLot[]): GoldenCoastFifoLot[] {
  return [...lots].sort((a, b) => {
    const [aTime, aId] = lotSortKey(a);
    const [bTime, bId] = lotSortKey(b);
    return aTime === bTime ? aId - bId : aTime - bTime;
  });
}

/**
 * Consumes FIFO lots for one sale and derives the exact cost of the units sold.
 *
 * Fail-closed conditions: a lot from another company or location, a lot that is
 * not a canonical post-cutover movement row, a non-numeric/negative/zero unit
 * cost on a consumed lot, and any line whose requested quantity exceeds the
 * quantity actually remaining. There is no quantity tolerance: a sale either
 * has the stock behind it or it does not post.
 */
export function planGoldenCoastPhase5Sale(input: {
  sale: GoldenCoastPhase5SaleInput;
  lots: readonly GoldenCoastFifoLot[];
}): GoldenCoastPhase5SalePlan {
  const { sale } = input;
  const companyId = positiveId(sale.companyId, "companyId");
  const locationId = positiveId(sale.locationId, "locationId");

  const seenLotIds = new Set<number>();
  const lotsByStockItem = new Map<number, GoldenCoastFifoLot[]>();
  for (const lot of input.lots ?? []) {
    const lotId = positiveId(lot.id, "lot id");
    if (seenLotIds.has(lotId)) {
      throw new GoldenCoastPhase5SaleError(`FIFO lot #${lotId} was supplied more than once`);
    }
    seenLotIds.add(lotId);

    if (Number(lot.companyId) !== companyId) {
      throw new GoldenCoastPhase5SaleError(
        `FIFO lot #${lotId} belongs to company ${lot.companyId}, not company ${companyId}`,
        "GC_PHASE5_SCOPE_MISMATCH"
      );
    }
    if (lot.locationId == null || Number(lot.locationId) !== locationId) {
      throw new GoldenCoastPhase5SaleError(
        `FIFO lot #${lotId} is not held at location ${locationId}`,
        "GC_PHASE5_SCOPE_MISMATCH"
      );
    }
    if (lot.stockItemId == null || !Number.isInteger(Number(lot.stockItemId)) || Number(lot.stockItemId) <= 0) {
      throw new GoldenCoastPhase5SaleError(
        `FIFO lot #${lotId} is not linked to a stock item and cannot be sold`,
        "GC_PHASE5_SCOPE_MISMATCH"
      );
    }
    if (!GOLDEN_COAST_POST_CUTOVER_FIFO_SOURCES.includes(String(lot.sourceType ?? ""))) {
      throw new GoldenCoastPhase5SaleError(
        `FIFO lot #${lotId} is a ${lot.sourceType ?? "untyped"} movement, not a canonical Golden Coast ` +
          `post-cutover lot, and cannot back a sale`,
        "GC_PHASE5_SCOPE_MISMATCH"
      );
    }

    const stockItemId = Number(lot.stockItemId);
    const bucket = lotsByStockItem.get(stockItemId);
    if (bucket) bucket.push(lot);
    else lotsByStockItem.set(stockItemId, [lot]);
  }

  let revenueTotal = new Decimal(0);
  let cogsTotal = new Decimal(0);
  let qtyTotal = new Decimal(0);
  const allAllocations: GoldenCoastPhase5Allocation[] = [];

  const lines: GoldenCoastPhase5PlannedLine[] = sale.lines.map((line) => {
    const stockItemId = positiveId(line.stockItemId, "line.stockItemId");
    const qty = decimalOf(line.qty, `line ${stockItemId} qty`, "GC_PHASE5_INPUT_INVALID");
    const unitPrice = decimalOf(line.unitPriceUsd, `line ${stockItemId} unitPriceUsd`, "GC_PHASE5_INPUT_INVALID");
    const candidates = orderLots(lotsByStockItem.get(stockItemId) ?? []);

    let available = new Decimal(0);
    for (const lot of candidates) {
      const remaining = decimalOf(lot.qtyRemaining, `FIFO lot #${lot.id} qtyRemaining`, "GC_PHASE5_FIFO_COST_INVALID");
      if (remaining.lessThan(0)) {
        throw new GoldenCoastPhase5SaleError(
          `FIFO lot #${lot.id} has a negative remaining quantity`,
          "GC_PHASE5_FIFO_COST_INVALID"
        );
      }
      available = available.plus(remaining);
    }
    if (available.lessThan(qty)) {
      throw new GoldenCoastPhase5SaleError(
        `Insufficient Golden Coast FIFO stock for stock item #${stockItemId} at location ${locationId}: ` +
          `available ${available.toDecimalPlaces(QUANTITY_SCALE).toFixed(QUANTITY_SCALE)}, ` +
          `requested ${qty.toDecimalPlaces(QUANTITY_SCALE).toFixed(QUANTITY_SCALE)}`,
        "GC_PHASE5_FIFO_INSUFFICIENT"
      );
    }

    const allocations: GoldenCoastPhase5Allocation[] = [];
    let outstanding = qty;
    let lineCost = new Decimal(0);

    for (const lot of candidates) {
      if (!outstanding.greaterThan(0)) break;
      const remaining = decimalOf(lot.qtyRemaining, `FIFO lot #${lot.id} qtyRemaining`, "GC_PHASE5_FIFO_COST_INVALID");
      if (!remaining.greaterThan(0)) continue;

      const unitCost = decimalOf(
        lot.finalUnitCostUsd,
        `FIFO lot #${lot.id} finalUnitCostUsd`,
        "GC_PHASE5_FIFO_COST_INVALID"
      );
      if (!unitCost.greaterThan(0)) {
        throw new GoldenCoastPhase5SaleError(
          `FIFO lot #${lot.id} has a non-positive unit cost and cannot back a Golden Coast sale`,
          "GC_PHASE5_FIFO_COST_INVALID"
        );
      }

      const consumed = Decimal.min(outstanding, remaining);
      const cost = consumed.times(unitCost);
      outstanding = outstanding.minus(consumed);
      lineCost = lineCost.plus(cost);

      const allocation: GoldenCoastPhase5Allocation = {
        lotId: Number(lot.id),
        stockItemId,
        locationId,
        articleCode: String(lot.articleCode ?? "").trim(),
        description: lot.description == null ? null : String(lot.description),
        qty: consumed.toDecimalPlaces(QUANTITY_SCALE).toFixed(QUANTITY_SCALE),
        unitCostUsd: unitCost.toDecimalPlaces(UNIT_COST_SCALE).toFixed(UNIT_COST_SCALE),
        costUsd: cost.toDecimalPlaces(MONEY_SCALE).toFixed(MONEY_SCALE),
        qtyRemainingBefore: remaining.toDecimalPlaces(QUANTITY_SCALE).toFixed(QUANTITY_SCALE),
        qtyRemainingAfter: remaining.minus(consumed).toDecimalPlaces(QUANTITY_SCALE).toFixed(QUANTITY_SCALE),
      };
      allocations.push(allocation);
      allAllocations.push(allocation);
    }

    if (outstanding.greaterThan(0)) {
      // Unreachable while the availability check above holds; kept so a future
      // change to lot filtering can never post a partially covered sale line.
      throw new GoldenCoastPhase5SaleError(
        `Golden Coast FIFO consumption for stock item #${stockItemId} did not cover the full quantity`,
        "GC_PHASE5_FIFO_INSUFFICIENT"
      );
    }

    const lineRevenue = qty.times(unitPrice).toDecimalPlaces(MONEY_SCALE);
    const roundedLineCost = lineCost.toDecimalPlaces(MONEY_SCALE);
    revenueTotal = revenueTotal.plus(lineRevenue);
    cogsTotal = cogsTotal.plus(roundedLineCost);
    qtyTotal = qtyTotal.plus(qty);

    return {
      stockItemId,
      qty: qty.toDecimalPlaces(QUANTITY_SCALE).toFixed(QUANTITY_SCALE),
      unitPriceUsd: unitPrice.toDecimalPlaces(MONEY_SCALE).toFixed(MONEY_SCALE),
      revenueUsd: lineRevenue.toFixed(MONEY_SCALE),
      cogsUsd: roundedLineCost.toFixed(MONEY_SCALE),
      grossProfitUsd: lineRevenue.minus(roundedLineCost).toFixed(MONEY_SCALE),
      allocations,
    };
  });

  if (!revenueTotal.greaterThan(0)) {
    throw new GoldenCoastPhase5SaleError("A Golden Coast sale must post a positive revenue amount");
  }
  if (!cogsTotal.greaterThan(0)) {
    throw new GoldenCoastPhase5SaleError(
      "Golden Coast FIFO consumption produced no cost of goods sold",
      "GC_PHASE5_FIFO_COST_INVALID"
    );
  }

  return {
    companyId,
    locationId,
    saleDate: sale.saleDate,
    customerName: sale.customerName,
    clientRequestId: sale.clientRequestId,
    revenueUsd: revenueTotal.toFixed(MONEY_SCALE),
    cogsUsd: cogsTotal.toFixed(MONEY_SCALE),
    grossProfitUsd: revenueTotal.minus(cogsTotal).toFixed(MONEY_SCALE),
    totalQty: qtyTotal.toDecimalPlaces(QUANTITY_SCALE).toFixed(QUANTITY_SCALE),
    lines,
    allocations: allAllocations,
  };
}

// ── Posting builder ──────────────────────────────────────────────────────────

export type GoldenCoastPhase5PostingRole = "revenue" | "cogs";

export interface GoldenCoastPhase5Posting {
  role: GoldenCoastPhase5PostingRole;
  request: CentralPostingRequest;
}

export interface GoldenCoastPhase5PostingBatch {
  clientRequestId: string;
  saleDigest: string;
  revenueVoucherNumber: string;
  cogsVoucherNumber: string;
  postings: GoldenCoastPhase5Posting[];
}

export function goldenCoastPhase5VoucherNumber(companyId: number, requestId: string): string {
  return `GC-POS-C${companyId}-${requestId}`;
}

/**
 * Stable digest of everything about a sale request that changes its accounting
 * meaning. It is persisted in the posting `sourceId`, so a caller that reuses a
 * `clientRequestId` with different sale data is rejected instead of being
 * silently handed the original sale's vouchers.
 */
export function goldenCoastPhase5SaleDigest(input: {
  sale: GoldenCoastPhase5SaleInput;
  saleSideAccount: GoldenCoastPhase5SaleSideAccount;
}): string {
  const { sale, saleSideAccount } = input;
  return createHash("sha256")
    .update(
      JSON.stringify({
        companyId: sale.companyId,
        locationId: sale.locationId,
        saleDate: sale.saleDate,
        customerName: sale.customerName,
        notes: sale.notes ?? null,
        saleSideAccount: { kind: saleSideAccount.kind, id: saleSideAccount.id },
        lines: sale.lines.map((line) => ({
          stockItemId: line.stockItemId,
          qty: new Decimal(line.qty).toFixed(),
          unitPriceUsd: new Decimal(line.unitPriceUsd).toFixed(),
          description: line.description ?? null,
        })),
      })
    )
    .digest("hex")
    .slice(0, 32);
}

export function goldenCoastPhase5SourceId(
  requestId: string,
  saleDigest: string,
  role: GoldenCoastPhase5PostingRole
): string {
  return `${requestId}:${saleDigest}:${role}`;
}

export function goldenCoastPhase5IdempotencyKey(
  companyId: number,
  requestId: string,
  role: GoldenCoastPhase5PostingRole
): string {
  return `${GOLDEN_COAST_PHASE5_SOURCE_TYPE}:${companyId}:${requestId}:${role}`;
}

/** Sale-side account the revenue is debited to: a ledger or a bank account. */
export interface GoldenCoastPhase5SaleSideAccount {
  kind: "ledger" | "bank";
  id: number;
}

function saleSideEntryTarget(account: GoldenCoastPhase5SaleSideAccount): Record<string, number> {
  return account.kind === "bank" ? { bankAccountId: account.id } : { ledgerAccountId: account.id };
}

/**
 * Builds the two balanced central-posting requests for one Golden Coast sale.
 * They are separate vouchers on purpose so the Sales voucher stays a pure
 * revenue document and the COGS/Stock in Hand movement stays auditable on its
 * own, matching how the rest of the Golden Coast programme reports margin.
 */
export function buildGoldenCoastPhase5SalePostings(input: {
  plan: GoldenCoastPhase5SalePlan;
  accounts: GoldenCoastPhase5RoleAccounts;
  saleSideAccount: GoldenCoastPhase5SaleSideAccount;
  /** Digest of the originating sale request; see goldenCoastPhase5SaleDigest. */
  saleDigest: string;
  exchangeRate: string | null;
  actor?: PostingActor;
}): GoldenCoastPhase5PostingBatch {
  const { plan, accounts } = input;
  const saleDigest = String(input.saleDigest ?? "").trim();
  if (!saleDigest) throw new GoldenCoastPhase5SaleError("saleDigest is required to tag a Golden Coast sale posting");
  const companyId = positiveId(plan.companyId, "companyId");
  const locationId = positiveId(plan.locationId, "locationId");
  const saleSide = input.saleSideAccount;
  if (saleSide.kind !== "ledger" && saleSide.kind !== "bank") {
    throw new GoldenCoastPhase5SaleError('saleSideAccount.kind must be "ledger" or "bank"');
  }
  positiveId(saleSide.id, "saleSideAccount.id");
  positiveId(accounts.salesRevenueAccountId, "salesRevenueAccountId");
  positiveId(accounts.cogsAccountId, "cogsAccountId");
  positiveId(accounts.stockInHandAccountId, "stockInHandAccountId");

  const revenueVoucherNumber = goldenCoastPhase5VoucherNumber(companyId, plan.clientRequestId);
  const cogsVoucherNumber = `${revenueVoucherNumber}-COGS`;
  const description = releaseDebtEnglish(`Golden Coast POS sale — ${plan.customerName}`);

  const revenue = buildGenericVoucherPostingRequest({
    companyId,
    clientRequestId: plan.clientRequestId,
    voucher: {
      locationId,
      voucherNumber: revenueVoucherNumber,
      voucherType: "Sales",
      voucherDate: plan.saleDate,
      description,
      currency: "USD",
    },
    entries: [
      {
        ...saleSideEntryTarget(saleSide),
        debitAmount: plan.revenueUsd,
        creditAmount: "0",
        narration: description,
      },
      {
        ledgerAccountId: accounts.salesRevenueAccountId,
        debitAmount: "0",
        creditAmount: plan.revenueUsd,
        narration: description,
      },
    ],
    exchangeRate: input.exchangeRate,
    actor: input.actor,
  });

  const cogsDescription = releaseDebtEnglish(`Golden Coast POS sale COGS — ${plan.customerName}`);
  const cogs = buildGenericVoucherPostingRequest({
    companyId,
    clientRequestId: plan.clientRequestId,
    voucher: {
      locationId,
      voucherNumber: cogsVoucherNumber,
      voucherType: "Journal",
      voucherDate: plan.saleDate,
      description: cogsDescription,
      currency: "USD",
    },
    entries: [
      {
        ledgerAccountId: accounts.cogsAccountId,
        debitAmount: plan.cogsUsd,
        creditAmount: "0",
        narration: cogsDescription,
      },
      {
        ledgerAccountId: accounts.stockInHandAccountId,
        debitAmount: "0",
        creditAmount: plan.cogsUsd,
        narration: cogsDescription,
      },
    ],
    exchangeRate: input.exchangeRate,
    actor: input.actor,
  });

  // The idempotency key stays keyed on the client request id so a replay is
  // still found by lookup, while the sourceId carries the payload digest. The
  // central engine compares the stored sourceId on replay, so the same request
  // id submitted with different sale data conflicts instead of replaying.
  const tag = (request: CentralPostingRequest, role: GoldenCoastPhase5PostingRole): CentralPostingRequest => ({
    ...request,
    source: {
      sourceType: GOLDEN_COAST_PHASE5_SOURCE_TYPE,
      sourceId: goldenCoastPhase5SourceId(plan.clientRequestId, saleDigest, role),
      idempotencyKey: goldenCoastPhase5IdempotencyKey(companyId, plan.clientRequestId, role),
    },
  });

  return {
    clientRequestId: plan.clientRequestId,
    saleDigest,
    revenueVoucherNumber,
    cogsVoucherNumber,
    postings: [
      { role: "revenue", request: tag(revenue.request, "revenue") },
      { role: "cogs", request: tag(cogs.request, "cogs") },
    ],
  };
}
