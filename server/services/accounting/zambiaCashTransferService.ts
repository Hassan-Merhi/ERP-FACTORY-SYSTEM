/**
 * Same-company ZMW <-> USD cash/bank FX transfer.
 *
 * One balanced ERP voucher holds USD accounting amounts and the real original
 * source/destination currency. This is a new transaction, NEVER a revaluation
 * entry or a mutation of existing journal/opening balances.
 */
import Decimal from "decimal.js";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { accountingPostingRequests, bankAccounts, ledgerAccounts } from "@shared/schema";
import { db, type DbTransaction } from "../../db";
import { postErpVoucherTx, type ErpVoucherLine, type ErpPostingResult } from "./erpVoucherPosting";
import { assertApprovedZmwVoucherRate, ZambiaVoucherRateError } from "./zambiaVoucherRatePolicy";
import { getCashBankRevaluation, type CashBankCurrencySummary } from "./cashBankRevaluationService";
import { companyRateDateSchema, companyRateValueSchema } from "@shared/companyRatePolicy";
import type { PostingActor } from "./centralPostingEngine";

const accountTarget = z.object({
  kind: z.enum(["ledger", "bank"]),
  id: z.number().int().positive(),
});
const transferInputSchema = z
  .object({
    from: accountTarget,
    to: accountTarget,
    fromCurrency: z.enum(["USD", "ZMW"]),
    toCurrency: z.enum(["USD", "ZMW"]),
    /** Amount *leaving* the source, in the original source currency. */
    amount: z.string().regex(/^\d{1,12}(?:\.\d{1,2})?$/, "Use a positive 2-decimal currency amount."),
    /** ERP foreign-units-per-USD. Must equal company's approved dated rate. */
    rate: companyRateValueSchema,
    transferDate: companyRateDateSchema,
    /** Stable user-request id for retry/replay protection. */
    clientRequestId: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/),
    description: z.string().max(400).nullish(),
  })
  .strict();

type Target = z.infer<typeof accountTarget>;

function targetLine(target: Target): Pick<ErpVoucherLine, "ledgerAccountId" | "bankAccountId"> {
  return target.kind === "ledger" ? { ledgerAccountId: target.id } : { bankAccountId: target.id };
}

async function loadTransferAccount(tx: DbTransaction, companyId: number, target: Target) {
  if (target.kind === "ledger") {
    const [account] = await tx
      .select({
        id: ledgerAccounts.id,
        name: ledgerAccounts.name,
        accountType: ledgerAccounts.accountType,
        active: ledgerAccounts.active,
      })
      .from(ledgerAccounts)
      .where(
        and(eq(ledgerAccounts.companyId, companyId), eq(ledgerAccounts.id, target.id), isNull(ledgerAccounts.deletedAt))
      )
      .limit(1);
    if (!account || (account.accountType !== "Cash" && account.accountType !== "Bank") || !account.active) {
      throw new ZambiaVoucherRateError("Source/destination must be an active Cash or Bank ledger in this company.");
    }
    return { name: account.name, linkedLedgerId: target.id };
  }
  const [account] = await tx
    .select({
      id: bankAccounts.id,
      name: bankAccounts.name,
      active: bankAccounts.active,
      linkedLedgerId: bankAccounts.linkedLedgerId,
    })
    .from(bankAccounts)
    .where(and(eq(bankAccounts.companyId, companyId), eq(bankAccounts.id, target.id), isNull(bankAccounts.deletedAt)))
    .limit(1);
  if (!account || !account.active) {
    throw new ZambiaVoucherRateError(
      "Source/destination bank account is missing, inactive, or belongs to another company."
    );
  }
  return { name: account.name, linkedLedgerId: account.linkedLedgerId };
}

/** A read-only native-balance snapshot, not a historical FX recalculation. */
function sourceSummary(summaries: CashBankCurrencySummary[], source: Target): CashBankCurrencySummary {
  const found = summaries.find((row) => row.accountKind === source.kind && row.id === source.id);
  if (
    !found ||
    found.totalsProvisional ||
    found.openingBalanceCurrencyUnresolved ||
    found.unresolvedLegacyEntryCount > 0
  ) {
    throw new ZambiaVoucherRateError(
      "Source cash/bank currency balance is unavailable or unresolved; reconcile before transferring."
    );
  }
  return found;
}

