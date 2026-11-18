// Extracted from ./tradeSync.ts to keep that module under the source-size cap.
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  containers,
  intercompanyAuditEvents,
  intercompanyDestinationReceipts,
  intercompanyImportBatchContainers,
  intercompanyRelationshipPolicies,
  intercompanyTradeLineLinks,
  intercompanyTrades,
  intercompanyTradeSourcePos,
  poLineItems,
  purchaseOrders,
  userCompanyRoles,
} from "@shared/schema";
import { db, type DbTransaction } from "../../db";
import { sumMoney } from "../../lib/money";
import {
  createTenantDatabaseScope,
  getDatabaseScopeRuntimeContext,
  runWithDatabaseScopeRuntimeContext,
} from "../security/databaseScopeRuntimeContext";
import {
  getCompanyRequestRuntimeContext,
  runWithCompanyRequestRuntimeContext,
} from "../security/companyRequestRuntimeContext";
import { cents, fullPoCost, requireCostEqual } from "./tradeRevisionMath";

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

export const IMPORT_LOCK = 741235;

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

export type Trade = typeof intercompanyTrades.$inferSelect;

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

export async function requireMembership(identity: EditIdentity) {
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

/**
 * The import audit locks the accounting treatment per trade. Older imports
 * retain their historical accounting until an explicit reviewed restatement.
 */
export async function isNettedIntercompanyTradeTx(tx: DbTransaction, tradeId: number): Promise<boolean> {
  const [event] = await tx
    .select({ payload: intercompanyAuditEvents.payload })
    .from(intercompanyAuditEvents)
    .where(
      and(
        eq(intercompanyAuditEvents.eventType, "container-import-confirmed"),
        sql`${intercompanyAuditEvents.eventKey} LIKE ${"ic-container-import:%:" + tradeId}`
      )
    )
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
