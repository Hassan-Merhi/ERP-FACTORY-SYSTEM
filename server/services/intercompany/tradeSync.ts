import type Decimal from "decimal.js";
/** Phase 3: atomically mirror source/destination PO pricing, and append adjustment journals. */
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  containers,
  intercompanyAuditEvents,
  intercompanyDestinationReceipts,
  intercompanyImportBatchContainers,
  intercompanyRelationshipPolicies,
  intercompanyTradeLineLinks,
  intercompanyTradeRevisions,
  intercompanyTradeSourcePos,
  intercompanyTrades,
  poLineItems,
  purchaseOrders,
  userCompanyRoles,
} from "@shared/schema";
import { db, type DbTransaction } from "../../db";
import { MoneyDecimal, sumMoney } from "../../lib/money";
import { postErpVoucherTx } from "../accounting/erpVoucherPosting";
import {
  createTenantDatabaseScope,
  getDatabaseScopeRuntimeContext,
  runWithDatabaseScopeRuntimeContext,
} from "../security/databaseScopeRuntimeContext";
import {
  getCompanyRequestRuntimeContext,
  runWithCompanyRequestRuntimeContext,
} from "../security/companyRequestRuntimeContext";
import { cents, fullPoCost, lineTotal, requireCostEqual, signedPair } from "./tradeRevisionMath";
import { releaseEditOverallocationTx } from "./paymentAllocationCore";

export class IntercompanyEditError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409
  ) {
    super(message);
    this.name = "IntercompanyEditError";
  }
}
export function rejectEdit(message: string, code = "IC_EDIT_UNSAFE", status = 409): never {
  throw new IntercompanyEditError(code, message, status);
}
const IMPORT_LOCK = 741235;
const REQUEST_KEY = /^[A-Za-z0-9._:-]{8,128}$/;

