// Extracted from ./factoryVoucherPosting.ts
import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import { and, eq, isNull, like, or, sql } from "drizzle-orm";
import { accountingPostingRequests, vouchers } from "@shared/schema";
import type { DbTransaction } from "../../db";
import {
  type CentralPostingResult,
  type PostingActor,
  type PostingSourceIdentity,
} from "../accounting/centralPostingEngine";
import { RETIRED_POSTING_IDENTITY_MARK } from "../accounting/voucherRetirement";
import { resultRows } from "../../lib/queryResult";
import type { PostedVoucher, PostedVoucherEntry } from "../accounting/accountingTypes";

export interface FactoryVoucherLine {
  ledgerAccountId?: number | null;
  factorySupplierId?: number | null;
  bankAccountId?: number | null;
  customerId?: number | null;
  employeeId?: number | null;
  supplierId?: number | null;
  fixedAssetId?: number | null;
  /** Native amount (the line's currency). One of debit / credit is positive. */
  debit?: Decimal.Value | null;
  credit?: Decimal.Value | null;
  narration?: string | null;
  /** Defaults to the voucher's currency and rate. */
  currency?: string | null;
  /** USD per one unit of the line's currency (factory convention). */
  fxRateToUsd?: Decimal.Value | null;
}

export interface FactoryVoucherPostingInput {
  companyId: number;
  voucherType?: string;
  voucherDate: string;
  effectiveDate?: string | null;
  description: string;
  currency?: string | null;
  /** USD per one unit of `currency`. Ignored (1) for USD. */
  fxRateToUsd?: Decimal.Value | null;
  locationId?: number | null;
  optional?: boolean;
  sourceModule?: string;
  /**
   * A family number read as identity elsewhere (deterministic); omitted → the
   * engine allocates. A function receives the source's posting generation
   * (1 for the first posting, 2 after one retirement and re-post, …), so a
   * re-posted source gets a new number in its family.
   */
  voucherNumber?: string | ((generation: number) => string);
  source: { sourceType: string; sourceId: string | number; phase?: string };
  lines: FactoryVoucherLine[];
  actor?: PostingActor;
}

export type FactoryVoucherPostingResult = CentralPostingResult<PostedVoucher, PostedVoucherEntry>;

export function currencyCode(value: string | null | undefined): string {
  return (value || "USD").trim().toUpperCase() || "USD";
}

/**
 * The posting identity of the source's live generation. A source whose voucher
 * was retired (voucherRetirement.ts renames its key `…#retired:{id}`) and is
 * posted again takes the key `…:g{n}` (n = the retired generations), so the
 * engine's legacy audit_log marker of the first key (which the retirement
 * cannot rename: audit_log is append-only) does not replay the retired voucher
 * instead of posting the new one. Deterministic: a replay of the live
 * generation finds the same key.
 */
export async function currentGenerationIdentityTx(
  tx: DbTransaction,
  companyId: number,
  identity: PostingSourceIdentity
): Promise<{ source: PostingSourceIdentity; generation: number }> {
  const result = await tx.execute(sql`
    SELECT COUNT(*)::int AS retired
      FROM accounting_posting_requests
     WHERE company_id = ${companyId}
       AND source_type = ${identity.sourceType}
       AND source_id = ${identity.sourceId}
       AND position(${RETIRED_POSTING_IDENTITY_MARK} in idempotency_key) > 0
  `);
  const retired = Number(resultRows<{ retired: number }>(result)[0]?.retired ?? 0);
  return {
    source: retired === 0 ? identity : { ...identity, idempotencyKey: `${identity.idempotencyKey}:g${retired}` },
    generation: retired + 1,
  };
}

/**
 * Live vouchers a source posted, by posting identity (`sourceIdPrefix` matches
 * the identity's source id as `{prefix}%`), plus legacy vouchers by number
 * prefix. Readers that located a family by number should use this.
 */
export async function factorySourceVoucherIdsTx(
  tx: DbTransaction,
  input: { companyId: number; sourceType: string; sourceIdPrefix: string; legacyNumberPrefix?: string }
): Promise<number[]> {
  const rows = await tx
    .selectDistinct({ id: vouchers.id })
    .from(vouchers)
    .leftJoin(
      accountingPostingRequests,
      and(
        eq(accountingPostingRequests.voucherId, vouchers.id),
        eq(accountingPostingRequests.companyId, vouchers.companyId)
      )
    )
    .where(
      and(
        eq(vouchers.companyId, input.companyId),
        isNull(vouchers.deletedAt),
        or(
          and(
            eq(accountingPostingRequests.sourceType, input.sourceType),
            like(accountingPostingRequests.sourceId, `${input.sourceIdPrefix}%`)
          ),
          input.legacyNumberPrefix ? like(vouchers.voucherNumber, `${input.legacyNumberPrefix}%`) : undefined
        )
      )
    );
  return rows.map((row) => Number(row.id));
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * The retry identity of an HTTP request that posts a voucher with no stable
 * source record of its own: the body's clientRequestId or the
 * X-Idempotency-Key header (a resend then returns the voucher already posted),
 * else a one-shot id (no worse than before: those requests had none).
 */
export function factoryRequestSourceId(req: { body?: unknown; get?(name: string): string | undefined }): string {
  const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
  for (const candidate of [body.clientRequestId, req.get?.("X-Idempotency-Key")]) {
    const value = typeof candidate === "string" ? candidate.trim() : "";
    if (value && REQUEST_ID_PATTERN.test(value)) return `req-${value}`;
  }
  return `once-${randomUUID()}`;
}

/** The signed-in user as the posting actor. */
export function factorySessionActor(req: {
  session?: { userId?: string | number | null; username?: string | null } | null;
}): PostingActor {
  const userId = req.session?.userId;
  if (userId === null || userId === undefined || userId === "") return {};
  return { userId, username: req.session?.username || String(userId) };
}
