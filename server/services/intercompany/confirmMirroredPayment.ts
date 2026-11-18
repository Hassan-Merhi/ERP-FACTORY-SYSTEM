// Extracted from ./paymentSync.ts to keep that module under the source-size cap.
import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { intercompanyAuditEvents, intercompanyContainerPayments, intercompanyPaymentAllocations } from "@shared/schema";
import { db } from "../../db";
import { sumMoney } from "../../lib/money";
import { type ErpVoucherLine, postErpVoucherTx } from "../accounting/erpVoucherPosting";
import { type EditIdentity, rejectEdit, withTradeScope } from "./tradeSync";
import { cents } from "./tradeRevisionMath";
import type { PaymentCurrency } from "./paymentMoney";
import { INTERCOMPANY_PAYMENT_LOCK_NAMESPACE, paymentAvailableTx } from "./paymentAllocationCore";
import {
  accessiblePaymentPair,
  accountTarget,
  activePaymentPairTx,
  checkAccount,
  checkChosenPos,
  validatePayment,
  type MirroredPaymentInput,
} from "./accessiblePaymentPair";

export function paymentLines(
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
        sql`SELECT pg_advisory_xact_lock(${INTERCOMPANY_PAYMENT_LOCK_NAMESPACE}, ${pair.sourceCompanyId})`
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
