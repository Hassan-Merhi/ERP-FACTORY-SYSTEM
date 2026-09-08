import type { DbTransaction } from "../../db";
import { createHash } from "crypto";
import { sql } from "drizzle-orm";
import Decimal from "decimal.js";
import type {
  PostedVoucher,
  PostedVoucherEntry,
  PostedVoucherWithEntries,
  VoucherEntryInsertFields,
  VoucherInsertFields,
  VoucherWithEntries,
} from "./accountingTypes";
import { insertVoucherWithEntriesTx } from "./voucherPostingService";
import { assertTransactionCompanyScope } from "../security/transactionCompanyScope";
import { resultRows } from "../../lib/queryResult";
import { GOLDEN_COAST_PHASE11_SOURCE_TYPE as GOLDEN_COAST_MONTHLY_CLOSE_SOURCE_TYPE } from "./goldenCoastPhase11CloseIdentity";

const TARGET_FIELDS = [
  "ledgerAccountId",
  "bankAccountId",
  "fixedAssetId",
  "supplierId",
  "employeeId",
  "customerId",
  "factorySupplierId",
] as const;

type TargetField = (typeof TARGET_FIELDS)[number];

export interface PostingSourceIdentity {
  sourceType: string;
  sourceId: string;
  idempotencyKey: string;
}

export interface PostingActor {
  userId?: string | number | null;
  username?: string | null;
  reason?: string | null;
}

export interface PostingOwnershipValidator {
  validateVoucherOwnership(input: {
    tx: DbTransaction;
    companyId: number;
    voucher: VoucherInsertFields;
    entries: VoucherEntryInsertFields[];
  }): Promise<void>;
}

export interface PostingIdempotencyStore {
  findExisting(input: {
    tx: DbTransaction;
    companyId: number;
    source: PostingSourceIdentity;
    requestFingerprint: string;
  }): Promise<PostedVoucherWithEntries | null>;
  record(input: {
    tx: DbTransaction;
    companyId: number;
    voucherId: number;
    source: PostingSourceIdentity;
    requestFingerprint: string;
  }): Promise<void>;
}

export interface PostingAuditWriter {
  recordPosting(input: {
    tx: DbTransaction;
    companyId: number;
    voucherId: number;
    source: PostingSourceIdentity;
    actor: PostingActor;
    debitTotal: string;
    creditTotal: string;
  }): Promise<void>;
}

export interface CentralPostingDependencies {
  ownership: PostingOwnershipValidator;
  idempotency: PostingIdempotencyStore;
  audit: PostingAuditWriter;
}

export interface CentralPostingRequest {
  voucher: VoucherInsertFields;
  entries: VoucherEntryInsertFields[];
  source: PostingSourceIdentity;
  actor?: PostingActor;
}

export interface ValidatedPostingTotals {
  debitTotal: string;
  creditTotal: string;
}

export interface CentralPostingResult<V = unknown, E = unknown> extends VoucherWithEntries<V, E> {
  replayed: boolean;
}

export class PostingValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PostingValidationError";
    this.code = code;
  }
}

function requiredText(value: unknown, field: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new PostingValidationError("POSTING_SOURCE_REQUIRED", `${field} is required`);
  }
  return normalized;
}

function amount(value: string | undefined, field: string, index: number): Decimal {
  let parsed: Decimal;
  try {
    parsed = new Decimal(value ?? "0");
  } catch {
    throw new PostingValidationError("POSTING_AMOUNT_INVALID", `Entry ${index + 1} has an invalid ${field}`);
  }
  if (!parsed.isFinite() || parsed.isNegative()) {
    throw new PostingValidationError(
      "POSTING_AMOUNT_INVALID",
      `Entry ${index + 1} ${field} must be a finite non-negative amount`
    );
  }
  return parsed;
}

function normalizedDecimal(value: string | null | undefined): string | null {
  if (value == null || String(value).trim() === "") return null;
  return new Decimal(value).toFixed();
}

function normalizedText(value: string | null | undefined): string | null {
  if (value == null) return null;
  return String(value);
}

function accountingPeriod(request: CentralPostingRequest): string {
  const accountingDate = String(request.voucher.effectiveDate ?? request.voucher.voucherDate ?? "");
  return accountingDate.slice(0, 7);
}