export type EditIdentity = { initiatingCompanyId: number; actorUserId: string; actorRole: string };
export type LinkedLineEdit = { lineLinkId: number; quantity: string; rate: string; itemName: string };
export type LinkedTradeEditInput = {
  tradeId: number;
  expectedVersion: number;
  requestKey: string;
  postingDate: string;
  reason: string;
  lines: LinkedLineEdit[];
};
type Trade = typeof intercompanyTrades.$inferSelect;
type Po = typeof purchaseOrders.$inferSelect;
type SourcePo = { po: Po; lines: (typeof poLineItems.$inferSelect)[] };
export type TradeData = {
  trade: Trade;
  physical: typeof containers.$inferSelect;
  policy: typeof intercompanyRelationshipPolicies.$inferSelect;
  source: SourcePo[];
  destination: SourcePo;
  links: (typeof intercompanyTradeLineLinks.$inferSelect)[];
  imported: typeof intercompanyImportBatchContainers.$inferSelect;
  received: typeof intercompanyDestinationReceipts.$inferSelect | null;
};
export const postingDay = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value + "T12:00:00Z"))) {
    rejectEdit("Enter a valid accounting adjustment posting date", "IC_EDIT_DATE", 422);
  }
  return value;
};
export function validateRequestKey(value: string) {
  if (!REQUEST_KEY.test(value)) rejectEdit("Edit request key is invalid", "IC_EDIT_KEY", 422);
  return value;
}
async function requireMembership(identity: EditIdentity) {
  const { initiatingCompanyId, actorUserId, actorRole } = identity;
  if (
    !Number.isSafeInteger(initiatingCompanyId) ||
    initiatingCompanyId < 1 ||
    !actorUserId ||
    !["Owner", "Developer", "Admin"].includes(actorRole)
  ) {
    rejectEdit("Owner, Admin or Developer permission is required", "IC_EDIT_FORBIDDEN", 403);
  }
  if (actorRole !== "Developer") {
    const [membership] = await db
      .select()
      .from(userCompanyRoles)
      .where(and(eq(userCompanyRoles.userId, actorUserId), eq(userCompanyRoles.companyId, initiatingCompanyId)));
    if (!membership || !["Owner", "Developer", "Admin"].includes(membership.role)) {
      rejectEdit("Company edit permission was revoked", "IC_EDIT_FORBIDDEN", 403);
    }
  }
}
/** Both companies may edit the same financial transaction, but only with a verified session company. */
export async function withTradeScope<T>(identity: EditIdentity, affected: readonly number[], work: () => Promise<T>) {
  await requireMembership(identity);
  const scope = getDatabaseScopeRuntimeContext();
  if (scope?.kind === "tenant" && scope.companyId !== identity.initiatingCompanyId) {
    rejectEdit("Database scope disagrees with session", "IC_EDIT_SCOPE", 403);
  }
  const ctx = getCompanyRequestRuntimeContext();
  if (ctx && ctx.companyId !== identity.initiatingCompanyId) {
    rejectEdit("Company changed during request", "IC_EDIT_SCOPE", 403);
  }
  const authorizedCompanyIds = [...new Set([identity.initiatingCompanyId, ...affected])];
  const run = () =>
    runWithDatabaseScopeRuntimeContext(
      createTenantDatabaseScope(identity.initiatingCompanyId, authorizedCompanyIds, "authorized-companies"),
      work
    );
  return ctx
    ? runWithCompanyRequestRuntimeContext(
        { ...ctx, authorizedCompanyIds: [...new Set([...(ctx.authorizedCompanyIds ?? []), ...authorizedCompanyIds])] },
        run
      )
    : run();
}
export async function assertTradeAccess(tradeId: number, identity: EditIdentity): Promise<Trade> {
  await requireMembership(identity);
  if (!Number.isSafeInteger(tradeId) || tradeId <= 0) rejectEdit("Invalid trade ID", "IC_EDIT_ID", 422);
  const [trade] = await db.select().from(intercompanyTrades).where(eq(intercompanyTrades.id, tradeId));
  if (!trade || ![trade.sourceCompanyId, trade.destinationCompanyId].includes(identity.initiatingCompanyId)) {
    rejectEdit("No linked trade belongs to this company", "IC_EDIT_NOT_FOUND", 404);
  }
  return trade;
}
export async function loadTradeTx(tx: DbTransaction, tradeId: number, lock = true): Promise<TradeData> {
  const query = tx.select().from(intercompanyTrades).where(eq(intercompanyTrades.id, tradeId));
  const [trade] = lock ? await query.for("update") : await query;
  if (!trade || trade.state !== "active" || !trade.destinationPoId) rejectEdit("Trade is not active");
  const [[physical], [policy], sourceLinks, [dest], links, [imported], [received]] = await Promise.all([
    tx.select().from(containers).where(eq(containers.id, trade.physicalContainerId)),
    tx
      .select()
      .from(intercompanyRelationshipPolicies)
      .where(eq(intercompanyRelationshipPolicies.id, trade.relationshipId)),
    tx.select().from(intercompanyTradeSourcePos).where(eq(intercompanyTradeSourcePos.tradeId, trade.id)),
    tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, trade.destinationPoId)),
    tx.select().from(intercompanyTradeLineLinks).where(eq(intercompanyTradeLineLinks.tradeId, trade.id)),
    tx.select().from(intercompanyImportBatchContainers).where(eq(intercompanyImportBatchContainers.tradeId, trade.id)),
    tx.select().from(intercompanyDestinationReceipts).where(eq(intercompanyDestinationReceipts.tradeId, trade.id)),
  ]);
  if (!physical || !policy || !dest || !imported || !sourceLinks.length) rejectEdit("Trade documents are incomplete");
  if (
    physical.companyId !== trade.sourceCompanyId ||
    dest.companyId !== trade.destinationCompanyId ||
    dest.containerId !== physical.id ||
    dest.supplierId !== policy.destinationSupplierId ||
    policy.sourceCompanyId !== trade.sourceCompanyId ||
    policy.destinationCompanyId !== trade.destinationCompanyId ||
    policy.relationshipType !== "container_trade" ||
    policy.baseCurrency !== "USD"
  ) {
    rejectEdit("Trade ownership and financial mapping do not match");
  }
  const poIds = sourceLinks.map((link) => link.sourcePoId);
  const sourcePos = await tx.select().from(purchaseOrders).where(inArray(purchaseOrders.id, poIds));
  if (
    sourcePos.length !== poIds.length ||
    sourcePos.some(
      (po) =>
        po.companyId !== trade.sourceCompanyId ||
        po.containerId !== physical.id ||
        po.supplierId !== physical.supplierId ||
        po.currency !== "USD"
    )
  ) {
    rejectEdit("Original supplier POs are no longer consistent");
  }
  const [srcLines, dstLines] = await Promise.all([
    tx.select().from(poLineItems).where(inArray(poLineItems.poId, poIds)),
    tx.select().from(poLineItems).where(eq(poLineItems.poId, dest.id)),
  ]);
  if (!links.length || links.length !== srcLines.length || links.length !== dstLines.length) {
    rejectEdit("Full source-to-destination line mapping is missing");
  }
  const sourceIds = new Set(srcLines.map((l) => l.id)),
    destinationIds = new Set(dstLines.map((l) => l.id));
  if (links.some((l) => !sourceIds.has(l.sourceLineId) || !destinationIds.has(l.destinationLineId))) {
    rejectEdit("A mapped purchase line belongs to the wrong trade");
  }
  const source = sourcePos.map((po) => ({ po, lines: srcLines.filter((l) => l.poId === po.id) }));
  const total = sumMoney(source.map((g) => fullPoCost(g.po)));
  requireCostEqual("Source/destination POs", total, fullPoCost(dest));
  requireCostEqual("Physical container", total, cents(physical.grandTotal ?? "0"));
  requireCostEqual("Confirmed import cost", total, cents(imported.confirmedLandedCost ?? "0"));
  return {
    trade,
    physical,
    policy,
    source,
    destination: { po: dest, lines: dstLines },
    links,
    imported,
    received: received ?? null,
  };
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
  await tx.execute(sql.raw("SELECT set_config('erp.ic_edit_revision','" + revision.id + "',true)"));
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
/**
 * The import audit locks the accounting treatment per trade. Older imports
 * retain their historical accounting until an explicit reviewed restatement.
 */
