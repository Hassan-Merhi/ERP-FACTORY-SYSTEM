import type Decimal from "decimal.js";
/** Phase 3: atomically mirror source/destination PO pricing, and append adjustment journals. */
import { and, eq, sql } from "drizzle-orm";
import { intercompanyAuditEvents, intercompanyTradeRevisions, intercompanyTrades, poLineItems } from "@shared/schema";
import { db, type DbTransaction } from "../../db";
import { MoneyDecimal, sumMoney } from "../../lib/money";
import { cents, fullPoCost, lineTotal } from "./tradeRevisionMath";
import { releaseEditOverallocationTx } from "./paymentAllocationCore";
import {
  IMPORT_LOCK,
  loadTradeTx,
  postingDay,
  rejectEdit,
  requireMembership,
  validateRequestKey,
  withTradeScope,
  type EditIdentity,
  type LinkedTradeEditInput,
  type Trade,
  type TradeData,
} from "./tradeSyncLoadTradeTx";
import { applyCostDeltasTx } from "./tradeSyncApplyCostDeltasTx";
export {
  IntercompanyEditError,
  isNettedIntercompanyTradeTx,
  loadTradeTx,
  postingDay,
  rejectEdit,
  validateRequestKey,
  withTradeScope,
} from "./tradeSyncLoadTradeTx";
export type { EditIdentity, LinkedLineEdit, LinkedTradeEditInput, TradeData } from "./tradeSyncLoadTradeTx";
export { applyCostDeltasTx } from "./tradeSyncApplyCostDeltasTx";
export async function assertTradeAccess(tradeId: number, identity: EditIdentity): Promise<Trade> {
  await requireMembership(identity);
  if (!Number.isSafeInteger(tradeId) || tradeId <= 0) rejectEdit("Invalid trade ID", "IC_EDIT_ID", 422);
  const [trade] = await db.select().from(intercompanyTrades).where(eq(intercompanyTrades.id, tradeId));
  if (!trade || ![trade.sourceCompanyId, trade.destinationCompanyId].includes(identity.initiatingCompanyId)) {
    rejectEdit("No linked trade belongs to this company", "IC_EDIT_NOT_FOUND", 404);
  }
  return trade;
}
export function requireUnreceived(data: TradeData) {
  if (
    data.received != null ||
    data.physical.status !== "OTW" ||
    data.physical.offloadDate != null ||
    data.destination.po.status !== "Open" ||
    data.source.some((g) => g.po.status !== "Open")
  ) {
    rejectEdit(
      "Offloaded, sold or reserved inventory needs the later inventory/COGS-safe workflow",
      "IC_EDIT_INVENTORY_DEPENDENCY"
    );
  }
  if (
    [
      data.policy.sourcePurchaseAccountId,
      data.policy.sourceSalesAccountId,
      data.policy.sourceCostAccountId,
      data.policy.sourceReceivableAccountId,
      data.policy.sourceChargeAccrualAccountId,
      data.policy.destinationGitAccountId,
      data.policy.destinationSupplierId,
    ].some((id) => !id)
  ) {
    rejectEdit("Verified accounts or partner supplier are missing");
  }
}
export async function getTradeDetail(tradeId: number, identity: EditIdentity) {
  const trade = await assertTradeAccess(tradeId, identity);
  return withTradeScope(identity, [trade.sourceCompanyId, trade.destinationCompanyId], () =>
    db.transaction(async (tx) => {
      const data = await loadTradeTx(tx, tradeId, false);
      const source = new Map(data.source.flatMap((g) => g.lines.map((l) => [l.id, { po: g.po, line: l }] as const)));
      const dest = new Map(data.destination.lines.map((l) => [l.id, l] as const));
      return {
        tradeId,
        version: data.trade.version,
        containerNumber: data.physical.containerNumber,
        sourceCompanyId: data.trade.sourceCompanyId,
        destinationCompanyId: data.trade.destinationCompanyId,
        physicalStatus: data.physical.status,
        destinationReceivedAt: data.received?.postingDate ?? null,
        destinationReceiptVoucherId: data.received?.receiptVoucherId ?? null,
        landedCost: cents(data.physical.grandTotal ?? "0").toFixed(2),
        goodsCost: cents(data.physical.itemsTotal ?? "0").toFixed(2),
        sourcePos: data.source.map((g) => ({ poId: g.po.id, poNumber: g.po.poNumber, itemsTotal: g.po.itemsTotal })),
        destinationPoId: data.destination.po.id,
        lines: data.links.map((l) => {
          const s = source.get(l.sourceLineId)!,
            d = dest.get(l.destinationLineId)!;
          return {
            lineLinkId: l.id,
            sourcePoId: s.po.id,
            sourcePoNumber: s.po.poNumber,
            sourceLineId: s.line.id,
            destinationLineId: d.id,
            itemName: s.line.itemName,
            quantity: s.line.quantity,
            rate: s.line.rate,
            lineTotal: s.line.lineTotal,
            sourceItemId: s.line.stockItemId,
            destinationItemId: d.stockItemId,
          };
        }),
      };
    })
  );
}
export async function beginRevisionTx(
  tx: DbTransaction,
  data: TradeData,
  input: {
    expectedVersion: number;
    requestKey: string;
    kind: "line_edit" | "shared_invoice_confirm" | "shared_invoice_reallocate";
    actorUserId: string;
    initiatingCompanyId: number;
    postingDate: string;
    amountAfter: string;
    reason: string;
    evidence: Record<string, unknown>;
  }
) {
  if (data.trade.version !== input.expectedVersion)
    rejectEdit("A concurrent edit changed this trade; refresh before editing", "IC_EDIT_STALE_VERSION");
  const [revision] = await tx
    .insert(intercompanyTradeRevisions)
    .values({
      tradeId: data.trade.id,
      revisionNumber: data.trade.version + 1,
      kind: input.kind,
      requestKey: validateRequestKey(input.requestKey),
      actorUserId: input.actorUserId,
      initiatingCompanyId: input.initiatingCompanyId,
      postingDate: postingDay(input.postingDate),
      amountBefore: fullPoCost(data.destination.po).toFixed(2),
      amountAfter: input.amountAfter,
      reason: input.reason,
      evidence: input.evidence,
    })
    .returning();
  await tx.execute(sql`SELECT set_config('erp.ic_edit_revision', ${String(revision.id)}, true)`);
  return revision;
}
export async function completeRevisionTx(
  tx: DbTransaction,
  data: TradeData,
  id: number,
  cost: string,
  vouchers: number[],
  identity: EditIdentity,
  kind: string,
  details: Record<string, unknown>
) {
  const [updated] = await tx
    .update(intercompanyTrades)
    .set({ version: data.trade.version + 1 })
    .where(and(eq(intercompanyTrades.id, data.trade.id), eq(intercompanyTrades.version, data.trade.version)))
    .returning();
  if (!updated) rejectEdit("Trade version changed while posting");
  await tx
    .update(intercompanyTradeRevisions)
    .set({ state: "completed", completedAt: new Date(), postedVoucherIds: vouchers, amountAfter: cost })
    .where(eq(intercompanyTradeRevisions.id, id));
  await tx.insert(intercompanyAuditEvents).values({
    eventKey: "ic-trade-revision:" + id,
    relationshipId: data.trade.relationshipId,
    sourceCompanyId: data.trade.sourceCompanyId,
    actorUserId: identity.actorUserId,
    eventType: "linked-intercompany-cost-revision",
    sourceReference: "trade:" + data.trade.id + ":version:" + updated.version,
    payload: {
      kind,
      revisionId: id,
      voucherIds: vouchers,
      amountAfter: cost,
      initiatingCompanyId: identity.initiatingCompanyId,
      ...details,
    },
  });
  await tx.execute(sql.raw("SELECT set_config('erp.ic_edit_revision','',true)"));
  return updated.version;
}
/** Line prices can be edited from either involved company, with a mandatory version check. */
export async function editLinkedTrade(input: LinkedTradeEditInput, identity: EditIdentity) {
  const trade = await assertTradeAccess(input.tradeId, identity);
  postingDay(input.postingDate);
  validateRequestKey(input.requestKey);
  if (
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 1 ||
    !input.reason?.trim() ||
    input.reason.length > 1000 ||
    !Array.isArray(input.lines) ||
    input.lines.length === 0 ||
    input.lines.length > 3000
  ) {
    rejectEdit("Complete linked lines, an expected version and a reason are required", "IC_EDIT_INPUT", 422);
  }
  return withTradeScope(identity, [trade.sourceCompanyId, trade.destinationCompanyId], () =>
    db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${IMPORT_LOCK}, ${trade.sourceCompanyId})`);
      const [duplicate] = await tx
        .select()
        .from(intercompanyTradeRevisions)
        .where(eq(intercompanyTradeRevisions.requestKey, input.requestKey));
      if (duplicate) {
        if (duplicate.tradeId !== input.tradeId || duplicate.kind !== "line_edit" || duplicate.state !== "completed") {
          rejectEdit("Request key was used for another edit", "IC_EDIT_REPLAY");
        }
        return {
          tradeId: input.tradeId,
          revisionId: duplicate.id,
          version: duplicate.revisionNumber,
          landedCost: duplicate.amountAfter,
          replayed: true,
        };
      }
      const data = await loadTradeTx(tx, input.tradeId);
      requireUnreceived(data);
      if (data.trade.version !== input.expectedVersion)
        rejectEdit("Another edit changed this trade; refresh", "IC_EDIT_STALE_VERSION");
      if (
        input.lines.length !== data.links.length ||
        new Set(input.lines.map((l) => l.lineLinkId)).size !== input.lines.length
      ) {
        rejectEdit("Submit every linked row exactly once", "IC_EDIT_LINES", 422);
      }
      const src = new Map(data.source.flatMap((g) => g.lines.map((l) => [l.id, l] as const)));
      const dst = new Map(data.destination.lines.map((l) => [l.id, l] as const));
      const link = new Map(data.links.map((l) => [l.id, l] as const));
      const goodsByPo = new Map<number, Decimal>();
      const updates: {
        sourceId: number;
        destId: number;
        quantity: string;
        rate: string;
        lineTotal: string;
        itemName: string;
      }[] = [];
      let changed = false;
      for (const edited of input.lines) {
        const paired = link.get(edited.lineLinkId);
        if (!paired) rejectEdit("Line is not part of this trade", "IC_EDIT_LINES", 422);
        const a = src.get(paired.sourceLineId),
          c = dst.get(paired.destinationLineId);
        if (
          !a ||
          !c ||
          String(a.quantity) !== String(c.quantity) ||
          cents(a.rate).toFixed(2) !== cents(c.rate).toFixed(2) ||
          cents(a.lineTotal).toFixed(2) !== cents(c.lineTotal).toFixed(2)
        ) {
          rejectEdit("Existing source and destination lines disagree; investigation required");
        }
        if (!edited.itemName?.trim() || edited.itemName.length > 300)
          rejectEdit("Invalid item description", "IC_EDIT_INPUT", 422);
        let total: Decimal;
        try {
          total = lineTotal(edited.quantity, edited.rate);
        } catch (e) {
          rejectEdit(String(e), "IC_EDIT_INPUT", 422);
        }
        const row = {
          sourceId: a.id,
          destId: c.id,
          quantity: String(edited.quantity),
          rate: cents(edited.rate).toFixed(2),
          lineTotal: total!.toFixed(2),
          itemName: edited.itemName.trim(),
        };
        updates.push(row);
        goodsByPo.set(a.poId, (goodsByPo.get(a.poId) ?? new MoneyDecimal(0)).plus(total!));
        if (
          a.quantity !== row.quantity ||
          cents(a.rate).toFixed(2) !== row.rate ||
          a.itemName !== row.itemName ||
          cents(a.lineTotal).toFixed(2) !== row.lineTotal
        )
          changed = true;
      }
      if (!changed) rejectEdit("No purchase-order values changed", "IC_EDIT_NO_CHANGE", 422);
      const poDeltas = data.source.map((g) => ({
        poId: g.po.id,
        goods: (goodsByPo.get(g.po.id) ?? new MoneyDecimal(0)).minus(cents(g.po.itemsTotal ?? "0")),
        charge: new MoneyDecimal(0),
      }));
      const next = fullPoCost(data.destination.po).plus(sumMoney(poDeltas.map((d) => d.goods)));
      if (!next.gt(0)) rejectEdit("A linked PO cannot have non-positive landed cost");
      const revision = await beginRevisionTx(tx, data, {
        expectedVersion: input.expectedVersion,
        requestKey: input.requestKey,
        kind: "line_edit",
        actorUserId: identity.actorUserId,
        initiatingCompanyId: identity.initiatingCompanyId,
        postingDate: input.postingDate,
        amountAfter: next.toFixed(2),
        reason: input.reason.trim(),
        evidence: { lines: updates },
      });
      for (const line of updates) {
        const patch = { quantity: line.quantity, rate: line.rate, lineTotal: line.lineTotal, itemName: line.itemName };
        await tx.update(poLineItems).set(patch).where(eq(poLineItems.id, line.sourceId));
        await tx.update(poLineItems).set(patch).where(eq(poLineItems.id, line.destId));
      }
      const result = await applyCostDeltasTx(tx, data, {
        revisionId: revision.id,
        postingDate: input.postingDate,
        reason: input.reason,
        actorUserId: identity.actorUserId,
        poDeltas,
      });
      const releasedCredit = await releaseEditOverallocationTx(tx, {
        tradeId: data.trade.id,
        newLandedCost: result.amountAfter,
        actorUserId: identity.actorUserId,
        revisionId: revision.id,
      });
      const version = await completeRevisionTx(
        tx,
        data,
        revision.id,
        result.amountAfter,
        result.vouchers,
        identity,
        "line_edit",
        { changedLines: updates.length, releasedCredit }
      );
      return {
        tradeId: input.tradeId,
        revisionId: revision.id,
        version,
        landedCost: result.amountAfter,
        replayed: false,
      };
    })
  );
}
