// Extracted from ./intercompany-phase5.ts
import type { Request } from "express";
import { and, eq, inArray, or } from "drizzle-orm";
import {
  containers,
  intercompanyAuditEvents,
  intercompanyDestinationReceipts,
  intercompanyImportBatchContainers,
  intercompanySharedChargeAllocations,
  intercompanyTradeCancellations,
  intercompanyTrades,
  ledgerAccounts,
  locations,
} from "@shared/schema";
import { db } from "../../db";
import { IntercompanyEditError, type EditIdentity, withTradeScope } from "../../services/intercompany/tradeSync";

export function actor(req: Request): EditIdentity {
  const initiatingCompanyId = Number(req.session.currentCompanyId);
  if (
    !Number.isSafeInteger(initiatingCompanyId) ||
    initiatingCompanyId < 1 ||
    !req.session.userId ||
    !["Owner", "Admin", "Developer"].includes(String(req.session.currentRole))
  ) {
    throw new IntercompanyEditError("IC_PHASE5_FORBIDDEN", "Owner, Admin or Developer membership required", 403);
  }
  return {
    initiatingCompanyId,
    actorUserId: String(req.session.userId),
    actorRole: String(req.session.currentRole),
  };
}

/** Only display trades of the selected signed-in company; join other-company
 * details only after the pair has been validated with the same scope helper. */
export async function lifecycleList(identity: EditIdentity) {
  const trades = await withTradeScope(identity, [], () =>
    db
      .select()
      .from(intercompanyTrades)
      .where(
        or(
          eq(intercompanyTrades.sourceCompanyId, identity.initiatingCompanyId),
          eq(intercompanyTrades.destinationCompanyId, identity.initiatingCompanyId)
        )
      )
  );
  const pairs = [...new Set(trades.flatMap((t) => [t.sourceCompanyId, t.destinationCompanyId]))];
  return withTradeScope(identity, pairs, async () => {
    const tradeIds = trades.map((t) => t.id);
    const physicalIds = trades.map((t) => t.physicalContainerId);
    const [imported, received, canceled, charges, physical, localLocations, localInventoryAccounts, technicalEvents] =
      await Promise.all([
        tradeIds.length
          ? db
              .select()
              .from(intercompanyImportBatchContainers)
              .where(inArray(intercompanyImportBatchContainers.tradeId, tradeIds))
          : [],
        tradeIds.length
          ? db
              .select()
              .from(intercompanyDestinationReceipts)
              .where(inArray(intercompanyDestinationReceipts.tradeId, tradeIds))
          : [],
        tradeIds.length
          ? db
              .select()
              .from(intercompanyTradeCancellations)
              .where(inArray(intercompanyTradeCancellations.tradeId, tradeIds))
          : [],
        tradeIds.length
          ? db
              .select()
              .from(intercompanySharedChargeAllocations)
              .where(inArray(intercompanySharedChargeAllocations.tradeId, tradeIds))
          : [],
        physicalIds.length
          ? db
              .select({ id: containers.id, number: containers.containerNumber, status: containers.status })
              .from(containers)
              .where(inArray(containers.id, physicalIds))
          : [],
        db
          .select({ id: locations.id, name: locations.name })
          .from(locations)
          .where(and(eq(locations.companyId, identity.initiatingCompanyId), eq(locations.active, true))),
        db
          .select({ id: ledgerAccounts.id, name: ledgerAccounts.name })
          .from(ledgerAccounts)
          .where(
            and(
              eq(ledgerAccounts.companyId, identity.initiatingCompanyId),
              eq(ledgerAccounts.code, "INVENTORY"),
              eq(ledgerAccounts.active, true)
            )
          ),
        trades.length
          ? db
              .select({
                eventType: intercompanyAuditEvents.eventType,
                eventKey: intercompanyAuditEvents.eventKey,
                payload: intercompanyAuditEvents.payload,
              })
              .from(intercompanyAuditEvents)
              .where(inArray(intercompanyAuditEvents.relationshipId, [...new Set(trades.map((t) => t.relationshipId))]))
          : [],
      ]);
    return {
      trades: trades.map((trade) => {
        const r = received.find((item) => item.tradeId === trade.id);
        const c = canceled.find((item) => item.tradeId === trade.id);
        const costs = imported.find((item) => item.tradeId === trade.id);
        const invoiceCharges = charges.filter((item) => item.tradeId === trade.id);
        return {
          tradeId: trade.id,
          physicalContainerId: trade.physicalContainerId,
          relationshipId: trade.relationshipId,
          sourceCompanyId: trade.sourceCompanyId,
          destinationCompanyId: trade.destinationCompanyId,
          version: trade.version,
          state: trade.state,
          containerNumber: physical.find((item) => item.id === trade.physicalContainerId)?.number ?? "Unknown",
          physicalStatus: physical.find((item) => item.id === trade.physicalContainerId)?.status ?? "Unknown",
          landedCost: costs?.confirmedLandedCost ?? "0.00",
          received: r
            ? { id: r.id, locationId: r.locationId, date: r.postingDate, voucherId: r.receiptVoucherId }
            : null,
          canceled: c ? { id: c.id, date: c.postingDate, releasedCredit: c.releasedCredit } : null,
          accountingNetted: technicalEvents.some(
            (event) =>
              (event.eventKey === "ic-technical-profit-normalized:" + trade.id &&
                event.eventType === "intercompany-internal-profit-netted") ||
              (event.eventType === "container-import-confirmed" &&
                event.eventKey.startsWith("ic-container-import:") &&
                event.eventKey.endsWith(":" + trade.id) &&
                (event.payload as { technicalProfitNetting?: unknown } | null)?.technicalProfitNetting === true)
          ),
          hasSharedInvoices: invoiceCharges.length > 0,
          pendingSharedAllocation: invoiceCharges.some((item) => Number(item.amount) > 0),
        };
      }),
      locations: localLocations,
      inventoryAccounts: localInventoryAccounts,
    };
  });
}
