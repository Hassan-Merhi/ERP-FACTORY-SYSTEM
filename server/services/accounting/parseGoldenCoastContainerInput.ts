// Extracted from ./goldenCoastContainerOffload.ts to keep that module under the source-size cap.
import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import { releaseDebtEnglish } from "../../i18n/finalCloseoutEnglish";
import { GOLDEN_COAST_CUTOVER_DATE } from "./goldenCoastCutoverFifo";

export const GOLDEN_COAST_PHASE8_SOURCE_TYPE = "golden-coast-phase8-container";

export const GOLDEN_COAST_PHASE8_OFFLOAD_FIFO_SOURCE = "golden_coast_phase8_offload";

export const GOLDEN_COAST_FRESH_START_EXCEL_FUNDING_MARKER = "fresh-start-excel:fund";

export const GOLDEN_COAST_PHASE8_MAX_REQUEST_ID_LENGTH = 48;

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const MONEY_SCALE = 2;

export const QUANTITY_SCALE = 4;

const UNIT_RATE_SCALE = 4;

export type GoldenCoastPhase8ErrorCode =
  | "GC_PHASE8_INPUT_INVALID"
  | "GC_PHASE8_PRE_CUTOVER_DATE"
  | "GC_PHASE8_RESERVE_EXCEEDED"
  | "GC_PHASE8_CHARGE_FUNDING_REQUIRED"
  | "GC_PHASE8_SCOPE_MISMATCH";

export class GoldenCoastPhase8Error extends Error {
  readonly code: GoldenCoastPhase8ErrorCode;

  constructor(message: string, code: GoldenCoastPhase8ErrorCode = "GC_PHASE8_INPUT_INVALID") {
    super(releaseDebtEnglish(message));
    this.name = "GoldenCoastPhase8Error";
    this.code = code;
  }
}

export type GoldenCoastPhase8PostingAccount = { kind: "ledger"; id: number } | { kind: "bank"; id: number };

export interface GoldenCoastPhase8ContainerLineInput {
  stockItemId: number;
  articleCode: string;
  description: string | null;
  qty: string;
  unitRateUsd: string;
}

export interface GoldenCoastPhase8ContainerInput {
  companyId: number;
  clientRequestId: string;
  supplierId: number | null;
  supplierName: string;
  containerNumber: string | null;
  invoiceNumber: string;
  invoiceDate: string;
  reserveUsd: string;
  fundingAccount: GoldenCoastPhase8PostingAccount;
  lines: GoldenCoastPhase8ContainerLineInput[];
  notes: string | null;
}

export interface GoldenCoastPhase8ChargeInput {
  chargeType: "duty" | "transport" | "other";
  description: string | null;
  amountUsd: string;
}

export interface GoldenCoastPhase8OffloadInput {
  companyId: number;
  clientRequestId: string;
  containerId: number;
  locationId: number;
  offloadDate: string;
  charges: GoldenCoastPhase8ChargeInput[];
  /**
   * Where the actual charges are paid from. Phase 8-funded containers already
   * hold a real reserve, so this is unused for them; a container carried
   * through the cutover has no reserve, so its charges need a funding account.
   */
  chargeFundingAccount: GoldenCoastPhase8PostingAccount | null;
}

export interface GoldenCoastPhase8RoleAccounts {
  stockOtwAccountId: number;
  stockInHandAccountId: number;
  containerReserveAccountId: number;
  hassanEquityAccountId: number;
  hassanSavingsAccountId: number;
}

export interface GoldenCoastPhase8FundingPlan {
  goodsCostUsd: string;
  reserveUsd: string;
  totalFundingUsd: string;
  totalQty: string;
  digest: string;
}

/**
 * `phase8` containers were funded by this phase's own endpoint and carry a real
 * container reserve. `cutover` containers were carried across the September 1
 * cutover by the migration, which links a `GC-OTW-*` voucher and never funds a
 * reserve — their charges settle against a funding account at offload instead.
 */
export type GoldenCoastPhase8ContainerOrigin = "phase8" | "cutover" | "fresh_start_excel";

