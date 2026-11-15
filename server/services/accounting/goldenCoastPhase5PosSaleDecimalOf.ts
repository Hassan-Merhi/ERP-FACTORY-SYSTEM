// Extracted from ./goldenCoastPhase5PosSale.ts to keep that module under the source-size cap.
import Decimal from "decimal.js";
import { releaseDebtEnglish } from "../../i18n/finalCloseoutEnglish";
import { GOLDEN_COAST_CUTOVER_FIFO_SOURCE } from "./goldenCoastPhase4CutoverFifo";
import { GOLDEN_COAST_PHASE8_OFFLOAD_FIFO_SOURCE } from "./goldenCoastPhase8ContainerOffload";

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

export const QUANTITY_SCALE = 4;

export const UNIT_COST_SCALE = 6;

export const MONEY_SCALE = 2;

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

export function positiveId(value: unknown, label: string): number {
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
export function decimalOf(value: unknown, label: string, code: GoldenCoastPhase5ErrorCode): Decimal {
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

export function requiredText(value: unknown, label: string, maxLength: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new GoldenCoastPhase5SaleError(`${label} is required`);
  if (text.length > maxLength) {
    throw new GoldenCoastPhase5SaleError(`${label} must be at most ${maxLength} characters`);
  }
  return text;
}

export function optionalText(value: unknown, label: string, maxLength: number): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new GoldenCoastPhase5SaleError(`${label} must be a string`);
  const text = value.trim();
  if (!text) return null;
  if (text.length > maxLength) {
    throw new GoldenCoastPhase5SaleError(`${label} must be at most ${maxLength} characters`);
  }
  return text;
}

export function saleDate(value: unknown): string {
  const text = requiredText(value, "saleDate", 10);
  if (!ISO_DATE_PATTERN.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) {
    throw new GoldenCoastPhase5SaleError("saleDate must be an ISO calendar date (YYYY-MM-DD)");
  }
  return text;
}

export function clientRequestId(value: unknown): string {
  const text = requiredText(value, "clientRequestId", GOLDEN_COAST_PHASE5_MAX_REQUEST_ID_LENGTH);
  if (!REQUEST_ID_PATTERN.test(text)) {
    throw new GoldenCoastPhase5SaleError("clientRequestId contains unsupported characters");
  }
  return text;
}
