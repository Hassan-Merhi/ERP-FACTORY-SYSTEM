/** Dedicated Phase 5 receiving/cancellation; no generic container offload bypass. */
import type { Express, Response } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { ledgerAccounts, locations } from "@shared/schema";
import { requireAuth } from "../../auth";
import { db } from "../../db";
import { logger } from "../../lib/logger";
import { cancelUnreceivedTrade } from "../../services/intercompany/phase5Cancel";
import {
  daybookLinkedVoucherTrades,
  deletePristineLinkedTrade,
} from "../../services/intercompany/linkedTradePhysicalDelete";
import { normalizeLegacyIntercompanyProfit } from "../../services/intercompany/legacyProfitNetting";
import { receiveLinkedTrade } from "../../services/intercompany/phase5Receipt";
import { requireReceivingPairPermission } from "../../services/intercompany/phase5ReceivingAccess";
import { assertTradeAccess, IntercompanyEditError, withTradeScope } from "../../services/intercompany/tradeSync";
import { actor, lifecycleList } from "./intercompany-phase5-helpers";

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

function fail(res: Response, error: unknown, operation: "lifecycle" | "delete-linked" = "lifecycle") {
  if (error instanceof IntercompanyEditError) {
    return res.status(error.status).json({ code: error.code, message: error.message });
  }
  if (error instanceof z.ZodError) {
    return res.status(422).json({
      code: "IC_PHASE5_INPUT",
      message: error.issues.map((issue) => issue.message).join("; "),
    });
  }
  logger.error("Phase 5 intercompany lifecycle refused", {
    operation,
    error,
    pgCode: typeof error === "object" && error != null && "code" in error ? String(error.code) : undefined,
    pgConstraint:
      typeof error === "object" && error != null && "constraint" in error ? String(error.constraint) : undefined,
  });
  if (operation === "delete-linked") {
    return res.status(409).json({
      code: "IC_DELETE_DATABASE_REFUSED",
      message:
        "The database refused the linked PO deletion; both companies and their vouchers remain unchanged. Ask a developer to inspect the IC_DELETE_DATABASE_REFUSED server log.",
    });
  }
  return res.status(500).json({
    code: "IC_PHASE5_INTERNAL",
    message: "No partial stock receipt or trade cancellation was saved. Refresh and reconcile the evidence.",
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
  // Daybook looks up the actual import-owned vouchers, not description text.
  app.get("/api/intercompany-container-trading/daybook-linked-vouchers", requireAuth, async (req, res) => {
    try {
      const raw = z.string().min(1).max(1500).parse(req.query.ids);
      const ids = z.array(routeId).min(1).max(100).parse(raw.split(","));
      return res.json({ linked: await daybookLinkedVoucherTrades(ids, actor(req)) });
    } catch (error) {
      return fail(res, error);
    }
  });
  app.post(
    "/api/intercompany-container-trading/daybook-voucher/:voucherId/delete-linked",
    requireAuth,
    async (req, res) => {
      try {
        const voucherId = routeId.parse(req.params.voucherId);
        const parsed = z
          .object({
            expectedVersion: id,
            confirmDeleteBothCompanies: z.literal(true),
          })
          .strict()
          .parse(req.body);
        const linked = await daybookLinkedVoucherTrades([voucherId], actor(req));
        const trade = linked[voucherId];
        if (!trade || trade.version !== parsed.expectedVersion) {
          throw new IntercompanyEditError("IC_DELETE_STALE", "Linked Daybook voucher changed; refresh and review", 409);
        }
        return res.json(await deletePristineLinkedTrade(trade.tradeId, trade.version, actor(req)));
      } catch (error) {
        return fail(res, error, "delete-linked");
      }
    }
  );
  // Explicit audited neutralization of old internal at-cost Sales and COGS.
  // No external supplier, intercompany balance, stock or cash change.
  app.post(
    "/api/intercompany-container-trading/lifecycle/:tradeId/normalize-internal-profit",
    requireAuth,
    async (req, res) => {
      try {
        const body = z
          .object({
            expectedVersion: id,
            postingDate: day,
            confirmNoCashOrStockChange: z.literal(true),
          })
          .strict()
          .parse(req.body);
        return res.json(
          await normalizeLegacyIntercompanyProfit(
            {
              tradeId: routeId.parse(req.params.tradeId),
              ...body,
            },
            actor(req)
          )
        );
      } catch (error) {
        return fail(res, error);
      }
    }
  );
  // Delete the complete untouched company pair: no reversal voucher is posted.
  app.post("/api/intercompany-container-trading/lifecycle/:tradeId/delete-linked", requireAuth, async (req, res) => {
    try {
      const parsed = z
        .object({
          expectedVersion: id,
          confirmDeleteBothCompanies: z.literal(true),
        })
        .strict()
        .parse(req.body);
      const result = await deletePristineLinkedTrade(
        routeId.parse(req.params.tradeId),
        parsed.expectedVersion,
        actor(req)
      );
      return res.json(result);
    } catch (error) {
      return fail(res, error, "delete-linked");
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
