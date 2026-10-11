/**
 * The one intercompany posting service (accounting audit phase 26, MC-1,
 * MC-3, MC-4, MC-11).
 *
 * An intercompany movement of money is two vouchers, one per company, and one
 * `inter_company_transfers` link. Every writer (the inter-company and simple
 * transfer forms, the rental auto-transfer, the POS cash mirror, the
 * cross-company line reclassification) posts it here, inside the caller's
 * transaction, so both legs and the link commit together or not at all:
 *
 *   from company:  Dr due-from <to company> (intercompany)  / Cr from account
 *   to company:    Dr to account                            / Cr due-to <from company> (intercompany)
 *
 * The intercompany accounts are the configured ones when the caller has them
 * (the POS config's source/destination interco accounts), otherwise the
 * company's `IC-TO-<to code>` / `IC-FROM-<from code>` account, created when
 * missing as type Intercompany with sub-type "Due From" / "Due To" (phase 23's
 * classifier reads those as ASSET / LIABILITY). An existing account with that
 * code is used as it is (never retyped or revived: a soft-deleted one refuses
 * the posting until it is restored). The link records both intercompany
 * account ids (MC-1), so group elimination eliminates exactly them, never the
 * cash accounts. The link's creation is audited in the transaction.
 *
 * Links are soft-deleted with their vouchers (`softDeleteTransferLinkTx`) and
 * follow an edit of their legs (`updateTransferLinkTx`); they are never
 * hard-deleted (MC-11).
 */
import Decimal from "decimal.js";
import { and, eq, isNull } from "drizzle-orm";
import { companies, interCompanyTransfers, ledgerAccounts, type InterCompanyTransfer } from "@shared/schema";

import type { DbTransaction } from "../../../db";
import { HttpError } from "../../../lib/httpError";
import { MONEY_DECIMAL_PLACES, toMoney, type MoneyInput } from "../../../lib/money";
import { writeAuditEvent } from "../../audit";
import type { PostingActor } from "../centralPostingEngine";
import { postErpVoucherTx } from "../erpVoucherPosting";
import { withIntercompanyCompaniesTx, type IntercompanyAuthorization } from "./intercompanyScope";

export const INTERCOMPANY_ACCOUNT_TYPE = "Intercompany";
export const INTERCOMPANY_DUE_FROM_SUBTYPE = "Due From";
export const INTERCOMPANY_DUE_TO_SUBTYPE = "Due To";

export class IntercompanyPostingError extends HttpError {
  constructor(
    statusCode: number,
    readonly code: string,
    message: string
  ) {
    super(statusCode, message);
    this.name = "IntercompanyPostingError";
  }
}

/** The due-from code in the from company, naming the to company. */
export function dueFromAccountCode(toCompanyCode: string): string {
  return `IC-TO-${toCompanyCode}`;
}

/** The due-to code in the to company, naming the from company. */
export function dueToAccountCode(fromCompanyCode: string): string {
  return `IC-FROM-${fromCompanyCode}`;
}

interface CompanyRow {
  id: number;
  code: string;
  name: string;
  baseCurrency: string | null;
}

async function companyTx(tx: DbTransaction, companyId: number): Promise<CompanyRow> {
  const [row] = await tx
    .select({ id: companies.id, code: companies.code, name: companies.name, baseCurrency: companies.baseCurrency })
    .from(companies)
    .where(eq(companies.id, companyId));
  if (!row) throw new IntercompanyPostingError(404, "INTERCOMPANY_COMPANY_NOT_FOUND", `Company ${companyId} not found`);
  return row;
}

/** A live ledger account of the company, or a 409. */
async function liveAccountTx(tx: DbTransaction, companyId: number, accountId: number, role: string): Promise<number> {
  const [row] = await tx
    .select({ id: ledgerAccounts.id, deletedAt: ledgerAccounts.deletedAt })
    .from(ledgerAccounts)
    .where(and(eq(ledgerAccounts.id, accountId), eq(ledgerAccounts.companyId, companyId)));
  if (!row || row.deletedAt) {
    throw new IntercompanyPostingError(
      409,
      "INTERCOMPANY_ACCOUNT_NOT_POSTABLE",
      `The ${role} account ${accountId} is not a live account of company ${companyId}.`
    );
  }
  return row.id;
}

