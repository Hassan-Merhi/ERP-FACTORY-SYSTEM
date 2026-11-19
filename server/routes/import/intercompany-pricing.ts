/** Phase 3 API for linked purchase-order edits and shared invoice allocations. */
import type { Express, Request, Response } from "express";
import { z } from "zod";
import { and, eq, or, inArray } from "drizzle-orm";
import { containers, intercompanyTrades, intercompanyImportBatchContainers } from "@shared/schema";
import { requireAuth } from "../../auth";
import { db } from "../../db";
import { logger } from "../../lib/logger";
import {
  assertTradeAccess,
  editLinkedTrade,
  getTradeDetail,
  IntercompanyEditError,
  type EditIdentity,
  withTradeScope,
} from "../../services/intercompany/tradeSync";
import { grantSharedChargeEditor, revokeSharedChargeEditor } from "../../services/intercompany/sharedChargePermissions";
import {
  confirmSharedCharge,
  previewSharedChargeAllocation,
  reviseSharedCharge,
  sharedInvoiceDetail,
} from "../../services/intercompany/sharedChargeSync";

const positive = z.number().int().positive();
const numberId = z.coerce.number().int().positive();
const cents = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/)
  .max(28);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const requestKey = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);
const reason = z.string().trim().min(3).max(1000);
const alloc = z
  .object({
    tradeId: positive,
    expectedVersion: positive,
    amount: cents,
  })
  .strict();
const edit = z
  .object({
    expectedVersion: positive,
    requestKey,
    postingDate: date,
    reason,
    lines: z
      .array(
        z
          .object({
            lineLinkId: positive,
            quantity: z.string().min(1).max(40),
            rate: z.string().min(1).max(40),
            itemName: z.string().trim().min(1).max(300),
          })
          .strict()
      )
      .min(1)
      .max(3000),
  })
  .strict();
const preview = z
  .object({
    sourceCompanyId: positive,
    tradeIds: z.array(positive).min(1).max(100),
    amount: cents,
  })
  .strict();
const confirm = z
  .object({
    sourceCompanyId: positive,
    invoiceKey: z.string().min(3).max(120),
    chargeType: z.enum(["freight", "surcharge", "fumigation", "documentCharges", "otherCharges"]),
    faceAmount: cents,
    evidenceReference: z.string().min(3).max(500),
    postingDate: date,
    reason,
    requestKey,
    allocations: z.array(alloc).min(1).max(100),
  })
  .strict();
const grant = z
  .object({
    userId: z.string().trim().min(1).max(128),
    relationshipId: positive,
    scope: z.enum(["invoice", "relationship"]),
    invoiceKey: z.string().min(3).max(120).optional(),
  })
  .strict();
const reallocate = z
  .object({
    expectedInvoiceVersion: positive,
    postingDate: date,
    reason,
    requestKey,
    allocations: z.array(alloc).min(1).max(100),
  })
  .strict();

