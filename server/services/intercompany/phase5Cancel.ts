/** Phase 5: cancel an unreceived trade without deleting POs, vouchers or real cash. */
import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  intercompanyAuditEvents,
  intercompanyDestinationReceipts,
  intercompanyPaymentAllocations,
  intercompanySharedChargeAllocations,
  intercompanySharedChargeInvoices,
  intercompanyTradeCancellations,
  intercompanyTrades,
} from "@shared/schema";
import { db } from "../../db";
import { MoneyDecimal } from "../../lib/money";
import { postErpVoucherTx } from "../accounting/erpVoucherPosting";
import { INTERCOMPANY_PAYMENT_LOCK_NAMESPACE } from "./paymentAllocationCore";
import {
  assertTradeAccess,
  loadTradeTx,
  postingDay,
  rejectEdit,
  requireUnreceived,
  type EditIdentity,
  validateRequestKey,
  withTradeScope,
  isNettedIntercompanyTradeTx,
} from "./tradeSync";
import { cents } from "./tradeRevisionMath";

export type CancelIntercompanyTradeInput = {
  tradeId: number;
  expectedVersion: number;
  requestKey: string;
  postingDate: string;
  reason: string;
  cancellationEvidence: string;
  sharedChargeDecision: "none" | "redistributed";
  confirmGoodsNotReceived: boolean;
  confirmNoRealCashReversal: boolean;
};

export function cancellationFingerprint(input: CancelIntercompanyTradeInput) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        tradeId: input.tradeId,
        expectedVersion: input.expectedVersion,
        requestKey: input.requestKey,
        postingDate: input.postingDate,
        reason: input.reason.trim(),
        cancellationEvidence: input.cancellationEvidence.trim(),
        sharedChargeDecision: input.sharedChargeDecision,
        confirmGoodsNotReceived: input.confirmGoodsNotReceived,
        confirmNoRealCashReversal: input.confirmNoRealCashReversal,
      })
    )
    .digest("hex");
}