/**
 * The company's intercompany account with the code, created (type
 * Intercompany) when missing. A soft-deleted one refuses (it keeps the unique
 * (company, code) key and is never revived here).
 */
export async function ensureIntercompanyAccountTx(
  tx: DbTransaction,
  input: { companyId: number; code: string; name: string; subType: string }
): Promise<number> {
  const [existing] = await tx
    .select({ id: ledgerAccounts.id, deletedAt: ledgerAccounts.deletedAt })
    .from(ledgerAccounts)
    .where(and(eq(ledgerAccounts.companyId, input.companyId), eq(ledgerAccounts.code, input.code)))
    .limit(1);
  if (existing && !existing.deletedAt) return existing.id;
  if (existing) {
    throw new IntercompanyPostingError(
      409,
      "INTERCOMPANY_ACCOUNT_DELETED",
      `The intercompany account ${input.code} of company ${input.companyId} is deleted. Restore it from Deleted Items first.`
    );
  }
  const [created] = await tx
    .insert(ledgerAccounts)
    .values({
      companyId: input.companyId,
      code: input.code,
      name: input.name,
      accountType: INTERCOMPANY_ACCOUNT_TYPE,
      subType: input.subType,
      openingBalance: "0",
      active: true,
    })
    .returning({ id: ledgerAccounts.id });
  return created.id;
}

/** The pair of intercompany accounts of a movement from `from` to `to`. */
export async function resolveIntercompanyAccountsTx(
  tx: DbTransaction,
  from: CompanyRow,
  to: CompanyRow,
  configured?: { fromIcAccountId?: number | null; toIcAccountId?: number | null }
): Promise<{ fromIcAccountId: number; toIcAccountId: number }> {
  const fromIcAccountId = configured?.fromIcAccountId
    ? await liveAccountTx(tx, from.id, configured.fromIcAccountId, "intercompany")
    : await ensureIntercompanyAccountTx(tx, {
        companyId: from.id,
        code: dueFromAccountCode(to.code),
        name: `Inter-Company - ${to.name}`,
        subType: INTERCOMPANY_DUE_FROM_SUBTYPE,
      });
  const toIcAccountId = configured?.toIcAccountId
    ? await liveAccountTx(tx, to.id, configured.toIcAccountId, "intercompany")
    : await ensureIntercompanyAccountTx(tx, {
        companyId: to.id,
        code: dueToAccountCode(from.code),
        name: `Inter-Company - ${from.name}`,
        subType: INTERCOMPANY_DUE_TO_SUBTYPE,
      });
  return { fromIcAccountId, toIcAccountId };
}

export interface IntercompanyLegPosting {
  companyId: number;
  debitAccountId: number;
  creditAccountId: number;
  amount: string;
}

/** Posts one leg and returns its voucher id. The default posts through postErpVoucherTx. */
export type IntercompanyLegPoster = (tx: DbTransaction, leg: IntercompanyLegPosting) => Promise<number>;

export interface IntercompanyLegInput {
  /** The non-intercompany account: credited in the from company, debited in the to company. */
  accountId: number;
  voucherType?: string;
  description?: string | null;
  narration?: string | null;
  /** Posting identity of the leg (replays post nothing twice). */
  source?: { type: string; id: string | number; revision?: string | number | null };
  /** A caller-built poster (the transfer forms keep their own numbering and identity). */
  post?: IntercompanyLegPoster;
}

export interface IntercompanyTransferInput {
  fromCompanyId: number;
  toCompanyId: number;
  amount: MoneyInput;
  transferDate: string;
  transferType?: "Cash" | "Loan";
  description?: string | null;
  sourceType: string;
  sourcePaymentId?: number | null;
  from: IntercompanyLegInput;
  to: IntercompanyLegInput;
  /** Configured intercompany accounts (else IC-TO-/IC-FROM- by code). */
  intercompanyAccounts?: { fromIcAccountId?: number | null; toIcAccountId?: number | null };
  authorization: IntercompanyAuthorization;
  actor?: PostingActor;
}

