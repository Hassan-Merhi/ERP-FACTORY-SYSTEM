/** Confirmed HP-borne shared invoices: exact proportional allocation and controlled revisions. */
import { and, eq, inArray } from "drizzle-orm";
import {
  containerCharges,
  containers,
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
} from "./tradeSync";
import { cents, fullPoCost } from "./tradeRevisionMath";
import { releaseEditOverallocationTx } from "./paymentAllocationCore";
import {
  createTenantDatabaseScope,
  getDatabaseScopeRuntimeContext,
  runWithDatabaseScopeRuntimeContext,
} from "../security/databaseScopeRuntimeContext";
import {
  getCompanyRequestRuntimeContext,
  runWithCompanyRequestRuntimeContext,
} from "../security/companyRequestRuntimeContext";
import {
  CODES,
  hasSharedChargeGrant,
  lockSource,
  poSplit,
  requireInputs,
  validateAllocations,
  type ChargeField,
  type SharedChargeEntry,
} from "./previewSharedChargeAllocation";
export { previewSharedChargeAllocation } from "./previewSharedChargeAllocation";
export type { ConfirmSharedChargeInput, SharedChargeEntry } from "./previewSharedChargeAllocation";
export { confirmSharedCharge } from "./confirmSharedCharge";
export type ReviseSharedChargeInput = {
  invoiceId: number;
  expectedInvoiceVersion: number;
  postingDate: string;
  requestKey: string;
  reason: string;
  allocations: SharedChargeEntry[];
};
/** Only invoked AFTER explicit related-invoice permission verification. */
async function withGrantedInvoiceScope<T>(
  identity: EditIdentity,
  companies: readonly number[],
  work: () => Promise<T>
) {
  const ctx = getCompanyRequestRuntimeContext(),
    dbScope = getDatabaseScopeRuntimeContext();
  if (
    (ctx && ctx.companyId !== identity.initiatingCompanyId) ||
    (dbScope?.kind === "tenant" && dbScope.companyId !== identity.initiatingCompanyId)
  ) {
    rejectEdit("Session company changed during invoice revision", "IC_CHARGE_SCOPE", 403);
  }
  const ids = [...new Set([identity.initiatingCompanyId, ...companies])];
  const run = () =>
    runWithDatabaseScopeRuntimeContext(
      createTenantDatabaseScope(identity.initiatingCompanyId, ids, "authorized-companies"),
      work
    );
  return ctx
    ? runWithCompanyRequestRuntimeContext(
        { ...ctx, authorizedCompanyIds: [...new Set([...(ctx.authorizedCompanyIds ?? []), ...ids])] },
        run
      )
    : run();
}
/** Returns only this invoiced set of linked containers; unrelated finances are never exposed. */
export async function sharedInvoiceDetail(invoiceId: number, identity: EditIdentity) {
  if (!Number.isSafeInteger(invoiceId) || invoiceId < 1) rejectEdit("Invalid shared invoice", "IC_CHARGE_INPUT", 422);
  const [invoice] = await db
    .select()
    .from(intercompanySharedChargeInvoices)
    .where(eq(intercompanySharedChargeInvoices.id, invoiceId));
  if (!invoice || invoice.state !== "confirmed") rejectEdit("Shared invoice not found", "IC_CHARGE_NOT_FOUND", 404);
  const entries = await db
    .select()
    .from(intercompanySharedChargeAllocations)
    .where(eq(intercompanySharedChargeAllocations.invoiceId, invoiceId));
  const trades = await db
    .select()
    .from(intercompanyTrades)
    .where(
      inArray(
        intercompanyTrades.id,
        entries.map((e) => e.tradeId)
      )
    );
  const relations = trades.map((t) => t.relationshipId);
  if (
    !trades.some((t) => [t.sourceCompanyId, t.destinationCompanyId].includes(identity.initiatingCompanyId)) ||
    !(await hasSharedChargeGrant(identity, invoice.externalInvoiceKey, relations, invoice.sourceCompanyId))
  ) {
    rejectEdit("Shared invoice requires a dedicated editor grant", "IC_CHARGE_FORBIDDEN", 403);
  }
  return withGrantedInvoiceScope(
    identity,
    trades.flatMap((t) => [t.sourceCompanyId, t.destinationCompanyId]),
    async () => {
      const physical = await db
        .select({ id: containers.id, containerNumber: containers.containerNumber })
        .from(containers)
        .where(
          inArray(
            containers.id,
            trades.map((t) => t.physicalContainerId)
          )
        );
      return {
        invoiceId: invoice.id,
        externalInvoiceKey: invoice.externalInvoiceKey,
        chargeType: invoice.chargeType,
        faceAmount: invoice.faceAmount,
        evidenceReference: invoice.evidenceReference,
        version: invoice.version,
        allocations: entries.map((e) => {
          const trade = trades.find((t) => t.id === e.tradeId)!;
          return {
            tradeId: e.tradeId,
            amount: e.amount,
            expectedVersion: trade.version,
            relationshipId: trade.relationshipId,
            containerNumber: physical.find((p) => p.id === trade.physicalContainerId)?.containerNumber ?? "Unknown",
            sourceCompanyId: trade.sourceCompanyId,
            destinationCompanyId: trade.destinationCompanyId,
          };
        }),
      };
    }
  );
}
export async function reviseSharedCharge(input: ReviseSharedChargeInput, identity: EditIdentity) {
  requireInputs(input);
  const [invoice] = await db
    .select()
    .from(intercompanySharedChargeInvoices)
    .where(eq(intercompanySharedChargeInvoices.id, input.invoiceId));
  if (!invoice || invoice.state !== "confirmed")
    rejectEdit("Confirmed invoice is unavailable", "IC_CHARGE_NOT_FOUND", 404);
  const current = await db
    .select()
    .from(intercompanySharedChargeAllocations)
    .where(eq(intercompanySharedChargeAllocations.invoiceId, invoice.id));
  const trades = await db
    .select()
    .from(intercompanyTrades)
    .where(
      inArray(
        intercompanyTrades.id,
        current.map((e) => e.tradeId)
      )
    );
  const relationIds = trades.map((t) => t.relationshipId);
  if (
    !trades.some((t) => [t.sourceCompanyId, t.destinationCompanyId].includes(identity.initiatingCompanyId)) ||
    !(await hasSharedChargeGrant(identity, invoice.externalInvoiceKey, relationIds, invoice.sourceCompanyId))
  ) {
    rejectEdit("No dedicated shared-charge editing permission for this invoice", "IC_CHARGE_FORBIDDEN", 403);
  }
  validateAllocations(input.allocations, cents(invoice.faceAmount));
  if (
    input.allocations.length !== current.length ||
    new Set(input.allocations.map((e) => e.tradeId)).size !== current.length ||
    input.allocations.some((e) => !current.some((old) => old.tradeId === e.tradeId))
  ) {
    rejectEdit(
      "Adding or removing confirmed invoice containers needs a separate authorized reassignment",
      "IC_CHARGE_PARTICIPANTS",
      409
    );
  }
  return withGrantedInvoiceScope(
    identity,
    trades.flatMap((t) => [t.sourceCompanyId, t.destinationCompanyId]),
    () =>
      db.transaction(async (tx) => {
        await lockSource(tx, invoice.sourceCompanyId);
        const [latest] = await tx
          .select()
          .from(intercompanySharedChargeInvoices)
          .where(eq(intercompanySharedChargeInvoices.id, invoice.id))
          .for("update");
        if (!latest || latest.version !== input.expectedInvoiceVersion)
          rejectEdit("Invoice was reallocated; refresh before editing", "IC_CHARGE_STALE");
        const sorted = [...input.allocations].sort((a, b) => a.tradeId - b.tradeId);
        const result = [];
        for (const item of sorted) {
          const snap = await loadTradeTx(tx, item.tradeId);
          requireUnreceived(snap);
          if (snap.trade.version !== item.expectedVersion)
            rejectEdit("Linked PO changed; reload invoice allocations", "IC_CHARGE_STALE");
          const existing = current.find((a) => a.tradeId === item.tradeId)!;
          const next = cents(item.amount),
            old = cents(existing.amount);
          if (old.eq(next)) continue;
          const [record] = await tx
            .select()
            .from(intercompanySharedChargeAllocations)
            .where(eq(intercompanySharedChargeAllocations.id, existing.id))
            .for("update");
          if (!record || !cents(record.amount).eq(old)) rejectEdit("Invoice allocation changed", "IC_CHARGE_STALE");
          const savedPos = await tx
            .select()
            .from(intercompanySharedChargePoAllocations)
            .where(
              and(
                eq(intercompanySharedChargePoAllocations.invoiceId, invoice.id),
                eq(intercompanySharedChargePoAllocations.tradeId, item.tradeId)
              )
            );
          const allocated = poSplit(snap, next);
          if (savedPos.length !== allocated.length) rejectEdit("Existing invoice PO allocations are incomplete");
          const delta = next.minus(old);
          const revision = await beginRevisionTx(tx, snap, {
            expectedVersion: item.expectedVersion,
            requestKey:
              "ic-charge:" + invoice.id + ":" + snap.trade.id + ":" + validateRequestKey(input.requestKey).slice(0, 64),
            kind: "shared_invoice_reallocate",
            actorUserId: identity.actorUserId,
            initiatingCompanyId: identity.initiatingCompanyId,
            postingDate: input.postingDate,
            amountAfter: fullPoCost(snap.destination.po).plus(delta).toFixed(2),
            reason: input.reason,
            evidence: { invoiceId: invoice.id, from: old.toFixed(2), to: next.toFixed(2) },
          });
          if (record.containerChargeId) {
            await tx
              .update(containerCharges)
              .set({ amount: next.toFixed(2) })
              .where(eq(containerCharges.id, record.containerChargeId));
          } else {
            const [newCharge] = await tx
              .insert(containerCharges)
              .values({
                containerId: snap.physical.id,
                chargeType: CODES[invoice.chargeType as ChargeField],
                amount: next.toFixed(2),
              })
              .returning();
            await tx
              .update(intercompanySharedChargeAllocations)
              .set({ containerChargeId: newCharge.id })
              .where(eq(intercompanySharedChargeAllocations.id, existing.id));
          }
          await tx
            .update(intercompanySharedChargeAllocations)
            .set({ amount: next.toFixed(2) })
            .where(eq(intercompanySharedChargeAllocations.id, existing.id));
          const byPo = new Map(savedPos.map((p) => [p.sourcePoId, p]));
          const poDeltas = allocated.map((p) => {
            const previous = byPo.get(p.poId);
            if (!previous) rejectEdit("Missing original source PO invoice allocation");
            const change = p.amount.minus(cents(previous.amount));
            return {
              poId: p.poId,
              goods: new MoneyDecimal(0),
              charge: change,
              chargeField: invoice.chargeType as ChargeField,
            };
          });
          // The source PO allocation updates must be awaited before deferred total checks.
          for (const p of allocated) {
            const previous = byPo.get(p.poId)!;
            await tx
              .update(intercompanySharedChargePoAllocations)
              .set({ amount: p.amount.toFixed(2) })
              .where(eq(intercompanySharedChargePoAllocations.id, previous.id));
          }
          const applied = await applyCostDeltasTx(tx, snap, {
            revisionId: revision.id,
            postingDate: input.postingDate,
            actorUserId: identity.actorUserId,
            reason: input.reason,
            poDeltas,
          });
          const releasedCredit = await releaseEditOverallocationTx(tx, {
            tradeId: snap.trade.id,
            newLandedCost: applied.amountAfter,
            actorUserId: identity.actorUserId,
            revisionId: revision.id,
          });
          const version = await completeRevisionTx(
            tx,
            snap,
            revision.id,
            applied.amountAfter,
            applied.vouchers,
            identity,
            "shared_invoice_reallocate",
            { invoiceId: invoice.id, from: old.toFixed(2), to: next.toFixed(2), releasedCredit }
          );
          result.push({ tradeId: item.tradeId, amount: next.toFixed(2), version });
        }
        if (!result.length) rejectEdit("No allocation changed", "IC_CHARGE_NO_CHANGE", 422);
        await tx
          .update(intercompanySharedChargeInvoices)
          .set({ version: invoice.version + 1 })
          .where(eq(intercompanySharedChargeInvoices.id, invoice.id));
        await tx.insert(intercompanyAuditEvents).values({
          eventKey: "ic-shared-invoice:" + invoice.id + ":" + (invoice.version + 1),
          sourceCompanyId: invoice.sourceCompanyId,
          actorUserId: identity.actorUserId,
          eventType: "shared-charge-allocation-revised",
          sourceReference: invoice.externalInvoiceKey,
          payload: {
            invoiceId: invoice.id,
            faceAmount: invoice.faceAmount,
            originalInvoicePreserved: true,
            changed: result,
          },
        });
        return { invoiceId: invoice.id, version: invoice.version + 1, faceAmount: invoice.faceAmount, changed: result };
      })
  );
}