export async function cancelUnreceivedTrade(input: CancelIntercompanyTradeInput, actor: EditIdentity) {
  postingDay(input.postingDate);
  validateRequestKey(input.requestKey);
  if (
    !Number.isSafeInteger(input.tradeId) ||
    input.tradeId < 1 ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 1 ||
    !["Owner", "Developer"].includes(actor.actorRole) ||
    !["none", "redistributed"].includes(input.sharedChargeDecision) ||
    !input.confirmGoodsNotReceived ||
    !input.confirmNoRealCashReversal ||
    !input.reason?.trim() ||
    input.reason.trim().length < 3 ||
    input.reason.length > 1000 ||
    !input.cancellationEvidence?.trim() ||
    input.cancellationEvidence.trim().length < 8 ||
    input.cancellationEvidence.length > 2000
  ) {
    rejectEdit(
      "An Owner/Developer must verify the unreceived goods, both cash records, original invoice treatment and cancellation evidence",
      "IC_CANCEL_INPUT",
      422
    );
  }
  const fingerprint = cancellationFingerprint(input);
  const trade = await assertTradeAccess(input.tradeId, actor);
  return withTradeScope(actor, [trade.sourceCompanyId, trade.destinationCompanyId], () =>
    db.transaction(async (tx) => {
      // Same source-company lock order as import, edits, shared invoices and Phase 4 cash.
      await tx.execute(
        sql.raw(
          "SELECT pg_advisory_xact_lock(" + INTERCOMPANY_PAYMENT_LOCK_NAMESPACE + "," + trade.sourceCompanyId + ")"
        )
      );
      const [fresh] = await tx
        .select()
        .from(intercompanyTrades)
        .where(eq(intercompanyTrades.id, input.tradeId))
        .for("update");
      if (!fresh) rejectEdit("Linked trade disappeared");
      const [oldCancel] = await tx
        .select()
        .from(intercompanyTradeCancellations)
        .where(eq(intercompanyTradeCancellations.tradeId, input.tradeId));
      if (oldCancel) {
        if (
          fresh.state !== "canceled" ||
          oldCancel.requestKey !== input.requestKey ||
          oldCancel.requestFingerprint !== fingerprint
        ) {
          rejectEdit("Already canceled with different evidence. No second reversal is permitted", "IC_CANCEL_REPLAY");
        }
        return {
          tradeId: input.tradeId,
          canceled: true,
          replayed: true,
          cancellationId: oldCancel.id,
          releasedCredit: oldCancel.releasedCredit,
        };
      }
      if (fresh.state !== "active" || fresh.version !== input.expectedVersion) {
        rejectEdit("Trade changed or is no longer active; refresh before cancellation", "IC_CANCEL_STALE");
      }
      const data = await loadTradeTx(tx, input.tradeId, false);
      requireUnreceived(data);
      const [received] = await tx
        .select({ id: intercompanyDestinationReceipts.id })
        .from(intercompanyDestinationReceipts)
        .where(eq(intercompanyDestinationReceipts.tradeId, fresh.id));
      if (received)
        rejectEdit(
          "ERP stock has already been received. Cancellation requires a separately approved inventory/COGS correction",
          "IC_CANCEL_RECEIVED"
        );

      // Original external supplier invoices must NOT be deleted or debited merely
      // because the internal sale was canceled. Confirmed shared charge invoice
      // face amounts are immutable. An authorized Shared Charge Editor must first
      // redistribute any share to other active containers using Phase 3's audited
      // shared invoice revision; a zero amount alone is not sufficient evidence.
      const shared = await tx
        .select()
        .from(intercompanySharedChargeAllocations)
        .where(eq(intercompanySharedChargeAllocations.tradeId, fresh.id));
      if (shared.some((row) => cents(row.amount).gt(0))) {
        rejectEdit(
          "Confirmed external shared charges must first be explicitly redistributed by a Shared Charge Editor",
          "IC_CANCEL_SHARED_CHARGE"
        );
      }
      if (shared.length) {
        if (input.sharedChargeDecision !== "redistributed") {
          rejectEdit(
            "Confirm the authorized shared-invoice redistribution before removing this container",
            "IC_CANCEL_SHARED_CHARGE"
          );
        }
        const invoices = await tx
          .select()
          .from(intercompanySharedChargeInvoices)
          .where(
            inArray(
              intercompanySharedChargeInvoices.id,
              shared.map((s) => s.invoiceId)
            )
          );
        if (invoices.length !== shared.length || invoices.some((inv) => inv.state !== "confirmed" || inv.version < 2)) {
          rejectEdit(
            "The shared invoice requires a completed audited redistribution, preserving its full face amount",
            "IC_CANCEL_SHARED_CHARGE"
          );
        }
      } else if (input.sharedChargeDecision !== "none") {
        rejectEdit("No shared external invoice applies to this container", "IC_CANCEL_SHARED_CHARGE", 422);
      }

      const amount = cents(data.imported.confirmedLandedCost ?? "0");
      if (!amount.gt(0)) rejectEdit("Original landed cost is not verified");
      // Return every confirmed PO allocation to exactly the original payment
      // row/pair. This changes NO bank or cash voucher.
      const events = await tx
        .select()
        .from(intercompanyPaymentAllocations)
        .where(eq(intercompanyPaymentAllocations.tradeId, fresh.id));
      const net = new Map<number, ReturnType<typeof cents>>();
      for (const entry of events) {
        net.set(entry.paymentId, (net.get(entry.paymentId) ?? new MoneyDecimal(0)).plus(entry.amount));
      }
      await tx.execute(sql.raw("SELECT set_config('erp.ic_phase5_cancel','" + fresh.id + "',true)"));
      let totalReleased = new MoneyDecimal(0);
      for (const [paymentId, money] of [...net].sort((a, b) => a[0] - b[0])) {
        if (money.lt(0)) rejectEdit("Original payment allocation has a negative balance", "IC_CANCEL_CREDIT");
        if (money.isZero()) continue;
        await tx.insert(intercompanyPaymentAllocations).values({
          paymentId,
          tradeId: fresh.id,
          amount: money.negated().toFixed(2),
          allocationKind: "cancel_release",
          requestKey: "ic-cancel-credit:" + fresh.id + ":" + paymentId,
          createdBy: actor.actorUserId,
          reason: "Canceled unreceived sale: return credit to ORIGINAL paired actual payment",
        });
        totalReleased = totalReleased.plus(money);
      }
      const money = amount.toFixed(2),
        reason = input.reason.trim();
      const netted = await isNettedIntercompanyTradeTx(tx, fresh.id);
      const sourceSale = await postErpVoucherTx(tx, {
        companyId: fresh.sourceCompanyId,
        voucherType: "Journal",
        voucherDate: input.postingDate,
        sourceModule: "INTERCOMPANY_CONTAINER",
        description: "Cancel at-cost intercompany sale, trade " + fresh.id,
        source: { type: "ic-phase5-cancel-sale", id: fresh.id },
        actor: { userId: actor.actorUserId, reason },
        lines: [
          {
            ledgerAccountId: data.policy.sourceSalesAccountId!,
            debit: money,
            narration: "Reverse internal at-cost sale",
          },
          {
            ledgerAccountId: data.policy.sourceReceivableAccountId!,
            credit: money,
            narration: "Release Properties internal receivable",
          },
        ],
      });
      const sourceCost = await postErpVoucherTx(tx, {
        companyId: fresh.sourceCompanyId,
        voucherType: "Journal",
        voucherDate: input.postingDate,
        sourceModule: "INTERCOMPANY_CONTAINER",
        description: "Return original external goods to Properties purchases, trade " + fresh.id,
        source: { type: "ic-phase5-cancel-cost", id: fresh.id },
        actor: { userId: actor.actorUserId, reason },
        lines: [
          {
            ledgerAccountId: data.policy.sourcePurchaseAccountId!,
            debit: money,
            narration: "Original external supplier purchase remains",
          },
          {
            ledgerAccountId: data.policy.sourceCostAccountId!,
            credit: money,
            narration: "Reverse unsold internal cost recognition",
          },
        ],
      });
      // Phase 5's immutable cancellation guard expects exactly two legs in
      // each original reversal voucher. Preserve that evidence and use a
      // distinct, idempotent technical journal to undo at-cost elimination.
      const nettingCancellation = netted
        ? await postErpVoucherTx(tx, {
            companyId: fresh.sourceCompanyId,
            voucherType: "Journal",
            voucherDate: input.postingDate,
            sourceModule: "INTERCOMPANY_CONTAINER",
            description: "Restore internal source classification after cancellation, trade " + fresh.id,
            source: { type: "ic-phase5-cancel-netting", id: fresh.id },
            actor: { userId: actor.actorUserId, reason },
            lines: [
              { ledgerAccountId: data.policy.sourceCostAccountId!, debit: money,
                narration: "Undo technical COGS elimination" },
              { ledgerAccountId: data.policy.sourceSalesAccountId!, credit: money,
                narration: "Undo technical internal sales elimination" },
            ],
          })
        : null;
      const destination = await postErpVoucherTx(tx, {
        companyId: fresh.destinationCompanyId,
        voucherType: "Journal",
        voucherDate: input.postingDate,
        sourceModule: "INTERCOMPANY_CONTAINER",
        description: "Reverse unreceived intercompany GIT/supplier liability, trade " + fresh.id,
        source: { type: "ic-phase5-cancel-destination", id: fresh.id },
        actor: { userId: actor.actorUserId, reason },
        lines: [
          {
            supplierId: data.policy.destinationSupplierId!,
            debit: money,
            narration: "Reverse payable to Hassan Properties",
          },
          {
            ledgerAccountId: data.policy.destinationGitAccountId!,
            credit: money,
            narration: "Reverse unreceived goods in transit",
          },
        ],
      });
      const [cancellation] = await tx
        .insert(intercompanyTradeCancellations)
        .values({
          tradeId: fresh.id,
          relationshipId: fresh.relationshipId,
          sourceCompanyId: fresh.sourceCompanyId,
          destinationCompanyId: fresh.destinationCompanyId,
          requestKey: input.requestKey,
          requestFingerprint: fingerprint,
          expectedVersion: fresh.version,
          postingDate: input.postingDate,
          landedCost: money,
          sourceSaleReversalVoucherId: sourceSale.voucher.id,
          sourceCostReversalVoucherId: sourceCost.voucher.id,
          destinationGitReversalVoucherId: destination.voucher.id,
          reason,
          cancellationEvidence: input.cancellationEvidence.trim(),
          releasedCredit: totalReleased.toFixed(2),
          actorUserId: actor.actorUserId,
        })
        .returning();

      const [updated] = await tx
        .update(intercompanyTrades)
        .set({
          state: "canceled",
          canceledAt: new Date(),
          version: fresh.version + 1,
        })
        .where(and(eq(intercompanyTrades.id, fresh.id), eq(intercompanyTrades.version, fresh.version)))
        .returning();
      if (!updated) rejectEdit("A simultaneous trade update invalidated the cancellation");
      await tx.execute(sql.raw("SELECT set_config('erp.ic_phase5_cancel','',true)"));
      await tx.insert(intercompanyAuditEvents).values({
        eventKey: "ic-phase5-cancellation:" + cancellation.id,
        relationshipId: fresh.relationshipId,
        sourceCompanyId: fresh.sourceCompanyId,
        actorUserId: actor.actorUserId,
        eventType: "intercompany-unreceived-trade-canceled",
        sourceReference: "trade:" + fresh.id,
        payload: {
          cancellationId: cancellation.id,
          originalExternalSupplierPosPreserved: data.source.map((s) => s.po.id),
          physicalContainerId: fresh.physicalContainerId,
          noCashVoucherPosted: true,
          sharedChargeDecision: input.sharedChargeDecision,
          releasedOriginalPairCredit: totalReleased.toFixed(2),
          sourceSaleVoucherId: sourceSale.voucher.id,
          sourceCostVoucherId: sourceCost.voucher.id,
          technicalNettingCancellationVoucherId: nettingCancellation?.voucher.id ?? null,
          destinationVoucherId: destination.voucher.id,
          evidence: input.cancellationEvidence.trim(),
        },
      });
      return {
        tradeId: fresh.id,
        canceled: true,
        replayed: false,
        cancellationId: cancellation.id,
        releasedCredit: totalReleased.toFixed(2),
      };
    })
  );
}
