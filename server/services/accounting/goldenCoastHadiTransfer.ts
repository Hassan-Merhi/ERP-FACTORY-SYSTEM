import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import { releaseDebtEnglish } from "../../i18n/finalCloseoutEnglish";
import type { CentralPostingRequest, PostingActor } from "./centralPostingEngine";
import { buildGenericVoucherPostingRequest } from "./genericVoucherPosting";
import { GOLDEN_COAST_CUTOVER_DATE } from "./goldenCoastCutoverFifo";
import { gcSalesCashPayableBalance } from "./goldenCoastSalesCashPayable";

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
const MONEY_SCALE = 2;

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

function positiveId(value: unknown, field: string): number {
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

function money(value: Decimal): string {
  return value.toDecimalPlaces(MONEY_SCALE, Decimal.ROUND_HALF_UP).toFixed(MONEY_SCALE);
}

function positiveMoney(value: unknown, field: string): Decimal {
  const parsed = decimal(value, field);
  if (!parsed.greaterThan(0)) {
    throw new GoldenCoastPhase7TransferError(`${field} must be greater than zero`);
  }
  if (parsed.decimalPlaces() > MONEY_SCALE) {
    throw new GoldenCoastPhase7TransferError(`${field} supports at most ${MONEY_SCALE} decimal places`);
  }
  return parsed;
}

function balanceMoney(value: unknown, field: string): Decimal {
  const parsed = decimal(value, field);
  if (parsed.decimalPlaces() > 6) {
    throw new GoldenCoastPhase7TransferError(`${field} has unsupported precision`);
  }
  return parsed;
}

function requiredText(value: unknown, field: string, maxLength: number): string {
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

function clientRequestId(value: unknown): string {
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

/**
 * Apply the balance rules for a new (non-replay) transfer.
 *
 * A collection RAISES the GC Sales Cash payable, so it has no ceiling on that
 * account: capping it against the account it grows is what made this operation
 * unusable while GC Sales Cash was misread as a receivable. Remittance can only
 * move cash already collected through Phase 7 and not yet remitted; it never
 * consumes unrelated historical balances on the shared intercompany accounts
 * (for example parent-agent offload charges), and it leaves the payable alone.
 */
export function planGoldenCoastPhase7Transfer(input: {
  transfer: GoldenCoastPhase7TransferInput;
  balances: GoldenCoastPhase7Balances;
}): GoldenCoastPhase7TransferPlan {
  const amount = positiveMoney(input.transfer.amountUsd, "amountUsd");
  const balance = balanceMoney(input.balances.gcSalesCashDebitBalanceUsd, "gcSalesCashDebitBalanceUsd");
  const payable = new Decimal(gcSalesCashPayableBalance(balance.toFixed()));
  const outstanding = balanceMoney(input.balances.outstandingHadiCollectionsUsd, "outstandingHadiCollectionsUsd");
  if (outstanding.lessThan(0)) {
    throw new GoldenCoastPhase7TransferError(
      "Phase 7 HADI collection history is inconsistent: remittances exceed collections",
      "GC_PHASE7_SCOPE_INVALID"
    );
  }

  if (input.transfer.operation === "collect_via_hadi") {
    return {
      ...input.transfer,
      gcSalesCashDebitBalanceBeforeUsd: money(balance),
      gcSalesCashDebitBalanceAfterUsd: money(balance.minus(amount)),
      gcSalesCashPayableBeforeUsd: money(payable),
      gcSalesCashPayableAfterUsd: money(payable.plus(amount)),
      outstandingHadiCollectionsBeforeUsd: money(outstanding),
      outstandingHadiCollectionsAfterUsd: money(outstanding.plus(amount)),
    };
  }

  if (amount.greaterThan(outstanding)) {
    throw new GoldenCoastPhase7TransferError(
      `Remittance ${money(amount)} exceeds unremitted Phase 7 HADI collections ${money(outstanding)}`,
      "GC_PHASE7_REMITTANCE_EXCEEDS_COLLECTIONS"
    );
  }

  return {
    ...input.transfer,
    gcSalesCashDebitBalanceBeforeUsd: money(balance),
    gcSalesCashDebitBalanceAfterUsd: money(balance),
    gcSalesCashPayableBeforeUsd: money(payable),
    gcSalesCashPayableAfterUsd: money(payable),
    outstandingHadiCollectionsBeforeUsd: money(outstanding),
    outstandingHadiCollectionsAfterUsd: money(outstanding.minus(amount)),
  };
}

export function goldenCoastPhase7TransferDigest(input: {
  transfer: GoldenCoastPhase7TransferInput;
  accounts: GoldenCoastPhase7RoleAccounts;
}): string {
  const { transfer, accounts } = input;
  const canonicalAccounts: GoldenCoastPhase7RoleAccounts = {
    gcSalesCashAccountId: positiveId(accounts.gcSalesCashAccountId, "gcSalesCashAccountId"),
    goldenCoastHadiIntercompanyAccountId: positiveId(
      accounts.goldenCoastHadiIntercompanyAccountId,
      "goldenCoastHadiIntercompanyAccountId"
    ),
    hadiGoldenCoastIntercompanyAccountId: positiveId(
      accounts.hadiGoldenCoastIntercompanyAccountId,
      "hadiGoldenCoastIntercompanyAccountId"
    ),
  };

  return createHash("sha256")
    .update(
      JSON.stringify({
        companyId: transfer.companyId,
        parentCompanyId: transfer.parentCompanyId,
        operation: transfer.operation,
        transferDate: transfer.transferDate,
        amountUsd: new Decimal(transfer.amountUsd).toFixed(MONEY_SCALE),
        reference: transfer.reference,
        hadiCashAccount: transfer.hadiCashAccount,
        goldenCoastCashAccount: transfer.goldenCoastCashAccount,
        accounts: canonicalAccounts,
      })
    )
    .digest("hex")
    .slice(0, 32);
}

export function goldenCoastPhase7SourceId(
  operation: GoldenCoastPhase7Operation,
  transferDigest: string,
  role: GoldenCoastPhase7PostingRole
): string {
  const digest = requiredText(transferDigest, "transferDigest", 64);
  return `${operation}:${digest}:${role}`;
}

export function goldenCoastPhase7IdempotencyKey(
  companyId: number,
  requestId: string,
  role: GoldenCoastPhase7PostingRole
): string {
  return `${GOLDEN_COAST_PHASE7_SOURCE_TYPE}:${positiveId(companyId, "companyId")}:${clientRequestId(requestId)}:${role}`;
}

function cashTarget(account: GoldenCoastPhase7CashAccount): Record<string, number> {
  return account.kind === "bank" ? { bankAccountId: account.id } : { ledgerAccountId: account.id };
}

function taggedRequest(input: {
  request: CentralPostingRequest;
  transfer: GoldenCoastPhase7TransferInput;
  transferDigest: string;
  role: GoldenCoastPhase7PostingRole;
}): CentralPostingRequest {
  return {
    ...input.request,
    source: {
      sourceType: GOLDEN_COAST_PHASE7_SOURCE_TYPE,
      sourceId: goldenCoastPhase7SourceId(input.transfer.operation, input.transferDigest, input.role),
      idempotencyKey: goldenCoastPhase7IdempotencyKey(
        input.transfer.companyId,
        input.transfer.clientRequestId,
        input.role
      ),
    },
  };
}

/**
 * Build the two-company accounting pair. Both vouchers must be persisted in the
 * caller's single database transaction.
 *
 * collect_via_hadi (raises the GC Sales Cash payable):
 *   Golden Coast  Dr HADI Intercompany / Cr GC Sales Cash
 *   HADI          Dr Cash/Bank         / Cr Golden Coast Intercompany
 *
 * remit_from_hadi:
 *   Golden Coast  Dr Cash/Bank         / Cr HADI Intercompany
 *   HADI          Dr Golden Coast IC   / Cr Cash/Bank
 */
export function buildGoldenCoastPhase7TransferPostings(input: {
  plan: GoldenCoastPhase7TransferPlan;
  accounts: GoldenCoastPhase7RoleAccounts;
  transferDigest: string;
  goldenCoastExchangeRate: string | null;
  hadiExchangeRate: string | null;
  actor?: PostingActor;
}): GoldenCoastPhase7PostingBatch {
  const { plan, accounts } = input;
  positiveId(accounts.gcSalesCashAccountId, "gcSalesCashAccountId");
  positiveId(accounts.goldenCoastHadiIntercompanyAccountId, "goldenCoastHadiIntercompanyAccountId");
  positiveId(accounts.hadiGoldenCoastIntercompanyAccountId, "hadiGoldenCoastIntercompanyAccountId");
  if (accounts.gcSalesCashAccountId === accounts.goldenCoastHadiIntercompanyAccountId) {
    throw new GoldenCoastPhase7TransferError(
      "GC Sales Cash and the Golden Coast HADI intercompany role must resolve to distinct accounts",
      "GC_PHASE7_SCOPE_INVALID"
    );
  }

  const amountUsd = money(positiveMoney(plan.amountUsd, "amountUsd"));
  const suffix = plan.operation === "collect_via_hadi" ? "COLLECT" : "REMIT";
  const gcVoucherNumber = `GC-P7-C${plan.companyId}-${plan.clientRequestId}-${suffix}`;
  const hadiVoucherNumber = `GC-P7-C${plan.companyId}-${plan.clientRequestId}-${suffix}-HADI`;
  const referenceSuffix = plan.reference ? ` — ${plan.reference}` : "";
  const gcDescription = releaseDebtEnglish(
    plan.operation === "collect_via_hadi"
      ? `Golden Coast sales cash collected via HADI${referenceSuffix}`
      : `HADI cash remittance to Golden Coast${referenceSuffix}`
  );
  const hadiDescription = releaseDebtEnglish(
    plan.operation === "collect_via_hadi"
      ? `Cash collected for Golden Coast${referenceSuffix}`
      : `Cash remitted to Golden Coast${referenceSuffix}`
  );

  const goldenCoastEntries =
    plan.operation === "collect_via_hadi"
      ? [
          {
            ledgerAccountId: accounts.goldenCoastHadiIntercompanyAccountId,
            debitAmount: amountUsd,
            creditAmount: "0",
            narration: gcDescription,
          },
          {
            ledgerAccountId: accounts.gcSalesCashAccountId,
            debitAmount: "0",
            creditAmount: amountUsd,
            narration: gcDescription,
          },
        ]
      : [
          {
            ...cashTarget(plan.goldenCoastCashAccount as GoldenCoastPhase7CashAccount),
            debitAmount: amountUsd,
            creditAmount: "0",
            narration: gcDescription,
          },
          {
            ledgerAccountId: accounts.goldenCoastHadiIntercompanyAccountId,
            debitAmount: "0",
            creditAmount: amountUsd,
            narration: gcDescription,
          },
        ];

  const hadiEntries =
    plan.operation === "collect_via_hadi"
      ? [
          {
            ...cashTarget(plan.hadiCashAccount),
            debitAmount: amountUsd,
            creditAmount: "0",
            narration: hadiDescription,
          },
          {
            ledgerAccountId: accounts.hadiGoldenCoastIntercompanyAccountId,
            debitAmount: "0",
            creditAmount: amountUsd,
            narration: hadiDescription,
          },
        ]
      : [
          {
            ledgerAccountId: accounts.hadiGoldenCoastIntercompanyAccountId,
            debitAmount: amountUsd,
            creditAmount: "0",
            narration: hadiDescription,
          },
          {
            ...cashTarget(plan.hadiCashAccount),
            debitAmount: "0",
            creditAmount: amountUsd,
            narration: hadiDescription,
          },
        ];

  const goldenCoastPosting = buildGenericVoucherPostingRequest({
    companyId: plan.companyId,
    clientRequestId: plan.clientRequestId,
    voucher: {
      voucherNumber: gcVoucherNumber,
      voucherType: "Journal",
      voucherDate: plan.transferDate,
      description: gcDescription,
      currency: "USD",
    },
    entries: goldenCoastEntries,
    exchangeRate: input.goldenCoastExchangeRate,
    actor: input.actor,
  });

  const hadiPosting = buildGenericVoucherPostingRequest({
    companyId: plan.parentCompanyId,
    clientRequestId: plan.clientRequestId,
    voucher: {
      voucherNumber: hadiVoucherNumber,
      voucherType: "Journal",
      voucherDate: plan.transferDate,
      description: hadiDescription,
      currency: "USD",
    },
    entries: hadiEntries,
    exchangeRate: input.hadiExchangeRate,
    actor: input.actor,
  });

  return {
    clientRequestId: plan.clientRequestId,
    transferDigest: input.transferDigest,
    postings: [
      {
        role: "golden_coast",
        request: taggedRequest({
          request: goldenCoastPosting.request,
          transfer: plan,
          transferDigest: input.transferDigest,
          role: "golden_coast",
        }),
      },
      {
        role: "hadi",
        request: taggedRequest({
          request: hadiPosting.request,
          transfer: plan,
          transferDigest: input.transferDigest,
          role: "hadi",
        }),
      },
    ],
  };
}
