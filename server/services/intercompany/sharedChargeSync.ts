import type Decimal from "decimal.js";
/** Confirmed HP-borne shared invoices: exact proportional allocation and controlled revisions. */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  containerCharges,
  containers,
  intercompanyAuditEvents,
  intercompanyPermissionGrants,
  intercompanySharedChargeAllocations,
  intercompanySharedChargeInvoices,
  intercompanySharedChargePoAllocations,
  intercompanyTrades,
  userCompanyRoles,
} from "@shared/schema";
import { db, type DbTransaction } from "../../db";
import { MoneyDecimal, sumMoney } from "../../lib/money";
import {
  applyCostDeltasTx,
  beginRevisionTx,
  completeRevisionTx,
  type EditIdentity,
  loadTradeTx,
  postingDay,
  rejectEdit,
  requireUnreceived,
  validateRequestKey,
  withTradeScope,
} from "./tradeSync";
import { allocateByWeights, cents, fullPoCost } from "./tradeRevisionMath";
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

type ChargeField = "freight" | "surcharge" | "fumigation" | "documentCharges" | "otherCharges";
const FIELDS = new Set<ChargeField>(["freight", "surcharge", "fumigation", "documentCharges", "otherCharges"]);
const CODES: Record<ChargeField, string> = {
  freight: "Freight",
  surcharge: "Surcharge",
  fumigation: "Fumigation",
  documentCharges: "Document Charges",
  otherCharges: "Other Charges",
};
const IMPORT_LOCK = 741235;

export type SharedChargeEntry = { tradeId: number; expectedVersion: number; amount: string };
export type ConfirmSharedChargeInput = {
  sourceCompanyId: number;
  invoiceKey: string;
  chargeType: ChargeField;
  faceAmount: string;
  evidenceReference: string;
  postingDate: string;
  requestKey: string;
  reason: string;
  allocations: SharedChargeEntry[];
};
export type ReviseSharedChargeInput = {
  invoiceId: number;
  expectedInvoiceVersion: number;
  postingDate: string;
  requestKey: string;
  reason: string;
  allocations: SharedChargeEntry[];
};

function requireInputs(input: { postingDate: string; requestKey: string; reason: string }) {
  postingDay(input.postingDate);
  validateRequestKey(input.requestKey);
  if (typeof input.reason !== "string" || input.reason.trim().length < 3 || input.reason.length > 1000) {
    rejectEdit("Enter a meaningful invoice allocation reason", "IC_CHARGE_REASON", 422);
  }
}
function validateAllocations(allocations: SharedChargeEntry[], face: Decimal) {
  if (!Array.isArray(allocations) || !allocations.length || allocations.length > 100) {
    rejectEdit("Select one to one hundred eligible containers", "IC_CHARGE_ALLOCATION", 422);
  }
  if (new Set(allocations.map((x) => x.tradeId)).size !== allocations.length) {
    rejectEdit("Each container must appear only once on the invoice", "IC_CHARGE_DUPLICATE", 422);
  }
  const values = allocations.map((x) => {
    if (
      !Number.isSafeInteger(x.tradeId) ||
      x.tradeId <= 0 ||
      !Number.isSafeInteger(x.expectedVersion) ||
      x.expectedVersion <= 0 ||
      typeof x.amount !== "string" ||
      !/^\d+(\.\d{1,2})?$/.test(x.amount)
    ) {
      rejectEdit(
        "Container allocation requires a positive trade ID, version and cent-exact amount",
        "IC_CHARGE_ALLOCATION",
        422
      );
    }
    const value = cents(x.amount);
    if (value.lt(0)) rejectEdit("Shared charge allocation cannot be negative");
    return value;
  });
  if (!sumMoney(values).eq(face)) {
    rejectEdit(
      "Shared allocation total must equal the unchanged external invoice face amount",
      "IC_CHARGE_TOTAL_MISMATCH",
      422
    );
  }
  return values;
}
function assertInvoiceInput(input: ConfirmSharedChargeInput) {
  requireInputs(input);
  if (
    !Number.isSafeInteger(input.sourceCompanyId) ||
    input.sourceCompanyId <= 0 ||
    !/^[A-Za-z0-9._\/:-]{3,120}$/.test(input.invoiceKey) ||
    !FIELDS.has(input.chargeType) ||
    !input.evidenceReference?.trim() ||
    input.evidenceReference.trim().length < 3 ||
    input.evidenceReference.length > 500 ||
    typeof input.faceAmount !== "string" ||
    !/^\d+(\.\d{1,2})?$/.test(input.faceAmount)
  ) {
    rejectEdit("Invalid original supplier invoice reference, type, evidence or USD amount", "IC_CHARGE_INVALID", 422);
  }
  const face = cents(input.faceAmount);
  if (!face.gt(0)) rejectEdit("External shared invoice amount must be positive", "IC_CHARGE_INVALID", 422);
  return face;
}
/** A specific grant makes ordinary users eligible. Admin is not a default charge editor. */
async function hasSharedChargeGrant(
  identity: EditIdentity,
  invoiceKey: string,
  relations: readonly number[],
  scopeSourceId: number
) {
  if (identity.initiatingCompanyId === scopeSourceId && ["Owner", "Developer"].includes(identity.actorRole))
    return true;
  const [member] = await db
    .select()
    .from(userCompanyRoles)
    .where(
      and(
        eq(userCompanyRoles.userId, identity.actorUserId),
        eq(userCompanyRoles.companyId, identity.initiatingCompanyId)
      )
    );
  if (!member && identity.actorRole !== "Developer") return false;
  const grants = await db
    .select()
    .from(intercompanyPermissionGrants)
    .where(
      and(
        eq(intercompanyPermissionGrants.userId, identity.actorUserId),
        eq(intercompanyPermissionGrants.grantingCompanyId, identity.initiatingCompanyId),
        eq(intercompanyPermissionGrants.permission, "shared_charge_editor"),
        isNull(intercompanyPermissionGrants.revokedAt),
        inArray(intercompanyPermissionGrants.relationshipId, [...relations])
      )
    );
  const invoiceGrant = grants.some((g) => g.scope === "invoice" && g.invoiceKey === invoiceKey);
  const relationshipCoverage = relations.every((id) =>
    grants.some((g) => g.scope === "relationship" && g.relationshipId === id)
  );
  return invoiceGrant || relationshipCoverage;
}
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
async function lockSource(tx: DbTransaction, sourceCompanyId: number) {
  await tx.execute(sql.raw("SELECT pg_advisory_xact_lock(" + IMPORT_LOCK + "," + sourceCompanyId + ")"));
}
function poSplit(data: Awaited<ReturnType<typeof loadTradeTx>>, amount: Decimal) {
  const groups = data.source;
  const weights = groups.map((g) => cents(g.po.itemsTotal ?? "0"));
  return allocateByWeights(amount, weights).map((share, i) => ({ poId: groups[i].po.id, amount: share }));
}

