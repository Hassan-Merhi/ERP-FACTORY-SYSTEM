import { createHash } from "node:crypto";
/** Confirmed physical transfers: destination Payment and Properties Receipt, atomic and audited. */
import { eq, sql } from "drizzle-orm";
import {
  intercompanyAuditEvents,
  intercompanyContainerPayments,
  intercompanyRelationshipPolicies,
} from "@shared/schema";
import { db } from "../../db";
import { postErpVoucherTx } from "../accounting/erpVoucherPosting";
import { type EditIdentity, postingDay, rejectEdit, validateRequestKey, withTradeScope } from "./tradeSync";
import { type PaymentCurrency } from "./paymentMoney";
import { INTERCOMPANY_PAYMENT_LOCK_NAMESPACE, releasePaymentAllocationsTx } from "./paymentAllocationCore";
import { accessiblePaymentPair, accountTarget } from "./accessiblePaymentPair";
import { paymentLines } from "./confirmMirroredPayment";
export { accessiblePaymentPair } from "./accessiblePaymentPair";
export type { CashRef, ManualPoChoice, MirroredPaymentInput } from "./accessiblePaymentPair";
export { confirmMirroredPayment } from "./confirmMirroredPayment";
export type MirroredReversalInput = {
  paymentId: number;
  requestKey: string;
  reversalDate: string;
  reason: string;
  confirmedSourceReversal: boolean;
  confirmedDestinationReversal: boolean;
};
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
        sql`SELECT pg_advisory_xact_lock(${INTERCOMPANY_PAYMENT_LOCK_NAMESPACE}, ${pair.sourceCompanyId})`
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
      await tx.execute(sql`SELECT set_config('erp.ic_payment_reversal', ${String(payment.id)}, true)`);
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
