// Extracted from ./goldenCoastHadiTransfer.ts to keep that module under the source-size cap.
import Decimal from "decimal.js";
import { releaseDebtEnglish } from "../../i18n/finalCloseoutEnglish";
import type { CentralPostingRequest } from "./centralPostingEngine";
import { GOLDEN_COAST_CUTOVER_DATE } from "./goldenCoastCutoverFifo";

/**
 * Golden Coast Phase 7 deliberately owns only cash collection/remittance via
 * the configured parent company. POS sale/FIFO/COGS and the Phase 6 special
 * location deduction remain outside this module.
 *
 * A collection records that HADI physically received sale cash on Golden
 * Coast's behalf: HADI now owes Golden Coast the money, and Golden Coast owes
 * Fresh Start FZ the corresponding sales value. That is the same pair the live
 * POS path posts, and it INCREASES the credit-normal GC Sales Cash payable —
 * so a collection has no ceiling on that account, only a remittance is capped,
 * by the collections Phase 7 itself has not yet returned.
 */
export const GOLDEN_COAST_PHASE7_SOURCE_TYPE = "golden-coast-phase7-hadi-transfer";

export const GOLDEN_COAST_PHASE7_MAX_REQUEST_ID_LENGTH = 64;

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const MONEY_SCALE = 2;

export type GoldenCoastPhase7Operation = "collect_via_hadi" | "remit_from_hadi";

export type GoldenCoastPhase7PostingRole = "golden_coast" | "hadi";

export type GoldenCoastPhase7ErrorCode =
  | "GC_PHASE7_INPUT_INVALID"
  | "GC_PHASE7_PRE_CUTOVER_DATE"
  | "GC_PHASE7_REMITTANCE_EXCEEDS_COLLECTIONS"
  | "GC_PHASE7_SCOPE_INVALID";

export class GoldenCoastPhase7TransferError extends Error {
  readonly code: GoldenCoastPhase7ErrorCode;

  constructor(message: string, code: GoldenCoastPhase7ErrorCode = "GC_PHASE7_INPUT_INVALID") {
    super(releaseDebtEnglish(message));
    this.name = "GoldenCoastPhase7TransferError";
    this.code = code;
  }
}

export interface GoldenCoastPhase7CashAccount {
  kind: "ledger" | "bank";
  id: number;
}

export interface GoldenCoastPhase7TransferInput {
  companyId: number;
  parentCompanyId: number;
  operation: GoldenCoastPhase7Operation;
  transferDate: string;
  amountUsd: string;
  clientRequestId: string;
  reference: string | null;
  /** Physical HADI cash/bank account receiving or sending the money. */
  hadiCashAccount: GoldenCoastPhase7CashAccount;
  /** Required only when HADI remits physical cash back to Golden Coast. */
  goldenCoastCashAccount: GoldenCoastPhase7CashAccount | null;
}

export interface GoldenCoastPhase7Balances {
  /** Signed Dr-minus-Cr on GC Sales Cash; negative means it is payable. */
  gcSalesCashDebitBalanceUsd: string | number;
  /** Phase-7-only HADI collections not yet remitted to Golden Coast. */
  outstandingHadiCollectionsUsd: string | number;
}

export interface GoldenCoastPhase7TransferPlan extends GoldenCoastPhase7TransferInput {
  gcSalesCashDebitBalanceBeforeUsd: string;
  gcSalesCashDebitBalanceAfterUsd: string;
  /** Outstanding payable (credit-normal) before and after this transfer. */
  gcSalesCashPayableBeforeUsd: string;
  gcSalesCashPayableAfterUsd: string;
  outstandingHadiCollectionsBeforeUsd: string;
  outstandingHadiCollectionsAfterUsd: string;
}

export interface GoldenCoastPhase7RoleAccounts {
  gcSalesCashAccountId: number;
  goldenCoastHadiIntercompanyAccountId: number;
  hadiGoldenCoastIntercompanyAccountId: number;
}

export interface GoldenCoastPhase7Posting {
  role: GoldenCoastPhase7PostingRole;
  request: CentralPostingRequest;
}

export interface GoldenCoastPhase7PostingBatch {
  clientRequestId: string;
  transferDigest: string;
  postings: GoldenCoastPhase7Posting[];
}

export function positiveId(value: unknown, field: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new GoldenCoastPhase7TransferError(`${field} must be a positive integer`);
  }
  return id;
}

function decimal(value: unknown, field: string): Decimal {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new GoldenCoastPhase7TransferError(`${field} must be a number or numeric string`);
  }
  try {
    const parsed = new Decimal(value);
    if (!parsed.isFinite()) throw new Error("not finite");
    return parsed;
  } catch {
    throw new GoldenCoastPhase7TransferError(`${field} must be a finite number`);
  }
}

export function money(value: Decimal): string {
  return value.toDecimalPlaces(MONEY_SCALE, Decimal.ROUND_HALF_UP).toFixed(MONEY_SCALE);
}