export async function postZambiaCashTransfer(
  input: unknown,
  companyId: number,
  actor: PostingActor
): Promise<{
  voucherId: number;
  voucherNumber: string;
  replayed: boolean;
  fromAmount: string;
  toAmount: string;
  fromCurrency: string;
  toCurrency: string;
  rate: string;
}> {
  const parsed = transferInputSchema.safeParse(input);
  if (!parsed.success)
    throw new ZambiaVoucherRateError(parsed.error.issues[0]?.message || "Invalid ZMW transfer request");
  const data = parsed.data;
  if (data.from.kind === data.to.kind && data.from.id === data.to.id) {
    throw new ZambiaVoucherRateError("Choose different source and destination accounts.");
  }
  if (data.fromCurrency === data.toCurrency) {
    throw new ZambiaVoucherRateError(
      "This workflow converts USD and ZMW. Same-currency transfers use the standard journal."
    );
  }
  const rate = await assertApprovedZmwVoucherRate(companyId, data.transferDate, "ZMW", data.rate);
  if (!rate) throw new ZambiaVoucherRateError("Approved USD/ZMW rate is required.");
  const fx = new Decimal(rate);
  const source = new Decimal(data.amount);
  if (!source.isFinite() || source.lte(0)) throw new ZambiaVoucherRateError("Source amount must be greater than zero.");
  const destination =
    data.fromCurrency === "USD" ? source.times(fx).toDecimalPlaces(2) : source.div(fx).toDecimalPlaces(2);
  if (destination.lte(0))
    throw new ZambiaVoucherRateError("Converted destination amount is below the minimum currency unit.");

  // Both sides have a ledger USD base amount rounded once at the posting
  // engine boundary. Reject any cross-currency request whose base imbalance
  // would exceed normal cent precision; do not invent FX income to plug it.
  const usdBase = data.fromCurrency === "USD" ? source : destination;
  const otherUsd = data.toCurrency === "ZMW" ? destination.div(fx) : source.div(fx);
  if (usdBase.minus(otherUsd).abs().gt("0.005")) {
    throw new ZambiaVoucherRateError(
      "Converted amounts cannot be balanced at USD cent precision; adjust the source amount."
    );
  }
  const usdAmount = usdBase.toDecimalPlaces(2).toFixed(2);
  const sourceNative = source.toFixed(2);
  const destinationNative = destination.toFixed(2);
  const sourceLine: ErpVoucherLine = {
    ...targetLine(data.from),
    credit: usdAmount,
    narration: "ZMW currency exchange - funds out",
    ...(data.fromCurrency === "ZMW" ? { transaction: { currency: "ZMW", amount: sourceNative, rate } } : {}),
  };
  const targetLineValue: ErpVoucherLine = {
    ...targetLine(data.to),
    debit: usdAmount,
    narration: "ZMW currency exchange - funds in",
    ...(data.toCurrency === "ZMW" ? { transaction: { currency: "ZMW", amount: destinationNative, rate } } : {}),
  };

  const posted: ErpPostingResult = await db.transaction(async (tx) => {
    // Serialize *this currency conversion workflow* per company. Other
    // third-party/manual posting routes do not use this advisory key, so
    // the native-balance preflight remains an additional safeguard rather
    // than an absolute guarantee against every concurrent cash movement.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(991732, ${companyId})`);

    // Check account ownership in the same transaction that creates the voucher.
    const sourceAccount = await loadTransferAccount(tx, companyId, data.from);
    const destAccount = await loadTransferAccount(tx, companyId, data.to);
    // A bank's linked ledger refers to the same physical account: prevent
    // both identifiers being used as two different transfer endpoints.
    if (sourceAccount.linkedLedgerId && sourceAccount.linkedLedgerId === destAccount.linkedLedgerId) {
      throw new ZambiaVoucherRateError("Source and destination resolve to the same linked bank/cash account.");
    }
    // The posting engine remains the source of truth for balancing, tenant
    // ownership, accounting period, duplicate request and audit triggers.
    // On a retry after a successful commit, the source balance may be lower.
    // Permit the canonical engine to check its stored request fingerprint and
    // return the original voucher instead of blocking a legitimate retry.
    const [existingRequest] = await tx
      .select({ id: accountingPostingRequests.id })
      .from(accountingPostingRequests)
      .where(
        and(
          eq(accountingPostingRequests.companyId, companyId),
          eq(accountingPostingRequests.idempotencyKey, "zambia-cash-currency-transfer:" + data.clientRequestId)
        )
      )
      .limit(1);
    if (!existingRequest) {
      const balances = await getCashBankRevaluation(companyId, { attribution: "engine" });
      const available = new Decimal(
        sourceSummary(balances.accounts, data.from).nativeBalancesByCurrency[data.fromCurrency] ?? "0"
      );
      if (available.lt(source)) throw new ZambiaVoucherRateError("Insufficient verified funds in the source currency.");
    }

    return postErpVoucherTx(tx, {
      companyId,
      voucherType: "Journal",
      voucherDate: data.transferDate,
      description: data.description?.trim() || `Currency transfer ${data.fromCurrency} to ${data.toCurrency}`,
      currency: "USD", // mixed-currency journal, USD accounting base
      source: { type: "zambia-cash-currency-transfer", id: data.clientRequestId },
      actor,
      lines: [sourceLine, targetLineValue],
    });
  });

  return {
    voucherId: posted.voucher.id,
    voucherNumber: posted.voucher.voucherNumber,
    replayed: posted.replayed,
    fromAmount: sourceNative,
    toAmount: destinationNative,
    fromCurrency: data.fromCurrency,
    toCurrency: data.toCurrency,
    rate,
  };
}
