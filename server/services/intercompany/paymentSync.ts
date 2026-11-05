import { createHash } from "node:crypto";
/** Confirmed physical transfers: destination Payment and Properties Receipt, atomic and audited. */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  bankAccounts,
  companies,
  intercompanyAuditEvents,
  intercompanyContainerPayments,
  intercompanyImportBatchContainers,
  intercompanyPaymentAllocations,
  intercompanyRelationshipPolicies,
  intercompanyTrades,
  ledgerAccounts,
} from "@shared/schema";
import { db, type DbTransaction } from "../../db";
import { companyScopedSuppliers } from "@shared/schema/supplierCompanyScope";
import { sumMoney } from "../../lib/money";
import { postErpVoucherTx, type ErpVoucherLine } from "../accounting/erpVoucherPosting";
import { normalizeCurrencyCode } from "../accounting/currencyAmounts";
import { type EditIdentity, postingDay, rejectEdit, validateRequestKey, withTradeScope } from "./tradeSync";
import { cents } from "./tradeRevisionMath";
import {
  exactManualAllocation,
  paymentBaseAmount,
  paymentMoney,
  paymentHistoricalRate,
  type PaymentCurrency,
} from "./paymentMoney";
import {
  INTERCOMPANY_PAYMENT_LOCK_NAMESPACE,
  paymentAvailableTx,
  releasePaymentAllocationsTx,
  tradeAppliedTx,
} from "./paymentAllocationCore";