export interface IntercompanyTransferResult {
  transfer: InterCompanyTransfer;
  fromVoucherId: number;
  toVoucherId: number;
  replayed: boolean;
}

function exactAmount(value: MoneyInput): string {
  let amount: Decimal;
  try {
    amount = toMoney(value).toDecimalPlaces(MONEY_DECIMAL_PLACES, Decimal.ROUND_HALF_UP);
  } catch {
    throw new IntercompanyPostingError(400, "INTERCOMPANY_AMOUNT_INVALID", "Transfer amount is invalid");
  }
  if (!amount.isFinite() || !amount.gt(0)) {
    throw new IntercompanyPostingError(400, "INTERCOMPANY_AMOUNT_INVALID", "Transfer amount must be positive");
  }
  return amount.toFixed(MONEY_DECIMAL_PLACES);
}

function defaultPoster(
  leg: IntercompanyLegInput,
  date: string,
  fallbackType: string,
  actor?: PostingActor
): IntercompanyLegPoster {
  return async (tx, posting) => {
    if (!leg.source) {
      throw new IntercompanyPostingError(500, "INTERCOMPANY_SOURCE_REQUIRED", "An intercompany leg needs a source");
    }
    const narration = leg.narration ?? leg.description ?? null;
    const { voucher } = await postErpVoucherTx(tx, {
      companyId: posting.companyId,
      voucherType: leg.voucherType ?? fallbackType,
      voucherDate: date,
      description: leg.description ?? narration,
      lines: [
        { ledgerAccountId: posting.debitAccountId, debit: posting.amount, narration },
        { ledgerAccountId: posting.creditAccountId, credit: posting.amount, narration },
      ],
      source: leg.source,
      actor,
    });
    return Number(voucher.id);
  };
}

function auditActor(actor?: PostingActor) {
  const userId = actor?.userId === null || actor?.userId === undefined ? undefined : String(actor.userId);
  return { userId, username: actor?.username ?? userId };
}

/**
 * Posts both legs of an intercompany movement and its link in `tx`.
 * Same base currency required: a movement between companies with different
 * base currencies needs a rate (phase 24, MC-5) and is refused here.
 */
export async function postIntercompanyTransferTx(
  tx: DbTransaction,
  input: IntercompanyTransferInput
): Promise<IntercompanyTransferResult> {
  if (input.fromCompanyId === input.toCompanyId) {
    throw new IntercompanyPostingError(
      400,
      "INTERCOMPANY_SAME_COMPANY",
      "An intercompany transfer needs two companies"
    );
  }
  const amount = exactAmount(input.amount);
  return withIntercompanyCompaniesTx(tx, [input.fromCompanyId, input.toCompanyId], input.authorization, async () => {
    const from = await companyTx(tx, input.fromCompanyId);
    const to = await companyTx(tx, input.toCompanyId);
    if ((from.baseCurrency ?? "USD").toUpperCase() !== (to.baseCurrency ?? "USD").toUpperCase()) {
      throw new IntercompanyPostingError(
        409,
        "INTERCOMPANY_BASE_CURRENCY_DIFFERS",
        `${from.name} and ${to.name} keep their books in different currencies; this transfer needs an exchange rate.`
      );
    }
    const fromAccountId = await liveAccountTx(tx, from.id, input.from.accountId, "source");
    const toAccountId = await liveAccountTx(tx, to.id, input.to.accountId, "destination");
    const ic = await resolveIntercompanyAccountsTx(tx, from, to, input.intercompanyAccounts);

    const postFrom = input.from.post ?? defaultPoster(input.from, input.transferDate, "Payment", input.actor);
    const postTo = input.to.post ?? defaultPoster(input.to, input.transferDate, "Receipt", input.actor);
    const fromVoucherId = await postFrom(tx, {
      companyId: from.id,
      debitAccountId: ic.fromIcAccountId,
      creditAccountId: fromAccountId,
      amount,
    });
    const toVoucherId = await postTo(tx, {
      companyId: to.id,
      debitAccountId: toAccountId,
      creditAccountId: ic.toIcAccountId,
      amount,
    });

    const [existing] = await tx
      .select()
      .from(interCompanyTransfers)
      .where(
        and(
          eq(interCompanyTransfers.fromVoucherId, fromVoucherId),
          eq(interCompanyTransfers.toVoucherId, toVoucherId),
          isNull(interCompanyTransfers.deletedAt)
        )
      )
      .limit(1);
    if (existing) return { transfer: existing, fromVoucherId, toVoucherId, replayed: true };

    const [transfer] = await tx
      .insert(interCompanyTransfers)
      .values({
        transferType: input.transferType ?? "Cash",
        fromCompanyId: from.id,
        toCompanyId: to.id,
        transferDate: input.transferDate,
        amount,
        fromLedgerAccountId: fromAccountId,
        toLedgerAccountId: toAccountId,
        fromVoucherId,
        toVoucherId,
        description: input.description ?? null,
        sourcePaymentId: input.sourcePaymentId ?? null,
        fromIcAccountId: ic.fromIcAccountId,
        toIcAccountId: ic.toIcAccountId,
        sourceType: input.sourceType,
      })
      .returning();
    await writeAuditEvent(
      {
        ...auditActor(input.actor),
        companyId: from.id,
        action: "create",
        tableName: "inter_company_transfers",
        recordId: transfer.id,
        recordIdentifier: `${input.sourceType}:${transfer.id}`,
        reason: input.actor?.reason ?? null,
        changes: {
          transfer: {
            new: {
              fromCompanyId: from.id,
              toCompanyId: to.id,
              amount,
              transferDate: input.transferDate,
              fromVoucherId,
              toVoucherId,
              fromLedgerAccountId: fromAccountId,
              toLedgerAccountId: toAccountId,
              fromIcAccountId: ic.fromIcAccountId,
              toIcAccountId: ic.toIcAccountId,
              sourcePaymentId: input.sourcePaymentId ?? null,
            },
          },
        },
      },
      tx
    );
    return { transfer, fromVoucherId, toVoucherId, replayed: false };
  });
}

