/** Dedicated Phase 5 receiving/cancellation; no generic container offload bypass. */
import type { Express, Request, Response } from "express";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { z } from "zod";
import {
  containers,
  intercompanyDestinationReceipts,
  intercompanyImportBatchContainers,
  intercompanySharedChargeAllocations,
  intercompanyTradeCancellations,
  intercompanyTrades,
  ledgerAccounts,
  locations,
} from "@shared/schema";
import { requireAuth } from "../../auth";
import { db } from "../../db";
import { logger } from "../../lib/logger";
import { cancelUnreceivedTrade } from "../../services/intercompany/phase5Cancel";
import { deletePristineLinkedTrade } from "../../services/intercompany/linkedTradePhysicalDelete";
import { receiveLinkedTrade } from "../../services/intercompany/phase5Receipt";
import { requireReceivingPairPermission } from "../../services/intercompany/phase5ReceivingAccess";
import {
  assertTradeAccess,
  IntercompanyEditError,
  type EditIdentity,
  withTradeScope,
} from "../../services/intercompany/tradeSync";

const id = z.number().int().positive();
const routeId = z.coerce.number().int().positive();
const key = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const reason = z.string().trim().min(3).max(1000);
const evidence = z.string().trim().min(8).max(2000);

const receive = z
  .object({
    expectedVersion: id,
    requestKey: key,
    postingDate: day,
    locationId: id,
    inventoryAccountId: id,
    arrivalEvidence: evidence,
    reason,
    confirmPhysicalArrival: z.literal(true),
    confirmNoAdditionalUnpostedCharges: z.literal(true),
  })
  .strict();
const cancel = z
  .object({
    expectedVersion: id,
    requestKey: key,
    postingDate: day,
    reason,
    cancellationEvidence: evidence,
    sharedChargeDecision: z.enum(["none", "redistributed"]),
    confirmGoodsNotReceived: z.literal(true),
    confirmNoRealCashReversal: z.literal(true),
  })
  .strict();

function actor(req: Request): EditIdentity {
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
function fail(res: Response, error: unknown) {
  if (error instanceof IntercompanyEditError) {
    return res.status(error.status).json({ code: error.code, message: error.message });
  }
  if (error instanceof z.ZodError) {
    return res.status(422).json({
      code: "IC_PHASE5_INPUT",
      message: error.issues.map((issue) => issue.message).join("; "),
    });
  }
  logger.error("Phase 5 intercompany lifecycle refused", { error });
  return res.status(500).json({
    code: "IC_PHASE5_INTERNAL",
    message: "No partial stock receipt or trade cancellation was saved. Refresh and reconcile the evidence.",
  });
}

/** Only display trades of the selected signed-in company; join other-company
 * details only after the pair has been validated with the same scope helper. */
async function lifecycleList(identity: EditIdentity) {
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
    const [imported, received, canceled, charges, physical, localLocations, localInventoryAccounts] = await Promise.all(
      [
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
      ]
    );
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
          hasSharedInvoices: invoiceCharges.length > 0,
          pendingSharedAllocation: invoiceCharges.some((item) => Number(item.amount) > 0),
        };
      }),
      locations: localLocations,
      inventoryAccounts: localInventoryAccounts,
    };
  });
}

export function registerIntercompanyPhase5Routes(app: Express) {
  app.get("/api/intercompany-container-trading/lifecycle", requireAuth, async (req, res) => {
    try {
      return res.json(await lifecycleList(actor(req)));
    } catch (error) {
      return fail(res, error);
    }
  });
  // The Properties container detail selects the destination warehouse
  // without asking the user to manually map GIT or INVENTORY. Only expose
  // receiving choices to an actor authorized in this specific destination.
  app.get("/api/intercompany-container-trading/lifecycle/:tradeId/receiving-options", requireAuth, async (req, res) => {
    try {
      const identity = actor(req);
      const trade = await assertTradeAccess(routeId.parse(req.params.tradeId), identity);
      await requireReceivingPairPermission(trade, identity);
      return res.json(
        await withTradeScope(identity, [trade.sourceCompanyId, trade.destinationCompanyId], async () => {
          const [warehouses, inventoryAccounts] = await Promise.all([
            db
              .select({ id: locations.id, name: locations.name })
              .from(locations)
              .where(
                and(
                  eq(locations.companyId, trade.destinationCompanyId),
                  eq(locations.active, true),
                  isNull(locations.deletedAt)
                )
              ),
            db
              .select({ id: ledgerAccounts.id, name: ledgerAccounts.name, accountType: ledgerAccounts.accountType })
              .from(ledgerAccounts)
              .where(
                and(
                  eq(ledgerAccounts.companyId, trade.destinationCompanyId),
                  eq(ledgerAccounts.code, "INVENTORY"),
                  eq(ledgerAccounts.active, true),
                  isNull(ledgerAccounts.deletedAt)
                )
              ),
          ]);
          const eligible = inventoryAccounts.filter((account) =>
            ["Asset", "Current Asset"].includes(account.accountType)
          );
          return {
            tradeId: trade.id,
            destinationCompanyId: trade.destinationCompanyId,
            locations: warehouses,
            // Refuse to guess if legacy data contains multiple INVENTORY accounts.
            inventoryAccountId: eligible.length === 1 ? eligible[0].id : null,
            inventoryAccountStatus: eligible.length === 1 ? "ready" : eligible.length ? "ambiguous" : "missing",
          };
        })
      );
    } catch (error) {
      return fail(res, error);
    }
  });

  app.post("/api/intercompany-container-trading/lifecycle/:tradeId/receive", requireAuth, async (req, res) => {
    try {
      const parsed = receive.parse(req.body);
      return res.status(201).json(
        await receiveLinkedTrade(
          {
            tradeId: routeId.parse(req.params.tradeId),
            ...parsed,
          },
          actor(req)
        )
      );
    } catch (error) {
      return fail(res, error);
    }
  });
  // Delete the complete untouched company pair: no reversal voucher is posted.
  app.post("/api/intercompany-container-trading/lifecycle/:tradeId/delete-linked", requireAuth, async (req, res) => {
    try {
      const parsed = z.object({
        expectedVersion: id,
        confirmDeleteBothCompanies: z.literal(true),
      }).strict().parse(req.body);
      const result = await deletePristineLinkedTrade(
        routeId.parse(req.params.tradeId), parsed.expectedVersion, actor(req)
      );
      return res.json(result);
    } catch (error) {
      return fail(res, error);
    }
  });
  app.post("/api/intercompany-container-trading/lifecycle/:tradeId/cancel", requireAuth, async (req, res) => {
    try {
      const parsed = cancel.parse(req.body);
      return res.status(201).json(
        await cancelUnreceivedTrade(
          {
            tradeId: routeId.parse(req.params.tradeId),
            ...parsed,
          },
          actor(req)
        )
      );
    } catch (error) {
      return fail(res, error);
    }
  });
}