async function assertPostingPeriodOpen(
  tx: DbTransaction,
  companyId: number,
  request: CentralPostingRequest
): Promise<void> {
  const periodMonth = accountingPeriod(request);
  if (!/^\d{4}-\d{2}$/.test(periodMonth)) return;

  const closeKey = `${GOLDEN_COAST_MONTHLY_CLOSE_SOURCE_TYPE}:${companyId}:${periodMonth}`;
  const result = await tx.execute(sql`
    SELECT 1 AS finalized
    FROM sp_profit_splits s
    WHERE s.company_id = ${companyId}
      AND s.period_month = ${periodMonth}
      AND s.finalized_at IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM accounting_posting_requests apr
        WHERE apr.company_id = s.company_id
          AND apr.source_type = ${GOLDEN_COAST_MONTHLY_CLOSE_SOURCE_TYPE}
          AND apr.idempotency_key = ${closeKey}
      )
    LIMIT 1
  `);

  if (resultRows(result)[0]) {
    throw new PostingValidationError(
      "POSTING_PERIOD_FINALIZED",
      `Accounting period ${periodMonth} is finalized by the Golden Coast monthly close and cannot accept new voucher postings`
    );
  }
}

/**
 * Stable hash of the financial payload associated with one request identity.
 * Actor/audit metadata is intentionally excluded: retransmission by a restored
 * session is still the same financial request. Every persisted voucher/entry
 * field that can change accounting meaning is included in fixed key order.
 */