/**
 * Soft-deletes a live transfer link (its vouchers are retired by the caller),
 * audited in `tx`. Returns false when it was already deleted or missing.
 */
export async function softDeleteTransferLinkTx(
  tx: DbTransaction,
  transferId: number,
  options: { reason: string; actor?: { userId?: string | number | null; username?: string | null } | null }
): Promise<boolean> {
  const deletedBy =
    options.actor?.userId === null || options.actor?.userId === undefined ? null : String(options.actor.userId);
  const [row] = await tx
    .update(interCompanyTransfers)
    .set({ deletedAt: new Date(), deletedBy, deleteReason: options.reason.slice(0, 500) })
    .where(and(eq(interCompanyTransfers.id, transferId), isNull(interCompanyTransfers.deletedAt)))
    .returning();
  if (!row) return false;
  await writeAuditEvent(
    {
      userId: deletedBy ?? undefined,
      username: options.actor?.username ?? deletedBy ?? undefined,
      companyId: row.fromCompanyId,
      action: "delete",
      tableName: "inter_company_transfers",
      recordId: row.id,
      recordIdentifier: `${row.sourceType ?? "inter-company-transfer"}:${row.id}`,
      reason: options.reason,
      changes: {
        deletedAt: { old: null, new: row.deletedAt?.toISOString() ?? null },
        transfer: {
          old: {
            fromCompanyId: row.fromCompanyId,
            toCompanyId: row.toCompanyId,
            amount: row.amount,
            transferDate: row.transferDate,
            fromVoucherId: row.fromVoucherId,
            toVoucherId: row.toVoucherId,
          },
        },
      },
    },
    tx
  );
  return true;
}

/** An edit of a leg: the link takes the edited amount and date (audited by the edit). */
export async function updateTransferLinkTx(
  tx: DbTransaction,
  transferId: number,
  values: { amount?: string | null; transferDate?: string | null }
): Promise<void> {
  const set: Partial<typeof interCompanyTransfers.$inferInsert> = { updatedAt: new Date() };
  if (values.amount) set.amount = values.amount;
  if (values.transferDate) set.transferDate = values.transferDate;
  await tx
    .update(interCompanyTransfers)
    .set(set)
    .where(and(eq(interCompanyTransfers.id, transferId), isNull(interCompanyTransfers.deletedAt)));
}