export type CashRef = { type: "bank" | "cash"; id: number };
export type ManualPoChoice = { tradeId: number; expectedVersion: number; amount: string };
export type MirroredPaymentInput = {
  relationshipId: number;
  requestKey: string;
  paymentDate: string;
  currency: PaymentCurrency;
  transactionAmount: string;
  historicalRate: string;
  sourceReceiptAccount: CashRef;
  destinationPaymentAccount: CashRef;
  transferReference: string;
  confirmationEvidence: string;
  reason: string;
  confirmedSourceReceipt: boolean;
  confirmedDestinationPayment: boolean;
  allocations: ManualPoChoice[];
};
export type MirroredReversalInput = {
  paymentId: number;
  requestKey: string;
  reversalDate: string;
  reason: string;
  confirmedSourceReversal: boolean;
  confirmedDestinationReversal: boolean;
};
type Policy = typeof intercompanyRelationshipPolicies.$inferSelect;
function validatePayment(input: MirroredPaymentInput) {
  postingDay(input.paymentDate);
  validateRequestKey(input.requestKey);
  if (
    !Number.isSafeInteger(input.relationshipId) ||
    input.relationshipId < 1 ||
    !input.confirmedSourceReceipt ||
    !input.confirmedDestinationPayment ||
    !input.transferReference ||
    input.transferReference.trim().length < 5 ||
    input.transferReference.length > 180 ||
    !input.confirmationEvidence ||
    input.confirmationEvidence.trim().length < 8 ||
    input.confirmationEvidence.length > 2000 ||
    !input.reason?.trim() ||
    input.reason.trim().length < 3 ||
    input.reason.length > 1000 ||
    !Array.isArray(input.allocations) ||
    input.allocations.length > 200
  ) {
    rejectEdit(
      "Both real money movements, original bank evidence and a reason require explicit confirmation",
      "IC_PAYMENT_EVIDENCE",
      422
    );
  }
  let currency: PaymentCurrency;
  try {
    currency = normalizeCurrencyCode(input.currency) as PaymentCurrency;
  } catch {
    rejectEdit("Use a supported historical currency", "IC_PAYMENT_CURRENCY", 422);
  }
  if (currency !== input.currency) rejectEdit("Use the canonical ERP currency", "IC_PAYMENT_CURRENCY", 422);
  let native, rate, base;
  try {
    native = paymentMoney(input.transactionAmount);
    rate = paymentHistoricalRate(currency, input.historicalRate);
    base = paymentBaseAmount(currency, input.transactionAmount, input.historicalRate);
  } catch (error) {
    rejectEdit(error instanceof Error ? error.message : "Invalid monetary amount", "IC_PAYMENT_MONEY", 422);
  }
  const unique = new Set(input.allocations.map((x) => x.tradeId));
  if (unique.size !== input.allocations.length)
    rejectEdit("Each chosen PO may appear only once", "IC_PAYMENT_DUPLICATE_PO", 422);
  for (const item of input.allocations) {
    if (
      !Number.isSafeInteger(item.tradeId) ||
      item.tradeId < 1 ||
      !Number.isSafeInteger(item.expectedVersion) ||
      item.expectedVersion < 1 ||
      typeof item.amount !== "string" ||
      !/^\d+(?:\.\d{1,2})?$/.test(item.amount) ||
      !cents(item.amount).gt(0)
    ) {
      rejectEdit("PO allocation must be positive, cent-exact and versioned", "IC_PAYMENT_ALLOCATION", 422);
    }
  }
  exactManualAllocation(
    base,
    input.allocations.map((a) => cents(a.amount)),
    input.allocations.map(() => base)
  );
  return { native, rate, base, currency };
}
function accountTarget(ref: CashRef): Pick<ErpVoucherLine, "bankAccountId" | "ledgerAccountId"> {
  return ref.type === "bank" ? { bankAccountId: ref.id } : { ledgerAccountId: ref.id };
}
async function checkAccount(tx: DbTransaction, companyId: number, ref: CashRef) {
  if (!ref || !Number.isSafeInteger(ref.id) || ref.id < 1 || !["bank", "cash"].includes(ref.type)) {
    rejectEdit("Choose active cash/bank accounts for both companies", "IC_PAYMENT_ACCOUNT", 422);
  }
  if (ref.type === "bank") {
    const [row] = await tx
      .select()
      .from(bankAccounts)
      .where(
        and(
          eq(bankAccounts.id, ref.id),
          eq(bankAccounts.companyId, companyId),
          eq(bankAccounts.active, true),
          isNull(bankAccounts.deletedAt)
        )
      );
    if (!row) rejectEdit("Selected bank account is not available in the correct company", "IC_PAYMENT_ACCOUNT", 422);
  } else {
    const [row] = await tx
      .select()
      .from(ledgerAccounts)
      .where(
        and(
          eq(ledgerAccounts.id, ref.id),
          eq(ledgerAccounts.companyId, companyId),
          eq(ledgerAccounts.accountType, "Cash"),
          eq(ledgerAccounts.active, true),
          isNull(ledgerAccounts.deletedAt)
        )
      );
    if (!row) rejectEdit("Selected cash account is not available in the correct company", "IC_PAYMENT_ACCOUNT", 422);
  }
}
export async function accessiblePaymentPair(relationshipId: number, actor: EditIdentity, requireEnabled = true) {
  if (!Number.isSafeInteger(relationshipId) || relationshipId < 1)
    rejectEdit("Invalid company relationship", "IC_PAYMENT_PAIR", 422);
  const [pair] = await db
    .select()
    .from(intercompanyRelationshipPolicies)
    .where(eq(intercompanyRelationshipPolicies.id, relationshipId));
  if (
    !pair ||
    pair.relationshipType !== "container_trade" ||
    (requireEnabled && !pair.tradeEnabled) ||
    ![pair.sourceCompanyId, pair.destinationCompanyId].includes(actor.initiatingCompanyId)
  ) {
    rejectEdit("No active paired intercompany payment relation in your company", "IC_PAYMENT_PAIR", 403);
  }
  return pair;
}
async function activePaymentPairTx(tx: DbTransaction, id: number) {
  const [pair] = await tx
    .select()
    .from(intercompanyRelationshipPolicies)
    .where(eq(intercompanyRelationshipPolicies.id, id))
    .for("update");
  if (
    !pair ||
    pair.relationshipType !== "container_trade" ||
    !pair.tradeEnabled ||
    !pair.sourceReceivableAccountId ||
    !pair.destinationSupplierId
  ) {
    rejectEdit("Pair is disabled or lacks verified receivable and supplier mappings");
  }
  const rows = await tx
    .select()
    .from(companies)
    .where(inArray(companies.id, [pair.sourceCompanyId, pair.destinationCompanyId]));
  const source = rows.find((c) => c.id === pair.sourceCompanyId),
    dest = rows.find((c) => c.id === pair.destinationCompanyId);
  if (
    !source ||
    !dest ||
    !source.active ||
    !dest.active ||
    source.companyType !== "properties" ||
    dest.companyType !== "erp" ||
    (source.baseCurrency ?? "USD") !== "USD" ||
    (dest.baseCurrency ?? "USD") !== "USD"
  ) {
    rejectEdit("Paired payment requires active USD-base Properties and ERP companies");
  }
  const [destinationSupplier] = await tx
    .select()
    .from(companyScopedSuppliers)
    .where(
      and(
        eq(companyScopedSuppliers.id, pair.destinationSupplierId!),
        eq(companyScopedSuppliers.companyId, pair.destinationCompanyId),
        eq(companyScopedSuppliers.active, true),
        isNull(companyScopedSuppliers.deletedAt)
      )
    );
  const normalizeName = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();
  if (!destinationSupplier || normalizeName(destinationSupplier.legalName) !== normalizeName(source.name)) {
    rejectEdit("The destination intercompany supplier must represent the original Properties company");
  }
  return pair;
}
async function checkChosenPos(tx: DbTransaction, pair: Policy, choices: ManualPoChoice[], base: string) {
  const amounts = choices.map((c) => cents(c.amount)),
    available = [];
  for (const choice of choices) {
    const [trade] = await tx.select().from(intercompanyTrades).where(eq(intercompanyTrades.id, choice.tradeId));
    if (
      !trade ||
      trade.state !== "active" ||
      trade.relationshipId !== pair.id ||
      trade.sourceCompanyId !== pair.sourceCompanyId ||
      trade.destinationCompanyId !== pair.destinationCompanyId
    ) {
      rejectEdit(
        "A chosen PO belongs to another pair, so its money cannot be moved here",
        "IC_PAYMENT_WRONG_PAIR",
        409
      );
    }
    if (trade.version !== choice.expectedVersion)
      rejectEdit("PO changed; refresh allocation before confirmation", "IC_PAYMENT_PO_STALE");
    const [posted] = await tx
      .select()
      .from(intercompanyImportBatchContainers)
      .where(eq(intercompanyImportBatchContainers.tradeId, trade.id));
    if (!posted || posted.confirmedLandedCost == null) rejectEdit("Selected PO has no confirmed landed cost");
    const due = cents(posted.confirmedLandedCost).minus(await tradeAppliedTx(tx, trade.id));
    if (due.lt(0)) rejectEdit("Selected PO has inconsistent prior allocations");
    available.push(due);
  }
  exactManualAllocation(cents(base), amounts, available);
}
function paymentLines(
  usd: string,
  currency: PaymentCurrency,
  native: string,
  rate: string,
  debit: Pick<ErpVoucherLine, "bankAccountId" | "ledgerAccountId" | "supplierId">,
  credit: Pick<ErpVoucherLine, "bankAccountId" | "ledgerAccountId" | "supplierId">
): ErpVoucherLine[] {
  const transaction = currency === "USD" ? {} : { transaction: { currency, amount: native, rate } };
  return [
    { ...debit, debit: usd, narration: "Confirmed paired intercompany payment", ...transaction },
    { ...credit, credit: usd, narration: "Confirmed paired intercompany payment", ...transaction },
  ];
}
export async function confirmMirroredPayment(input: MirroredPaymentInput, actor: EditIdentity) {
  const { native, rate, base, currency } = validatePayment(input);
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        pair: input.relationshipId,
        paymentDate: input.paymentDate,
        currency,
        native: native.toFixed(6),
        rate: rate.toFixed(10),
        base: base.toFixed(2),
        transferReference: input.transferReference.trim(),
        confirmationEvidence: input.confirmationEvidence.trim(),
        reason: input.reason.trim(),
        sourceCash: input.sourceReceiptAccount,
        destinationCash: input.destinationPaymentAccount,
        allocations: [...input.allocations]
          .map((a) => ({
            tradeId: a.tradeId,
            version: a.expectedVersion,
            amount: cents(a.amount).toFixed(2),
          }))
          .sort((a, b) => a.tradeId - b.tradeId),
      })
    )
    .digest("hex");
  const pair = await accessiblePaymentPair(input.relationshipId, actor);
  return withTradeScope(actor, [pair.sourceCompanyId, pair.destinationCompanyId], () =>
    db.transaction(async (tx) => {
      await tx.execute(
        sql.raw(
          "SELECT pg_advisory_xact_lock(" + INTERCOMPANY_PAYMENT_LOCK_NAMESPACE + "," + pair.sourceCompanyId + ")"
        )
      );
      const [duplicate] = await tx
        .select()
        .from(intercompanyContainerPayments)
        .where(eq(intercompanyContainerPayments.requestKey, input.requestKey));
      if (duplicate) {
        if (
          duplicate.relationshipId !== input.relationshipId ||
          duplicate.status !== "confirmed" ||
          duplicate.requestFingerprint !== fingerprint
        ) {
          rejectEdit("Payment key already belongs to a different transaction", "IC_PAYMENT_REPLAY");
        }
        const available = await paymentAvailableTx(tx, duplicate.id);
        return {
          paymentId: duplicate.id,
          usdAmount: duplicate.baseAmount,
          sourceVoucherId: duplicate.sourceReceiptVoucherId,
          destinationVoucherId: duplicate.destinationPaymentVoucherId,
          unallocatedCredit: available.toFixed(2),
          replayed: true,
        };
      }
      const fresh = await activePaymentPairTx(tx, pair.id);
      await checkAccount(tx, fresh.sourceCompanyId, input.sourceReceiptAccount);
      await checkAccount(tx, fresh.destinationCompanyId, input.destinationPaymentAccount);
      await checkChosenPos(tx, fresh, input.allocations, base.toFixed(2));
      const source = await postErpVoucherTx(tx, {
        companyId: fresh.sourceCompanyId,
        voucherType: "Receipt",
        voucherDate: input.paymentDate,
        currency,
        exchangeRate: rate.toFixed(10),
        sourceModule: "INTERCOMPANY_CONTAINER",
        description: "Actual confirmed receipt " + input.transferReference.trim(),
        source: { type: "ic-paired-receipt", id: input.requestKey },
        actor: { userId: actor.actorUserId, reason: input.reason.trim() },
        lines: paymentLines(
          base.toFixed(2),
          currency,
          native.toFixed(6),
          rate.toFixed(10),
          accountTarget(input.sourceReceiptAccount),
          { ledgerAccountId: fresh.sourceReceivableAccountId! }
        ),
      });
      const destination = await postErpVoucherTx(tx, {
        companyId: fresh.destinationCompanyId,
        voucherType: "Payment",
        voucherDate: input.paymentDate,
        currency,
        exchangeRate: rate.toFixed(10),
        sourceModule: "INTERCOMPANY_CONTAINER",
        description: "Actual confirmed payment " + input.transferReference.trim(),
        source: { type: "ic-paired-payment", id: input.requestKey },
        actor: { userId: actor.actorUserId, reason: input.reason.trim() },
        lines: paymentLines(
          base.toFixed(2),
          currency,
          native.toFixed(6),
          rate.toFixed(10),
          { supplierId: fresh.destinationSupplierId! },
          accountTarget(input.destinationPaymentAccount)
        ),
      });
      const [payment] = await tx
        .insert(intercompanyContainerPayments)
        .values({
          relationshipId: fresh.id,
          sourceCompanyId: fresh.sourceCompanyId,
          destinationCompanyId: fresh.destinationCompanyId,
          requestKey: input.requestKey,
          requestFingerprint: fingerprint,
          transferReference: input.transferReference.trim(),
          confirmationEvidence: input.confirmationEvidence.trim(),
          paymentDate: input.paymentDate,
          transactionCurrency: currency,
          transactionAmount: native.toFixed(6),
          historicalRate: rate.toFixed(10),
          baseAmount: base.toFixed(2),
          sourceCashType: input.sourceReceiptAccount.type,
          sourceCashId: input.sourceReceiptAccount.id,
          destinationCashType: input.destinationPaymentAccount.type,
          destinationCashId: input.destinationPaymentAccount.id,
          sourceReceivableAccountId: fresh.sourceReceivableAccountId!,
          destinationSupplierId: fresh.destinationSupplierId!,
          sourceReceiptVoucherId: source.voucher.id,
          destinationPaymentVoucherId: destination.voucher.id,
          status: "confirmed",
          createdBy: actor.actorUserId,
        })
        .returning();
      for (const choice of input.allocations) {
        await tx.insert(intercompanyPaymentAllocations).values({
          paymentId: payment.id,
          tradeId: choice.tradeId,
          amount: cents(choice.amount).toFixed(2),
          allocationKind: "manual",
          requestKey: "ic-manual-payment:" + payment.id + ":" + choice.tradeId,
          createdBy: actor.actorUserId,
          reason: "Explicit customer-selected purchase order payment",
        });
      }
      const applied = sumMoney(input.allocations.map((c) => cents(c.amount)));
      await tx.insert(intercompanyAuditEvents).values({
        eventKey: "ic-confirmed-payment:" + payment.id,
        relationshipId: fresh.id,
        sourceCompanyId: fresh.sourceCompanyId,
        actorUserId: actor.actorUserId,
        eventType: "intercompany-confirmed-paired-cash",
        sourceReference: input.transferReference.trim(),
        payload: {
          paymentId: payment.id,
          baseAmount: base.toFixed(2),
          transactionAmount: native.toFixed(6),
          currency,
          historicalRate: rate.toFixed(10),
          sourceVoucherId: source.voucher.id,
          destinationVoucherId: destination.voucher.id,
          allocations: input.allocations,
          unallocatedCredit: base.minus(applied).toFixed(2),
        },
      });
      return {
        paymentId: payment.id,
        usdAmount: base.toFixed(2),
        sourceVoucherId: source.voucher.id,
        destinationVoucherId: destination.voucher.id,
        unallocatedCredit: base.minus(applied).toFixed(2),
        replayed: false,
      };
    })
  );
}
export async function reverseMirroredPayment(input: MirroredReversalInput, actor: EditIdentity) {
  postingDay(input.reversalDate);
  validateRequestKey(input.requestKey);
  if (
    !Number.isSafeInteger(input.paymentId) ||
    input.paymentId < 1 ||
    !input.confirmedSourceReversal ||
    !input.confirmedDestinationReversal ||
    !input.reason ||
    input.reason.trim().length < 3 ||
    input.reason.length > 1000
  ) {
    rejectEdit("Confirm both real cash movements were reversed, with a reason", "IC_PAYMENT_REVERSAL", 422);
  }
  const reversalFingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        paymentId: input.paymentId,
        reversalDate: input.reversalDate,
        reason: input.reason.trim(),
      })
    )
    .digest("hex");
  const [original] = await db
    .select()
    .from(intercompanyContainerPayments)
    .where(eq(intercompanyContainerPayments.id, input.paymentId));
  if (!original) rejectEdit("Mirrored payment not found", "IC_PAYMENT_NOT_FOUND", 404);
  const pair = await accessiblePaymentPair(original.relationshipId, actor, false);
  return withTradeScope(actor, [pair.sourceCompanyId, pair.destinationCompanyId], () =>
    db.transaction(async (tx) => {
      await tx.execute(
        sql.raw(
          "SELECT pg_advisory_xact_lock(" + INTERCOMPANY_PAYMENT_LOCK_NAMESPACE + "," + pair.sourceCompanyId + ")"
        )
      );
      const [payment] = await tx
        .select()
        .from(intercompanyContainerPayments)
        .where(eq(intercompanyContainerPayments.id, input.paymentId))
        .for("update");
      if (!payment) rejectEdit("Payment was not found");
      if (payment.status === "reversed") {
        if (payment.reversalKey === input.requestKey && payment.reversalFingerprint === reversalFingerprint)
          return { paymentId: payment.id, reversed: true, replayed: true };
        rejectEdit("Payment has already been reversed with a different key");
      }
      // Reversal follows ORIGINAL account targets even if the relationship was
      // disabled or remapped after the real transfer. The payment row is immutable.
      const [storedPair] = await tx
        .select()
        .from(intercompanyRelationshipPolicies)
        .where(eq(intercompanyRelationshipPolicies.id, pair.id))
        .for("update");
      if (
        !storedPair ||
        payment.sourceCompanyId !== storedPair.sourceCompanyId ||
        payment.destinationCompanyId !== storedPair.destinationCompanyId
      ) {
        rejectEdit("Original paid company pair is inconsistent");
      }
      const releases = await releasePaymentAllocationsTx(tx, { paymentId: payment.id, actorUserId: actor.actorUserId });
      const currency = payment.transactionCurrency as PaymentCurrency;
      const src = await postErpVoucherTx(tx, {
        companyId: payment.sourceCompanyId,
        voucherType: "Payment",
        voucherDate: input.reversalDate,
        currency,
        exchangeRate: payment.historicalRate,
        sourceModule: "INTERCOMPANY_CONTAINER",
        description: "Actual reversal of Properties receipt " + payment.transferReference,
        source: { type: "ic-paired-receipt-reversed", id: input.requestKey },
        actor: { userId: actor.actorUserId, reason: input.reason.trim() },
        lines: paymentLines(
          payment.baseAmount,
          currency,
          payment.transactionAmount,
          payment.historicalRate,
          { ledgerAccountId: payment.sourceReceivableAccountId },
          accountTarget({ type: payment.sourceCashType as "bank" | "cash", id: payment.sourceCashId })
        ),
      });
      const dst = await postErpVoucherTx(tx, {
        companyId: payment.destinationCompanyId,
        voucherType: "Receipt",
        voucherDate: input.reversalDate,
        currency,
        exchangeRate: payment.historicalRate,
        sourceModule: "INTERCOMPANY_CONTAINER",
        description: "Actual reversal of destination payment " + payment.transferReference,
        source: { type: "ic-paired-payment-reversed", id: input.requestKey },
        actor: { userId: actor.actorUserId, reason: input.reason.trim() },
        lines: paymentLines(
          payment.baseAmount,
          currency,
          payment.transactionAmount,
          payment.historicalRate,
          accountTarget({ type: payment.destinationCashType as "bank" | "cash", id: payment.destinationCashId }),
          { supplierId: payment.destinationSupplierId }
        ),
      });
      await tx.execute(sql.raw("SELECT set_config('erp.ic_payment_reversal','" + payment.id + "',true)"));
      await tx
        .update(intercompanyContainerPayments)
        .set({
          status: "reversed",
          reversedBy: actor.actorUserId,
          reversedAt: new Date(),
          reversalDate: input.reversalDate,
          reversalReason: input.reason.trim(),
          reversalKey: input.requestKey,
          reversalFingerprint,
          sourceReversalVoucherId: src.voucher.id,
          destinationReversalVoucherId: dst.voucher.id,
        })
        .where(eq(intercompanyContainerPayments.id, payment.id));
      await tx.execute(sql.raw("SELECT set_config('erp.ic_payment_reversal','',true)"));
      await tx.insert(intercompanyAuditEvents).values({
        eventKey: "ic-payment-reversal:" + payment.id,
        relationshipId: payment.relationshipId,
        sourceCompanyId: payment.sourceCompanyId,
        actorUserId: actor.actorUserId,
        eventType: "intercompany-paired-cash-reversed",
        sourceReference: payment.transferReference,
        payload: {
          originalPaymentId: payment.id,
          originalCurrency: currency,
          historicalRate: payment.historicalRate,
          reversalDate: input.reversalDate,
          reversalKey: input.requestKey,
          reversedAllocations: releases,
          sourceReversalVoucherId: src.voucher.id,
          destinationReversalVoucherId: dst.voucher.id,
        },
      });
      return {
        paymentId: payment.id,
        reversed: true,
        replayed: false,
        sourceReversalVoucherId: src.voucher.id,
        destinationReversalVoucherId: dst.voucher.id,
      };
    })
  );
}
