// Extracted from ./erpVoucherPosting.ts
import { randomUUID } from "node:crypto";
import type Decimal from "decimal.js";
import { MONEY_DECIMAL_PLACES, MoneyDecimal, toMoney, type MoneyInput } from "../../lib/money";
import type { PostedVoucher, PostedVoucherEntry, VoucherEntryInsertFields } from "./accountingTypes";
import { type CentralPostingResult, type PostingActor } from "./centralPostingEngine";
import {
  getCompanyRequestRuntimeContext,
  runWithCompanyRequestRuntimeContext,
} from "../security/companyRequestRuntimeContext";
import {
  createTenantDatabaseScope,
  getDatabaseScopeRuntimeContext,
  runWithDatabaseScopeRuntimeContext,
} from "../security/databaseScopeRuntimeContext";

/** One line of an ERP voucher: one target, one side, an exact amount. */
export interface ErpVoucherLine {
  ledgerAccountId?: number | null;
  bankAccountId?: number | null;
  fixedAssetId?: number | null;
  supplierId?: number | null;
  employeeId?: number | null;
  customerId?: number | null;
  factorySupplierId?: number | null;
  /** USD debit, rounded to cents. Exactly one of debit / credit is positive. */
  debit?: MoneyInput;
  /** USD credit, rounded to cents. */
  credit?: MoneyInput;
  narration?: string | null;
  /**
   * A non-USD line: its native amount and the voucher's rate (native per USD).
   * Its USD amount is then the native amount / rate at 6 places (the currency
   * trigger's rule), and debit / credit only say which side the line is on.
   */
  transaction?: { currency: string; amount: MoneyInput; rate: MoneyInput } | null;
}

/** Voucher columns outside the engine's financial payload (POS metadata). */
export interface ErpVoucherMetadata {
  shiftId?: number | null;
  clientSaleId?: string | null;
  isCreditSale?: boolean;
  locationName?: string | null;
}

export interface ErpVoucherPostingInput {
  companyId: number;
  voucherType: string;
  voucherDate: string;
  description?: string | null;
  locationId?: number | null;
  currency?: string | null;
  exchangeRate?: MoneyInput;
  effectiveDate?: string | null;
  sourceModule?: string | null;
  /**
   * Only for a re-post of an existing voucher (its number is kept: existing
   * numbers are never renumbered). New postings leave it unset and the engine
   * allocates the next number.
   */
  voucherNumber?: string;
  lines: readonly ErpVoucherLine[];
  /** The business record this voucher posts; replays of it are idempotent. */
  source: { type: string; id: string | number; revision?: string | number | null };
  actor?: PostingActor;
  metadata?: ErpVoucherMetadata;
}

export type ErpPostingResult = CentralPostingResult<PostedVoucher, PostedVoucherEntry>;

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * The retry identity of an HTTP request that posts a voucher: the body's
 * clientRequestId or the X-Idempotency-Key header when the client sends one
 * (a resend then returns the voucher already posted), else a one-shot id (no
 * worse than before: those requests had no identity at all).
 */
export function erpRequestSourceId(req: { body?: unknown; get?(name: string): string | undefined }): string {
  const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
  const candidates = [body.clientRequestId, req.get?.("X-Idempotency-Key")];
  for (const candidate of candidates) {
    const value = typeof candidate === "string" ? candidate.trim() : "";
    if (value && REQUEST_ID_PATTERN.test(value)) return `req-${value}`;
  }
  return `once-${randomUUID()}`;
}

export const TARGET_FIELDS = [
  "ledgerAccountId",
  "bankAccountId",
  "fixedAssetId",
  "supplierId",
  "employeeId",
  "customerId",
  "factorySupplierId",
] as const;

export function cents(value: MoneyInput): Decimal {
  return toMoney(value).toDecimalPlaces(MONEY_DECIMAL_PLACES, MoneyDecimal.ROUND_HALF_UP);
}

export type ErpEntriesPostingInput = Omit<ErpVoucherPostingInput, "lines"> & {
  entries: VoucherEntryInsertFields[];
  optional?: boolean;
};

/** The signed-in user of a request as the posting actor (the request's actor otherwise). */
export function sessionPostingActor(
  req: { session?: { userId?: string | number | null; username?: string | null } | null },
  reason?: string
): PostingActor {
  const userId = req.session?.userId;
  if (userId === null || userId === undefined || userId === "") return { reason: reason ?? null };
  return { userId, username: req.session?.username || String(userId), reason: reason ?? null };
}

export type LineTarget = Pick<
  ErpVoucherLine,
  | "ledgerAccountId"
  | "bankAccountId"
  | "fixedAssetId"
  | "supplierId"
  | "employeeId"
  | "customerId"
  | "factorySupplierId"
>;

export interface ManualVoucherPostingInput extends Omit<ErpEntriesPostingInput, "voucherNumber"> {
  optional: boolean;
  /** The header total of an optional voucher (it may be unbalanced). */
  optionalTotalAmount: string;
}

/**
 * Runs `run` with `companyId` added to the request's authorized companies (and
 * the tenant database scope), for a posting into another company whose
 * membership the caller has already checked. Outside a request it runs as is.
 */
export async function withAuthorizedPostingCompany<T>(companyId: number, run: () => Promise<T>): Promise<T> {
  const request = getCompanyRequestRuntimeContext();
  if (!request || request.companyId === companyId) return run();
  const authorizedCompanyIds = [...new Set([...(request.authorizedCompanyIds ?? []), companyId])];
  return runWithCompanyRequestRuntimeContext({ ...request, authorizedCompanyIds }, () =>
    getDatabaseScopeRuntimeContext()?.kind === "tenant"
      ? runWithDatabaseScopeRuntimeContext(
          createTenantDatabaseScope(request.companyId, authorizedCompanyIds, "authorized-companies"),
          run
        )
      : run()
  );
}