export interface GoldenCoastPhase8FundedContainerState {
  containerId: number;
  companyId: number;
  origin: GoldenCoastPhase8ContainerOrigin;
  fundingVoucherId: number;
  goodsCostUsd: string;
  reserveUsd: string;
  fundingAccount: GoldenCoastPhase8PostingAccount;
  lines: GoldenCoastPhase8ContainerLineInput[];
}

export interface GoldenCoastPhase8OffloadLinePlan extends GoldenCoastPhase8ContainerLineInput {
  baseUnitCostUsd: string;
  landedUnitCostUsd: string;
  finalUnitCostUsd: string;
}

export interface GoldenCoastPhase8OffloadPlan {
  goodsCostUsd: string;
  reserveUsd: string;
  actualChargesUsd: string;
  unusedReserveUsd: string;
  totalQty: string;
  totalFinalCostUsd: string;
  lines: GoldenCoastPhase8OffloadLinePlan[];
  digest: string;
}

export function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GoldenCoastPhase8Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function positiveId(value: unknown, label: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new GoldenCoastPhase8Error(`${label} must be a positive integer`);
  return id;
}

function optionalPositiveId(value: unknown, label: string): number | null {
  if (value == null || value === "") return null;
  return positiveId(value, label);
}

function requiredText(value: unknown, label: string, max: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new GoldenCoastPhase8Error(`${label} is required`);
  if (text.length > max) throw new GoldenCoastPhase8Error(`${label} must be at most ${max} characters`);
  return text;
}

export function optionalText(value: unknown, label: string, max: number): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new GoldenCoastPhase8Error(`${label} must be a string`);
  const text = value.trim();
  if (!text) return null;
  if (text.length > max) throw new GoldenCoastPhase8Error(`${label} must be at most ${max} characters`);
  return text;
}

export function decimal(value: unknown, label: string): Decimal {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new GoldenCoastPhase8Error(`${label} must be numeric`);
  }
  try {
    const parsed = new Decimal(value);
    if (!parsed.isFinite()) throw new Error("not finite");
    return parsed;
  } catch {
    throw new GoldenCoastPhase8Error(`${label} must be numeric`);
  }
}

export function money(value: Decimal): string {
  return value.toDecimalPlaces(MONEY_SCALE, Decimal.ROUND_HALF_UP).toFixed(MONEY_SCALE);
}

export function isoDate(value: unknown, label: string): string {
  const text = requiredText(value, label, 10);
  if (!ISO_DATE_PATTERN.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) {
    throw new GoldenCoastPhase8Error(`${label} must be an ISO calendar date (YYYY-MM-DD)`);
  }
  if (text < GOLDEN_COAST_CUTOVER_DATE) {
    throw new GoldenCoastPhase8Error(
      `${label} cannot be earlier than the Golden Coast cutover date ${GOLDEN_COAST_CUTOVER_DATE}`,
      "GC_PHASE8_PRE_CUTOVER_DATE"
    );
  }
  return text;
}

export function requestId(value: unknown): string {
  const text = requiredText(value, "clientRequestId", GOLDEN_COAST_PHASE8_MAX_REQUEST_ID_LENGTH);
  if (!REQUEST_ID_PATTERN.test(text)) {
    throw new GoldenCoastPhase8Error("clientRequestId contains unsupported characters");
  }
  return text;
}

export function postingAccount(value: unknown, label: string): GoldenCoastPhase8PostingAccount {
  const raw = record(value, label);
  if (raw.kind !== "ledger" && raw.kind !== "bank") {
    throw new GoldenCoastPhase8Error(`${label}.kind must be "ledger" or "bank"`);
  }
  return { kind: raw.kind, id: positiveId(raw.id, `${label}.id`) };
}

export function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function accountTarget(account: GoldenCoastPhase8PostingAccount): Record<string, number> {
  return account.kind === "bank" ? { bankAccountId: account.id } : { ledgerAccountId: account.id };
}