export function buildPostingRequestFingerprint(request: CentralPostingRequest): string {
  const canonical = {
    companyId: request.voucher.companyId,
    voucherNumber: request.voucher.voucherNumber.trim(),
    voucherType: request.voucher.voucherType.trim(),
    voucherDate: request.voucher.voucherDate.trim(),
    totalAmount: normalizedDecimal(request.voucher.totalAmount),
    description: normalizedText(request.voucher.description),
    locationId: request.voucher.locationId ?? null,
    optional: request.voucher.optional ?? false,
    currency: normalizedText(request.voucher.currency ?? "USD"),
    exchangeRate: normalizedDecimal(request.voucher.exchangeRate),
    effectiveDate: normalizedText(request.voucher.effectiveDate),
    sourceModule: normalizedText(request.voucher.sourceModule),
    sourceType: request.source.sourceType.trim(),
    sourceId: request.source.sourceId.trim(),
    entries: request.entries.map((entry) => ({
      ledgerAccountId: entry.ledgerAccountId ?? null,
      bankAccountId: entry.bankAccountId ?? null,
      fixedAssetId: entry.fixedAssetId ?? null,
      supplierId: entry.supplierId ?? null,
      employeeId: entry.employeeId ?? null,
      customerId: entry.customerId ?? null,
      factorySupplierId: entry.factorySupplierId ?? null,
      debitAmount: normalizedDecimal(entry.debitAmount ?? "0"),
      creditAmount: normalizedDecimal(entry.creditAmount ?? "0"),
      narration: normalizedText(entry.narration),
      transactionCurrency: normalizedText(entry.transactionCurrency),
      transactionDebitAmount: normalizedDecimal(entry.transactionDebitAmount),
      transactionCreditAmount: normalizedDecimal(entry.transactionCreditAmount),
      baseDebitAmount: normalizedDecimal(entry.baseDebitAmount),
      baseCreditAmount: normalizedDecimal(entry.baseCreditAmount),
      historicalExchangeRate: normalizedDecimal(entry.historicalExchangeRate),
      rateConvention: normalizedText(entry.rateConvention),
    })),
  };

  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function populatedPostingTargets(entry: VoucherEntryInsertFields): TargetField[] {
  return TARGET_FIELDS.filter((field) => entry[field] != null);
}

/**
 * Most voucher entries must reference one accounting target. The only supported
 * compatibility exception is a customer plus that customer's own linked ledger.
 * The database ownership adapter validates the relationship before insert.
 */
export function hasSupportedPostingTargetShape(entry: VoucherEntryInsertFields): boolean {
  const populated = populatedPostingTargets(entry);
  if (populated.length === 1) return true;
  return populated.length === 2 && populated.includes("customerId") && populated.includes("ledgerAccountId");
}

export function validateCentralPostingRequest(request: CentralPostingRequest): ValidatedPostingTotals {
  const { voucher, entries, source } = request;

  if (!Number.isInteger(voucher.companyId) || voucher.companyId <= 0) {
    throw new PostingValidationError("POSTING_COMPANY_INVALID", "A valid companyId is required");
  }
  requiredText(voucher.voucherNumber, "voucherNumber");
  requiredText(voucher.voucherType, "voucherType");
  requiredText(voucher.voucherDate, "voucherDate");
  requiredText(source.sourceType, "sourceType");
  requiredText(source.sourceId, "sourceId");
  requiredText(source.idempotencyKey, "idempotencyKey");

  if (!Array.isArray(entries) || entries.length < 2) {
    throw new PostingValidationError("POSTING_ENTRIES_REQUIRED", "A balanced voucher requires at least two entries");
  }

  let debitTotal = new Decimal(0);
  let creditTotal = new Decimal(0);

  entries.forEach((entry, index) => {
    const debit = amount(entry.debitAmount, "debitAmount", index);
    const credit = amount(entry.creditAmount, "creditAmount", index);

    if (!hasSupportedPostingTargetShape(entry)) {
      throw new PostingValidationError(
        "POSTING_TARGET_INVALID",
        `Entry ${index + 1} must reference one accounting target or a verified customer and linked ledger pair`
      );
    }
    if (debit.isZero() === credit.isZero()) {
      throw new PostingValidationError(
        "POSTING_ENTRY_SIDE_INVALID",
        `Entry ${index + 1} must contain either a debit or a credit, but not both`
      );
    }

    debitTotal = debitTotal.plus(debit);
    creditTotal = creditTotal.plus(credit);
  });

  if (debitTotal.isZero() || !debitTotal.equals(creditTotal)) {
    throw new PostingValidationError(
      "POSTING_UNBALANCED",
      `Voucher is not balanced: debit=${debitTotal.toFixed()} credit=${creditTotal.toFixed()}`
    );
  }

  let declaredTotal: Decimal;
  try {
    declaredTotal = new Decimal(voucher.totalAmount);
  } catch {
    throw new PostingValidationError("POSTING_TOTAL_INVALID", "totalAmount is invalid");
  }
  if (!declaredTotal.isFinite() || declaredTotal.isNegative() || !declaredTotal.equals(debitTotal)) {
    throw new PostingValidationError(
      "POSTING_TOTAL_MISMATCH",
      `totalAmount must equal the balanced debit total (${debitTotal.toFixed()})`
    );
  }

  return {
    debitTotal: debitTotal.toFixed(),
    creditTotal: creditTotal.toFixed(),
  };
}

/**
 * Canonical transaction-owned voucher posting boundary.
 *
 * The caller supplies an existing transaction so required source-document,
 * inventory, and secondary-ledger effects can share the same commit. The
 * boundary validates the posting before writes, asserts transaction-local company
 * scope for compatible PostgreSQL RLS policies, enforces company ownership,
 * performs deterministic idempotency lookup/recording, and writes audit data
 * before the transaction is allowed to commit.
 *
 * `replayed` lets callers avoid repeating non-transactional compatibility side
 * effects when the same idempotency key is submitted more than once.
 */
export async function postBalancedVoucherTx(
  // Reached with a caller-generic TTransaction as well as a drizzle handle.
  tx: DbTransaction,
  request: CentralPostingRequest,
  dependencies: CentralPostingDependencies
): Promise<CentralPostingResult<PostedVoucher, PostedVoucherEntry>> {
  const totals = validateCentralPostingRequest(request);
  const companyId = request.voucher.companyId;
  const requestFingerprint = buildPostingRequestFingerprint(request);

  await assertTransactionCompanyScope(tx, companyId);

  const existing = await dependencies.idempotency.findExisting({
    tx,
    companyId,
    source: request.source,
    requestFingerprint,
  });
  if (existing) return { ...existing, replayed: true };

  await assertPostingPeriodOpen(tx, companyId, request);

  await dependencies.ownership.validateVoucherOwnership({
    tx,
    companyId,
    voucher: request.voucher,
    entries: request.entries,
  });

  const result = await insertVoucherWithEntriesTx(tx, request.voucher, request.entries, request.source);

  await dependencies.idempotency.record({
    tx,
    companyId,
    voucherId: result.voucher.id,
    source: request.source,
    requestFingerprint,
  });

  await dependencies.audit.recordPosting({
    tx,
    companyId,
    voucherId: result.voucher.id,
    source: request.source,
    actor: request.actor ?? {},
    debitTotal: totals.debitTotal,
    creditTotal: totals.creditTotal,
  });

  return { ...result, replayed: false };
}
