/**
 * The one way factory and supplier-partner writers post a voucher (accounting
 * audit phase 22 C: D2, PE8, PE13).
 *
 * Before: about fifty factory / supplier-partner files inserted `vouchers` and
 * `voucher_entries` rows themselves — numbers built from `Date.now()`, amounts
 * through parseFloat/Number, no posting identity (a replay posted twice), no
 * engine validation (balance, targets, company ownership, finalized period).
 *
 * Now a writer describes the voucher (lines in the document's own currency with
 * the factory rate, USD per unit) and calls `postFactoryVoucherTx` inside its
 * own transaction. The lines are normalized with `normFactoryEntry` (Decimal,
 * base = native × rate at 6 places, the factory convention), the total is the
 * balanced base debit total, and the voucher goes through
 * `postBalancedVoucherTx` with a deterministic posting identity (source type +
 * source id + phase), so a replay of the same document returns the voucher it
 * posted instead of posting again.
 *
 * Header total (decided by default): the engine checks the USD base total; a
 * voucher in a document currency then keeps that currency's total on its
 * header, as factory vouchers always did (see documentCurrencyTotal).
 *
 * Numbering (decided by default, owner can override): the engine allocates the
 * gapless TYPE-YYYY-000001 number unless the writer passes `voucherNumber`.
 * Families whose number is read as their identity elsewhere (FACTORY-IMPORT-,
 * FACTORY-FREIGHT-, FACTORY-OC-, FACTORY-COMM-, FACTORY-PAY-, SP-*; read by
 * balances/unpostedMemo, the integrity diagnostic, supplier statements, the
 * voucher lists, reverse offload, container delete) keep their family prefix
 * with a deterministic source suffix (never a timestamp) until those readers
 * look vouchers up by posting identity (`factorySourceVoucherIdsTx`).
 */
import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import { and, eq, isNull, like, or, sql } from "drizzle-orm";
import { accountingPostingRequests, voucherEntries, vouchers } from "@shared/schema";

import type { DbTransaction } from "../../db";
import type { VoucherEntryInsertFields, VoucherInsertFields } from "../accounting/accountingTypes";
import {
  PostingValidationError,
  postBalancedVoucherTx,
  type CentralPostingResult,
  type PostingActor,
  type PostingSourceIdentity,
} from "../accounting/centralPostingEngine";
import { RETIRED_POSTING_IDENTITY_MARK } from "../accounting/voucherRetirement";
import { resultRows } from "../../lib/queryResult";
import type { PostedVoucher, PostedVoucherEntry } from "../accounting/accountingTypes";
import { createDatabasePostingDependencies } from "../accounting/databasePostingDependencies";
import {
  infrastructurePostingIdentity,
  insertInfrastructureVoucherTx,
} from "../accounting/infrastructureVoucherIdentity";
import { allocateVoucherNumberTx } from "../accounting/voucherNumbering";
import { normFactoryEntry } from "./factoryVoucherEntryAmounts";

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

const ZERO = new Decimal(0);

function dec(value: Decimal.Value | null | undefined): Decimal {
  if (value == null || value === "") return ZERO;
  return new Decimal(value);
}

function currencyCode(value: string | null | undefined): string {
  return (value || "USD").trim().toUpperCase() || "USD";
}