export function parseGoldenCoastPhase8ContainerInput(input: {
  companyId: number;
  body: unknown;
  maxLines?: number;
}): GoldenCoastPhase8ContainerInput {
  const companyId = positiveId(input.companyId, "companyId");
  const raw = record(input.body, "request body");
  const maxLines = input.maxLines ?? 100;
  if (!Array.isArray(raw.lines) || raw.lines.length === 0) {
    throw new GoldenCoastPhase8Error("lines must contain at least one container line");
  }
  if (raw.lines.length > maxLines) throw new GoldenCoastPhase8Error(`lines must contain at most ${maxLines} lines`);

  const seen = new Set<number>();
  const lines = raw.lines.map((value, index): GoldenCoastPhase8ContainerLineInput => {
    const line = record(value, `lines[${index}]`);
    const stockItemId = positiveId(line.stockItemId, `lines[${index}].stockItemId`);
    if (seen.has(stockItemId)) throw new GoldenCoastPhase8Error(`lines[${index}] repeats stock item ${stockItemId}`);
    seen.add(stockItemId);
    const qty = decimal(line.qty, `lines[${index}].qty`);
    const unitRate = decimal(line.unitRateUsd, `lines[${index}].unitRateUsd`);
    if (!qty.gt(0) || qty.decimalPlaces() > QUANTITY_SCALE) {
      throw new GoldenCoastPhase8Error(
        `lines[${index}].qty must be greater than zero with at most ${QUANTITY_SCALE} decimals`
      );
    }
    if (!unitRate.gt(0) || unitRate.decimalPlaces() > UNIT_RATE_SCALE) {
      throw new GoldenCoastPhase8Error(
        `lines[${index}].unitRateUsd must be greater than zero with at most ${UNIT_RATE_SCALE} decimals`
      );
    }
    return {
      stockItemId,
      articleCode: requiredText(line.articleCode, `lines[${index}].articleCode`, 100),
      description: optionalText(line.description, `lines[${index}].description`, 500),
      qty: qty.toDecimalPlaces(QUANTITY_SCALE).toFixed(QUANTITY_SCALE),
      unitRateUsd: unitRate.toDecimalPlaces(UNIT_RATE_SCALE).toFixed(UNIT_RATE_SCALE),
    };
  });

  const reserve = decimal(raw.reserveUsd ?? 0, "reserveUsd");
  if (reserve.lt(0) || reserve.decimalPlaces() > MONEY_SCALE) {
    throw new GoldenCoastPhase8Error(`reserveUsd cannot be negative and supports at most ${MONEY_SCALE} decimals`);
  }

  return {
    companyId,
    clientRequestId: requestId(raw.clientRequestId),
    supplierId: optionalPositiveId(raw.supplierId, "supplierId"),
    supplierName: requiredText(raw.supplierName, "supplierName", 200),
    containerNumber: optionalText(raw.containerNumber, "containerNumber", 100),
    invoiceNumber: requiredText(raw.invoiceNumber, "invoiceNumber", 100),
    invoiceDate: isoDate(raw.invoiceDate, "invoiceDate"),
    reserveUsd: money(reserve),
    fundingAccount: postingAccount(raw.fundingAccount, "fundingAccount"),
    lines,
    notes: optionalText(raw.notes, "notes", 1000),
  };
}

export function planGoldenCoastPhase8Funding(container: GoldenCoastPhase8ContainerInput): GoldenCoastPhase8FundingPlan {
  let goods = new Decimal(0);
  let qty = new Decimal(0);
  for (const line of container.lines) {
    goods = goods.plus(new Decimal(line.qty).times(line.unitRateUsd));
    qty = qty.plus(line.qty);
  }
  goods = goods.toDecimalPlaces(MONEY_SCALE, Decimal.ROUND_HALF_UP);
  const reserve = new Decimal(container.reserveUsd);
  const total = goods.plus(reserve);
  if (!goods.gt(0)) throw new GoldenCoastPhase8Error("Container goods cost must be greater than zero");
  return {
    goodsCostUsd: money(goods),
    reserveUsd: money(reserve),
    totalFundingUsd: money(total),
    totalQty: qty.toDecimalPlaces(QUANTITY_SCALE).toFixed(QUANTITY_SCALE),
    digest: digest({
      companyId: container.companyId,
      supplierId: container.supplierId,
      supplierName: container.supplierName,
      containerNumber: container.containerNumber,
      invoiceNumber: container.invoiceNumber,
      invoiceDate: container.invoiceDate,
      reserveUsd: container.reserveUsd,
      fundingAccount: container.fundingAccount,
      lines: container.lines,
    }),
  };
}