/** Suggested allocation is purchase-value weighted, but is NEVER confirmed without user approval. */
export async function previewSharedChargeAllocation(
  input: {
    sourceCompanyId: number;
    tradeIds: number[];
    amount: string;
  },
  identity: EditIdentity
) {
  if (input.sourceCompanyId !== identity.initiatingCompanyId || !["Owner", "Developer"].includes(identity.actorRole)) {
    rejectEdit("Only the Properties Owner/Developer can create a shared invoice", "IC_CHARGE_FORBIDDEN", 403);
  }
  if (
    !Array.isArray(input.tradeIds) ||
    !input.tradeIds.length ||
    input.tradeIds.length > 100 ||
    new Set(input.tradeIds).size !== input.tradeIds.length ||
    !/^\d+(\.\d{1,2})?$/.test(input.amount)
  ) {
    rejectEdit("Select unique trade IDs and a cent-exact confirmed amount", "IC_CHARGE_INPUT", 422);
  }
  const face = cents(input.amount);
  if (!face.gt(0)) rejectEdit("Shared invoice amount must be positive");
  const tradeRows = await db.select().from(intercompanyTrades).where(inArray(intercompanyTrades.id, input.tradeIds));
  if (
    tradeRows.length !== input.tradeIds.length ||
    tradeRows.some((trade) => trade.sourceCompanyId !== input.sourceCompanyId || trade.state !== "active")
  ) {
    rejectEdit("All shared invoice containers must be active and belong to one Properties source");
  }
  return withTradeScope(
    identity,
    tradeRows.map((trade) => trade.destinationCompanyId),
    async () => {
      return db.transaction(async (tx) => {
        const records = [];
        for (const id of input.tradeIds) {
          const data = await loadTradeTx(tx, id, false);
          requireUnreceived(data);
          records.push({
            tradeId: id,
            version: data.trade.version,
            containerNumber: data.physical.containerNumber,
            weight: cents(data.physical.itemsTotal ?? "0"),
          });
        }
        const proposed = allocateByWeights(
          face,
          records.map((r) => r.weight)
        );
        return {
          faceAmount: face.toFixed(2),
          allocations: records.map((r, i) => ({
            tradeId: r.tradeId,
            containerNumber: r.containerNumber,
            expectedVersion: r.version,
            suggestedAmount: proposed[i].toFixed(2),
          })),
        };
      });
    }
  );
}
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