/** The engine request for a factory voucher (exported for tests and previews). */
export function buildFactoryVoucherRequest(
  input: Omit<FactoryVoucherPostingInput, "voucherNumber"> & { voucherNumber?: string }
): {
  voucher: VoucherInsertFields;
  entries: VoucherEntryInsertFields[];
} {
  const voucherCurrency = currencyCode(input.currency);
  const voucherRate = voucherCurrency === "USD" ? new Decimal(1) : dec(input.fxRateToUsd);
  let baseDebitTotal = ZERO;

  const entries: VoucherEntryInsertFields[] = input.lines.map((line) => {
    const lineCurrency = currencyCode(line.currency ?? voucherCurrency);
    const lineRate =
      lineCurrency === "USD"
        ? new Decimal(1)
        : line.fxRateToUsd != null && line.fxRateToUsd !== ""
          ? dec(line.fxRateToUsd)
          : voucherRate;
    const amounts = normFactoryEntry(
      lineCurrency,
      dec(line.debit).toFixed(),
      dec(line.credit).toFixed(),
      lineRate.toFixed()
    );
    baseDebitTotal = baseDebitTotal.plus(amounts.debitAmount);
    return {
      ledgerAccountId: line.ledgerAccountId ?? null,
      factorySupplierId: line.factorySupplierId ?? null,
      bankAccountId: line.bankAccountId ?? null,
      customerId: line.customerId ?? null,
      employeeId: line.employeeId ?? null,
      supplierId: line.supplierId ?? null,
      fixedAssetId: line.fixedAssetId ?? null,
      narration: line.narration ?? null,
      ...amounts,
    };
  });

  const voucher = {
    companyId: input.companyId,
    // undefined → the engine allocates the gapless number (phase 22 A contract).
    voucherNumber: input.voucherNumber,
    voucherType: input.voucherType ?? "Journal",
    voucherDate: input.voucherDate,
    effectiveDate: input.effectiveDate ?? null,
    description: input.description,
    totalAmount: baseDebitTotal.toFixed(),
    currency: voucherCurrency,
    exchangeRate: voucherRate.toFixed(),
    locationId: input.locationId ?? null,
    optional: input.optional ?? false,
    sourceModule: input.sourceModule ?? "FACTORY",
  } as VoucherInsertFields;

  return { voucher, entries };
}

/**
 * Post one factory voucher through the central engine inside the caller's
 * transaction: balanced (engine check, then the database guard at commit),
 * company-owned targets, Decimal amounts, an idempotent posting identity, the
 * posting audit row. `replayed` is true when the same document was posted
 * before (the existing voucher is returned).
 */
export async function postFactoryVoucherTx(
  tx: DbTransaction,
  input: FactoryVoucherPostingInput
): Promise<FactoryVoucherPostingResult> {
  const identity = infrastructurePostingIdentity(input.source.sourceType, input.source.sourceId, input.source.phase);
  const { source, generation } = await currentGenerationIdentityTx(tx, input.companyId, identity);
  const voucherNumber =
    typeof input.voucherNumber === "function" ? input.voucherNumber(generation) : input.voucherNumber;
  const request = buildFactoryVoucherRequest({ ...input, voucherNumber });
  const result = await postBalancedVoucherTx(
    tx,
    { ...request, source, actor: input.actor },
    createDatabasePostingDependencies()
  );
  const nativeTotal = documentCurrencyTotal(request);
  if (!result.replayed && nativeTotal !== null) {
    // Decided by default (owner can override): a factory voucher in a document
    // currency keeps that currency's total on its header, as every factory
    // voucher always has (the factory daybook shows it as the native amount and
    // converts it at the header rate; the reverse offload restores by it). The
    // engine validated the USD base total; the lines carry both.
    const [updated] = await tx
      .update(vouchers)
      .set({ totalAmount: nativeTotal })
      .where(and(eq(vouchers.id, result.voucher.id), eq(vouchers.companyId, input.companyId)))
      .returning();
    if (updated) return { ...result, voucher: updated };
  }
  return result;
}