export async function isNettedIntercompanyTradeTx(tx: DbTransaction, tradeId: number): Promise<boolean> {
  const [event] = await tx
    .select({ payload: intercompanyAuditEvents.payload })
    .from(intercompanyAuditEvents)
    .where(and(
      eq(intercompanyAuditEvents.eventType, "container-import-confirmed"),
      sql`${intercompanyAuditEvents.eventKey} LIKE ${"ic-container-import:%:" + tradeId}`
    ))
    .limit(1);
  if ((event?.payload as { technicalProfitNetting?: unknown } | null)?.technicalProfitNetting === true) {
    return true;
  }
  const [normalized] = await tx
    .select({ id: intercompanyAuditEvents.id })
    .from(intercompanyAuditEvents)
    .where(eq(intercompanyAuditEvents.eventKey, "ic-technical-profit-normalized:" + tradeId))
    .limit(1);
  return Boolean(normalized);
}
/** Exact source PO deltas, mirrored sale/COGS and destination GIT/supplier payable, without touching old vouchers. */
export async function applyCostDeltasTx(
  tx: DbTransaction,
  data: TradeData,
  input: {
    revisionId: number;
    postingDate: string;
    reason: string;
    actorUserId: string;
    poDeltas: {
      poId: number;
      goods: Decimal;
      charge: Decimal;
      chargeField?: "freight" | "surcharge" | "fumigation" | "documentCharges" | "otherCharges";
    }[];
  }
) {
  const p = data.policy,
    original = new Map(data.source.map((g) => [g.po.id, g.po]));
  const netted = await isNettedIntercompanyTradeTx(tx, data.trade.id);
  const goodsDelta = sumMoney(input.poDeltas.map((x) => x.goods));
  const chargesDelta = sumMoney(input.poDeltas.map((x) => x.charge));
  const totalDelta = goodsDelta.plus(chargesDelta);
  const before = fullPoCost(data.destination.po);
  const after = before.plus(totalDelta);
  if (!after.gt(0)) rejectEdit("Confirmed landed cost must stay positive");
  const vouchers: number[] = [];
  for (const change of input.poDeltas) {
    if (change.goods.isZero() && change.charge.isZero()) continue;
    const po = original.get(change.poId);
    if (!po) rejectEdit("Source PO does not belong to the linked container");
    const lines = [
      ...signedPair(
        { ledgerAccountId: p.sourcePurchaseAccountId! },
        { supplierId: po.supplierId },
        change.goods,
        "External supplier price adjustment, PO " + po.poNumber
      ),
      ...signedPair(
        { ledgerAccountId: p.sourcePurchaseAccountId! },
        netted ? { supplierId: po.supplierId } : { ledgerAccountId: p.sourceChargeAccrualAccountId! },
        change.charge,
        "Confirmed charge accrual adjustment, PO " + po.poNumber
      ),
    ];
    const voucher = await postErpVoucherTx(tx, {
      companyId: data.trade.sourceCompanyId,
      voucherType: "Journal",
      voucherDate: input.postingDate,
      sourceModule: "INTERCOMPANY_CONTAINER",
      description: "Original PO adjustment: " + po.poNumber,
      source: { type: "ic-phase3-source-adjustment", id: input.revisionId, revision: po.id },
      actor: { userId: input.actorUserId, reason: input.reason },
      lines,
    });
    vouchers.push(voucher.voucher.id);
    const update: Partial<typeof purchaseOrders.$inferInsert> = {};
    if (!change.goods.isZero()) {
      const goods = cents(po.itemsTotal ?? "0").plus(change.goods);
      if (goods.lt(0)) rejectEdit("Original supplier PO items cannot become negative");
      update.itemsTotal = goods.toFixed(2);
    }
    if (!change.charge.isZero()) {
      const field = change.chargeField;
      if (!field) rejectEdit("Confirmed charge has no mapped charge type");
      const value = cents(po[field] ?? "0").plus(change.charge);
      if (value.lt(0)) rejectEdit("Confirmed source PO charge cannot become negative");
      update[field] = value.toFixed(2);
      update.chargesEdited = true;
    }
    await tx.update(purchaseOrders).set(update).where(eq(purchaseOrders.id, po.id));
  }
  if (!totalDelta.isZero()) {
    for (const step of [
      {
        companyId: data.trade.sourceCompanyId,
        key: "source-sale",
        lines: signedPair(
          { ledgerAccountId: p.sourceReceivableAccountId! },
          { ledgerAccountId: p.sourceSalesAccountId! },
          totalDelta,
          "At-cost intercompany resale adjustment"
        ),
      },
      {
        companyId: data.trade.sourceCompanyId,
        key: "source-cost",
        lines: signedPair(
          { ledgerAccountId: p.sourceCostAccountId! },
          { ledgerAccountId: p.sourcePurchaseAccountId! },
          totalDelta,
          "Cost of goods sold reclassification"
        ).concat(
          netted
            ? signedPair(
                { ledgerAccountId: p.sourceSalesAccountId! },
                { ledgerAccountId: p.sourceCostAccountId! },
                totalDelta,
                "Eliminate internal sales and COGS at cost"
              )
            : []
        ),
      },
      {
        companyId: data.trade.destinationCompanyId,
        key: "destination-git",
        lines: signedPair(
          { ledgerAccountId: p.destinationGitAccountId! },
          { supplierId: p.destinationSupplierId! },
          totalDelta,
          "Destination GIT / Hassan Properties supplier payable"
        ),
      },
    ]) {
      const posted = await postErpVoucherTx(tx, {
        companyId: step.companyId,
        voucherType: "Journal",
        voucherDate: input.postingDate,
        sourceModule: "INTERCOMPANY_CONTAINER",
        description: "Atomic linked cost adjustment",
        source: { type: "ic-phase3-" + step.key, id: input.revisionId },
        actor: { userId: input.actorUserId, reason: input.reason },
        lines: step.lines,
      });
      vouchers.push(posted.voucher.id);
    }
  }
  if (!totalDelta.isZero()) {
    const update: Partial<typeof purchaseOrders.$inferInsert> = {};
    if (!goodsDelta.isZero())
      update.itemsTotal = cents(data.destination.po.itemsTotal ?? "0")
        .plus(goodsDelta)
        .toFixed(2);
    if (!chargesDelta.isZero()) {
      const fields = [...new Set(input.poDeltas.filter((x) => !x.charge.isZero()).map((x) => x.chargeField))];
      if (fields.length !== 1 || !fields[0]) rejectEdit("A confirmed revision must use one charge type");
      const field = fields[0],
        value = cents(data.destination.po[field] ?? "0").plus(chargesDelta);
      if (value.lt(0)) rejectEdit("Destination confirmed charge cannot become negative");
      update[field] = value.toFixed(2);
      update.chargesEdited = true;
    }
    await tx.update(purchaseOrders).set(update).where(eq(purchaseOrders.id, data.destination.po.id));
    await tx
      .update(containers)
      .set({
        ...(!goodsDelta.isZero()
          ? {
              itemsTotal: cents(data.physical.itemsTotal ?? "0")
                .plus(goodsDelta)
                .toFixed(2),
            }
          : {}),
        ...(!chargesDelta.isZero()
          ? {
              chargesTotal: cents(data.physical.chargesTotal ?? "0")
                .plus(chargesDelta)
                .toFixed(2),
            }
          : {}),
        grandTotal: after.toFixed(2),
      })
      .where(eq(containers.id, data.physical.id));
    await tx
      .update(intercompanyImportBatchContainers)
      .set({
        confirmedLandedCost: after.toFixed(2),
        ...(!chargesDelta.isZero() ? { chargesConfirmed: true } : {}),
      })
      .where(eq(intercompanyImportBatchContainers.id, data.imported.id));
  }
  return { amountAfter: after.toFixed(2), vouchers };
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
      await tx.execute(sql.raw("SELECT pg_advisory_xact_lock(" + IMPORT_LOCK + "," + trade.sourceCompanyId + ")"));
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