function identity(req: Request): EditIdentity {
  const id = Number(req.session.currentCompanyId);
  if (!Number.isSafeInteger(id) || id < 1 || !req.session.userId) {
    throw new IntercompanyEditError("IC_EDIT_SESSION", "Choose a company and sign in", 403);
  }
  return {
    initiatingCompanyId: id,
    actorUserId: String(req.session.userId),
    actorRole: String(req.session.currentRole || ""),
  };
}
function failure(res: Response, error: unknown) {
  if (error instanceof IntercompanyEditError) {
    return res.status(error.status).json({ code: error.code, message: error.message });
  }
  if (error instanceof z.ZodError) {
    return res.status(422).json({ code: "IC_EDIT_INPUT", message: error.issues.map((i) => i.message).join("; ") });
  }
  logger.error("Intercompany Phase 3 edit failed", { error });
  return res
    .status(500)
    .json({ code: "IC_EDIT_INTERNAL", message: "Linked edit was not committed. Review and retry." });
}
function idParam(value: unknown) {
  return numberId.parse(value);
}
export function registerIntercompanyPhase3Routes(app: Express) {
  /** Current company can see its own container trades, even if it is the destination. */
  app.get("/api/intercompany-container-trading/linked-trades", requireAuth, async (req, res) => {
    try {
      const actor = identity(req);
      const physicalContainerId =
        req.query.physicalContainerId === undefined
          ? undefined
          : z.coerce.number().int().positive().parse(req.query.physicalContainerId);
      if (!["Owner", "Admin", "Developer"].includes(actor.actorRole)) {
        return res.status(403).json({ message: "Financial edit permission required" });
      }
      const trades = await db
        .select()
        .from(intercompanyTrades)
        .where(
          and(
            or(
              eq(intercompanyTrades.sourceCompanyId, actor.initiatingCompanyId),
              eq(intercompanyTrades.destinationCompanyId, actor.initiatingCompanyId)
            ),
            eq(intercompanyTrades.state, "active"),
            physicalContainerId ? eq(intercompanyTrades.physicalContainerId, physicalContainerId) : undefined
          )
        )
        .limit(200);
      if (!trades.length) return res.json({ trades: [] });
      await assertTradeAccess(trades[0].id, actor);
      return await withTradeScope(
        actor,
        trades.flatMap((t) => [t.sourceCompanyId, t.destinationCompanyId]),
        async () => {
          const [physical, amounts] = await Promise.all([
            db
              .select({ id: containers.id, containerNumber: containers.containerNumber })
              .from(containers)
              .where(
                inArray(
                  containers.id,
                  trades.map((t) => t.physicalContainerId)
                )
              ),
            db
              .select({
                tradeId: intercompanyImportBatchContainers.tradeId,
                cost: intercompanyImportBatchContainers.confirmedLandedCost,
              })
              .from(intercompanyImportBatchContainers)
              .where(
                inArray(
                  intercompanyImportBatchContainers.tradeId,
                  trades.map((t) => t.id)
                )
              ),
          ]);
          return res.json({
            trades: trades.map((t) => ({
              tradeId: t.id,
              physicalContainerId: t.physicalContainerId,
              version: t.version,
              sourceCompanyId: t.sourceCompanyId,
              destinationCompanyId: t.destinationCompanyId,
              containerNumber: physical.find((p) => p.id === t.physicalContainerId)?.containerNumber ?? "Unresolved",
              landedCost: amounts.find((a) => a.tradeId === t.id)?.cost ?? null,
              destinationPoId: t.destinationPoId,
            })),
          });
        }
      );
    } catch (error) {
      return failure(res, error);
    }
  });
  app.get("/api/intercompany-container-trading/linked-trades/:tradeId", requireAuth, async (req, res) => {
    try {
      return res.json(await getTradeDetail(idParam(req.params.tradeId), identity(req)));
    } catch (error) {
      return failure(res, error);
    }
  });
  app.patch("/api/intercompany-container-trading/linked-trades/:tradeId", requireAuth, async (req, res) => {
    try {
      const submitted = edit.parse(req.body);
      const result = await editLinkedTrade({ ...submitted, tradeId: idParam(req.params.tradeId) }, identity(req));
      return res.json(result);
    } catch (error) {
      return failure(res, error);
    }
  });
  app.post("/api/intercompany-container-trading/shared-charges/preview", requireAuth, async (req, res) => {
    try {
      return res.json(await previewSharedChargeAllocation(preview.parse(req.body), identity(req)));
    } catch (error) {
      return failure(res, error);
    }
  });
  app.post("/api/intercompany-container-trading/shared-charges/confirm", requireAuth, async (req, res) => {
    try {
      const result = await confirmSharedCharge(confirm.parse(req.body), identity(req));
      return res.status(201).json(result);
    } catch (error) {
      return failure(res, error);
    }
  });
  app.get("/api/intercompany-container-trading/shared-charges/:invoiceId", requireAuth, async (req, res) => {
    try {
      return res.json(await sharedInvoiceDetail(idParam(req.params.invoiceId), identity(req)));
    } catch (error) {
      return failure(res, error);
    }
  });
  app.patch("/api/intercompany-container-trading/shared-charges/:invoiceId", requireAuth, async (req, res) => {
    try {
      return res.json(
        await reviseSharedCharge(
          {
            ...reallocate.parse(req.body),
            invoiceId: idParam(req.params.invoiceId),
          },
          identity(req)
        )
      );
    } catch (error) {
      return failure(res, error);
    }
  });
  app.post("/api/intercompany-container-trading/shared-charge-grants", requireAuth, async (req, res) => {
    try {
      return res.status(201).json(await grantSharedChargeEditor(grant.parse(req.body), identity(req)));
    } catch (error) {
      return failure(res, error);
    }
  });
  app.post(
    "/api/intercompany-container-trading/shared-charge-grants/:grantId/revoke",
    requireAuth,
    async (req, res) => {
      try {
        return res.json(await revokeSharedChargeEditor(idParam(req.params.grantId), identity(req)));
      } catch (error) {
        return failure(res, error);
      }
    }
  );
}