/** The document-currency total (2 dp) of a non-USD voucher whose lines all are in that currency, else null. */
function documentCurrencyTotal(request: { voucher: VoucherInsertFields; entries: VoucherEntryInsertFields[] }) {
  const currency = currencyCode(request.voucher.currency);
  if (currency === "USD") return null;
  if (request.entries.some((entry) => currencyCode(entry.transactionCurrency) !== currency)) return null;
  return request.entries
    .reduce((sum, entry) => sum.plus(dec(entry.transactionDebitAmount)), ZERO)
    .toDecimalPlaces(2)
    .toFixed(2);
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

/**
 * Every amount column of a USD line (debit/credit, the transaction and base
 * amounts, rate 1, IDENTITY) for an in-place edit of a posted line, so an edit
 * never leaves the base columns on the old amount. One side is positive.
 */
export function usdLineAmounts(debit: Decimal.Value | null | undefined, credit: Decimal.Value | null | undefined) {
  return normFactoryEntry("USD", dec(debit).toFixed(), dec(credit).toFixed(), "1");
}

/**
 * For the journals whose lines carry a control account AND a party on one line
 * (the supplier-partner OTW clearing line: the clearing account with the
 * purchase supplier as party detail, read by the SP OTW reports). The engine
 * takes one target per line (customer + linked ledger is its only pair), so
 * until the control-account model (C9) decides how a party rides on a
 * control-account line these go through the infrastructure writer: the same
 * posting identity and generation as `postFactoryVoucherTx`, Decimal amounts
 * with an exact balance check, every amount column (normFactoryEntry), a
 * deterministic family number (or the engine's gapless allocator), in the
 * caller's transaction (the database balance guard checks it at commit).
 */
export async function postFactoryPartyLineVoucherTx(
  tx: DbTransaction,
  input: FactoryVoucherPostingInput
): Promise<{ voucherId: number; replayed: boolean }> {
  const identity = infrastructurePostingIdentity(input.source.sourceType, input.source.sourceId, input.source.phase);
  const { source, generation } = await currentGenerationIdentityTx(tx, input.companyId, identity);
  const familyNumber =
    typeof input.voucherNumber === "function" ? input.voucherNumber(generation) : input.voucherNumber;
  const request = buildFactoryVoucherRequest({ ...input, voucherNumber: familyNumber });
  const debit = request.entries.reduce((sum, entry) => sum.plus(entry.debitAmount ?? "0"), ZERO);
  const credit = request.entries.reduce((sum, entry) => sum.plus(entry.creditAmount ?? "0"), ZERO);
  if (request.entries.length < 2 || debit.isZero() || !debit.equals(credit)) {
    throw new PostingValidationError(
      "POSTING_UNBALANCED",
      `Voucher is not balanced: debit=${debit.toFixed()} credit=${credit.toFixed()}`
    );
  }
  const [existing] = resultRows<{ voucher_number: string }>(
    await tx.execute(sql`
      SELECT v.voucher_number FROM accounting_posting_requests apr
        JOIN vouchers v ON v.id = apr.voucher_id
       WHERE apr.company_id = ${input.companyId} AND apr.idempotency_key = ${source.idempotencyKey}
       LIMIT 1
    `)
  );
  const voucherNumber =
    existing?.voucher_number ??
    familyNumber ??
    (await allocateVoucherNumberTx(tx, {
      companyId: input.companyId,
      voucherType: request.voucher.voucherType,
      voucherDate: request.voucher.voucherDate,
    }));
  const { voucher, replayed } = await insertInfrastructureVoucherTx(
    tx,
    {
      companyId: input.companyId,
      voucherNumber,
      voucherType: request.voucher.voucherType,
      voucherDate: request.voucher.voucherDate,
      effectiveDate: request.voucher.effectiveDate ?? null,
      description: request.voucher.description ?? null,
      totalAmount: documentCurrencyTotal(request) ?? debit.toFixed(2),
      currency: request.voucher.currency ?? "USD",
      exchangeRate: request.voucher.exchangeRate ?? null,
      locationId: request.voucher.locationId ?? null,
      optional: request.voucher.optional ?? false,
      sourceModule: request.voucher.sourceModule ?? "FACTORY",
    },
    source,
    { entries: request.entries }
  );
  await tx.insert(voucherEntries).values(request.entries.map((entry) => ({ voucherId: voucher.id, ...entry })));
  return { voucherId: voucher.id, replayed };
}

/** The lines of a USD voucher's exact mirror (sides swapped, every target kept), for a reversal journal. */
export function mirroredUsdLines(
  entries: ReadonlyArray<{
    ledgerAccountId?: number | null;
    bankAccountId?: number | null;
    fixedAssetId?: number | null;
    supplierId?: number | null;
    employeeId?: number | null;
    customerId?: number | null;
    factorySupplierId?: number | null;
    debitAmount?: string | null;
    creditAmount?: string | null;
    narration?: string | null;
  }>,
  label: string
): FactoryVoucherLine[] {
  return entries
    .filter((entry) => !dec(entry.debitAmount).isZero() || !dec(entry.creditAmount).isZero())
    .map((entry) => ({
      ledgerAccountId: entry.ledgerAccountId ?? null,
      bankAccountId: entry.bankAccountId ?? null,
      fixedAssetId: entry.fixedAssetId ?? null,
      supplierId: entry.supplierId ?? null,
      employeeId: entry.employeeId ?? null,
      customerId: entry.customerId ?? null,
      factorySupplierId: entry.factorySupplierId ?? null,
      debit: dec(entry.creditAmount),
      credit: dec(entry.debitAmount),
      narration: `${label}: ${entry.narration || "original entry"}`,
    }));
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
