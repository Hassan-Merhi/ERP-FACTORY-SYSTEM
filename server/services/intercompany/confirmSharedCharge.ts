// Extracted from ./sharedChargeSync.ts to keep that module under the source-size cap.
import { and, eq, inArray } from "drizzle-orm";
import {
  containerCharges,
  intercompanyAuditEvents,
  intercompanySharedChargeAllocations,
  intercompanySharedChargeInvoices,
  intercompanySharedChargePoAllocations,
  intercompanyTrades,
} from "@shared/schema";
import { db } from "../../db";
import { MoneyDecimal } from "../../lib/money";
import {
  applyCostDeltasTx,
  beginRevisionTx,
  completeRevisionTx,
  type EditIdentity,
  loadTradeTx,
  rejectEdit,
  requireUnreceived,
  validateRequestKey,
  withTradeScope,
} from "./tradeSync";
import { fullPoCost } from "./tradeRevisionMath";
import {
  CODES,
  assertInvoiceInput,
  lockSource,
  poSplit,
  validateAllocations,
  type ConfirmSharedChargeInput,
} from "./previewSharedChargeAllocation";

export async function confirmSharedCharge(input: ConfirmSharedChargeInput, identity: EditIdentity) {
  const face = assertInvoiceInput(input);
  const amounts = validateAllocations(input.allocations, face);
  if (input.sourceCompanyId !== identity.initiatingCompanyId || !["Owner", "Developer"].includes(identity.actorRole)) {
    rejectEdit(
      "Only the Properties Owner/Developer can confirm a new external shared invoice",
      "IC_CHARGE_FORBIDDEN",
      403
    );
  }
  const trades = await db
    .select()
    .from(intercompanyTrades)
    .where(
      inArray(
        intercompanyTrades.id,
        input.allocations.map((a) => a.tradeId)
      )
    );
  if (
    trades.length !== input.allocations.length ||
    trades.some((t) => t.sourceCompanyId !== input.sourceCompanyId || t.state !== "active")
  ) {
    rejectEdit("Invoice must contain distinct active containers of one Properties company");
  }
  return withTradeScope(
    identity,
    trades.map((t) => t.destinationCompanyId),
    () =>
      db.transaction(async (tx) => {
        await lockSource(tx, input.sourceCompanyId);
        const [same] = await tx
          .select()
          .from(intercompanySharedChargeInvoices)
          .where(
            and(
              eq(intercompanySharedChargeInvoices.sourceCompanyId, input.sourceCompanyId),
              eq(intercompanySharedChargeInvoices.externalInvoiceKey, input.invoiceKey)
            )
          );
        if (same) rejectEdit("That external shared invoice has already been entered", "IC_CHARGE_DUPLICATE");
        const data = [];
        for (const entry of input.allocations) {
          const snap = await loadTradeTx(tx, entry.tradeId);
          requireUnreceived(snap);
          if (snap.trade.version !== entry.expectedVersion) {
            rejectEdit("The container price changed; refresh the invoice allocation", "IC_CHARGE_STALE_VERSION");
          }
          data.push(snap);
        }
        const [invoice] = await tx
          .insert(intercompanySharedChargeInvoices)
          .values({
            sourceCompanyId: input.sourceCompanyId,
            externalInvoiceKey: input.invoiceKey,
            chargeType: input.chargeType,
            faceAmount: face.toFixed(2),
            evidenceReference: input.evidenceReference.trim(),
            currency: "USD",
            createdBy: identity.actorUserId,
            state: "draft",
          })
          .returning();
        const result = [];
        for (const [index, snap] of data.entries()) {
          const amount = amounts[index];
          const pos = poSplit(snap, amount);
          const before = fullPoCost(snap.destination.po);
          const revision = await beginRevisionTx(tx, snap, {
            expectedVersion: snap.trade.version,
            requestKey:
              "ic-charge:" + invoice.id + ":" + snap.trade.id + ":" + validateRequestKey(input.requestKey).slice(0, 64),
            kind: "shared_invoice_confirm",
            actorUserId: identity.actorUserId,
            initiatingCompanyId: identity.initiatingCompanyId,
            postingDate: input.postingDate,
            amountAfter: before.plus(amount).toFixed(2),
            reason: input.reason,
            evidence: {
              externalInvoiceKey: input.invoiceKey,
              invoiceId: invoice.id,
              allocatedAmount: amount.toFixed(2),
            },
          });
          const [charge] = await tx
            .insert(containerCharges)
            .values({
              containerId: snap.physical.id,
              chargeType: CODES[input.chargeType],
              amount: amount.toFixed(2),
            })
            .returning();
          await tx.insert(intercompanySharedChargeAllocations).values({
            invoiceId: invoice.id,
            tradeId: snap.trade.id,
            amount: amount.toFixed(2),
            containerChargeId: charge.id,
          });
          await tx.insert(intercompanySharedChargePoAllocations).values(
            pos.map((p) => ({
              invoiceId: invoice.id,
              tradeId: snap.trade.id,
              sourcePoId: p.poId,
              amount: p.amount.toFixed(2),
            }))
          );
          const applied = await applyCostDeltasTx(tx, snap, {
            revisionId: revision.id,
            postingDate: input.postingDate,
            actorUserId: identity.actorUserId,
            reason: input.reason,
            poDeltas: pos.map((p) => ({
              poId: p.poId,
              goods: new MoneyDecimal(0),
              charge: p.amount,
              chargeField: input.chargeType,
            })),
          });
          const version = await completeRevisionTx(
            tx,
            snap,
            revision.id,
            applied.amountAfter,
            applied.vouchers,
            identity,
            "shared_invoice_confirm",
            { invoiceId: invoice.id, amount: amount.toFixed(2), invoiceReference: input.invoiceKey }
          );
          result.push({ tradeId: snap.trade.id, version, amount: amount.toFixed(2), landedCost: applied.amountAfter });
        }
        await tx
          .update(intercompanySharedChargeInvoices)
          .set({ state: "confirmed", confirmedAt: new Date() })
          .where(eq(intercompanySharedChargeInvoices.id, invoice.id));
        await tx.insert(intercompanyAuditEvents).values({
          eventKey: "ic-shared-invoice:" + invoice.id + ":1",
          sourceCompanyId: input.sourceCompanyId,
          actorUserId: identity.actorUserId,
          eventType: "shared-invoice-confirmed",
          sourceReference: input.invoiceKey,
          payload: {
            invoiceId: invoice.id,
            faceAmount: face.toFixed(2),
            chargeType: input.chargeType,
            allocations: result,
          },
        });
        return {
          invoiceId: invoice.id,
          version: 1,
          externalInvoiceKey: input.invoiceKey,
          faceAmount: face.toFixed(2),
          allocations: result,
        };
      })
  );
}