export function positiveMoney(value: unknown, field: string): Decimal {
  const parsed = decimal(value, field);
  if (!parsed.greaterThan(0)) {
    throw new GoldenCoastPhase7TransferError(`${field} must be greater than zero`);
  }
  if (parsed.decimalPlaces() > MONEY_SCALE) {
    throw new GoldenCoastPhase7TransferError(`${field} supports at most ${MONEY_SCALE} decimal places`);
  }
  return parsed;
}

export function balanceMoney(value: unknown, field: string): Decimal {
  const parsed = decimal(value, field);
  if (parsed.decimalPlaces() > 6) {
    throw new GoldenCoastPhase7TransferError(`${field} has unsupported precision`);
  }
  return parsed;
}

export function requiredText(value: unknown, field: string, maxLength: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new GoldenCoastPhase7TransferError(`${field} is required`);
  if (text.length > maxLength) {
    throw new GoldenCoastPhase7TransferError(`${field} must be at most ${maxLength} characters`);
  }
  return text;
}

function optionalText(value: unknown, field: string, maxLength: number): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new GoldenCoastPhase7TransferError(`${field} must be a string`);
  const text = value.trim();
  if (!text) return null;
  if (text.length > maxLength) {
    throw new GoldenCoastPhase7TransferError(`${field} must be at most ${maxLength} characters`);
  }
  return text;
}

function transferDate(value: unknown): string {
  const text = requiredText(value, "transferDate", 10);
  const match = ISO_DATE_PATTERN.exec(text);
  if (!match) {
    throw new GoldenCoastPhase7TransferError("transferDate must be an ISO calendar date (YYYY-MM-DD)");
  }

  const [year, month, day] = text.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new GoldenCoastPhase7TransferError("transferDate must be an ISO calendar date (YYYY-MM-DD)");
  }

  if (text < GOLDEN_COAST_CUTOVER_DATE) {
    throw new GoldenCoastPhase7TransferError(
      `transferDate cannot be earlier than the Golden Coast cutover date ${GOLDEN_COAST_CUTOVER_DATE}`,
      "GC_PHASE7_PRE_CUTOVER_DATE"
    );
  }
  return text;
}

export function clientRequestId(value: unknown): string {
  const text = requiredText(value, "clientRequestId", GOLDEN_COAST_PHASE7_MAX_REQUEST_ID_LENGTH);
  if (!REQUEST_ID_PATTERN.test(text)) {
    throw new GoldenCoastPhase7TransferError("clientRequestId contains unsupported characters");
  }
  return text;
}

function cashAccount(value: unknown, field: string): GoldenCoastPhase7CashAccount {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GoldenCoastPhase7TransferError(`${field} is required`);
  }
  const input = value as Record<string, unknown>;
  if (input.kind !== "ledger" && input.kind !== "bank") {
    throw new GoldenCoastPhase7TransferError(`${field}.kind must be "ledger" or "bank"`);
  }
  return { kind: input.kind, id: positiveId(input.id, `${field}.id`) };
}

/**
 * Parse the transport payload without consulting mutable balances. Replay
 * detection must happen before balance checks, otherwise a valid replay could
 * be rejected simply because its original posting already changed the balance.
 */
export function parseGoldenCoastPhase7TransferInput(input: {
  companyId: number;
  parentCompanyId: number;
  body: unknown;
}): GoldenCoastPhase7TransferInput {
  const companyId = positiveId(input.companyId, "companyId");
  const parentCompanyId = positiveId(input.parentCompanyId, "parentCompanyId");
  if (companyId === parentCompanyId) {
    throw new GoldenCoastPhase7TransferError(
      "Golden Coast and HADI must be different companies",
      "GC_PHASE7_SCOPE_INVALID"
    );
  }
  if (!input.body || typeof input.body !== "object" || Array.isArray(input.body)) {
    throw new GoldenCoastPhase7TransferError("A Phase 7 transfer request body is required");
  }
  const raw = input.body as Record<string, unknown>;
  if (raw.operation !== "collect_via_hadi" && raw.operation !== "remit_from_hadi") {
    throw new GoldenCoastPhase7TransferError('operation must be either "collect_via_hadi" or "remit_from_hadi"');
  }

  const operation = raw.operation;
  const goldenCoastCashAccount =
    operation === "remit_from_hadi" ? cashAccount(raw.goldenCoastCashAccount, "goldenCoastCashAccount") : null;
  if (operation === "collect_via_hadi" && raw.goldenCoastCashAccount != null) {
    throw new GoldenCoastPhase7TransferError(
      "goldenCoastCashAccount must not be supplied when HADI collects cash on Golden Coast's behalf"
    );
  }

  return {
    companyId,
    parentCompanyId,
    operation,
    transferDate: transferDate(raw.transferDate),
    amountUsd: money(positiveMoney(raw.amountUsd, "amountUsd")),
    clientRequestId: clientRequestId(raw.clientRequestId),
    reference: optionalText(raw.reference, "reference", 200),
    hadiCashAccount: cashAccount(raw.hadiCashAccount, "hadiCashAccount"),
    goldenCoastCashAccount,
  };
}
