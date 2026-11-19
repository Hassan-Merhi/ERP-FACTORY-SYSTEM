// Extracted from ./registerOrderCrudRoutesPart3.ts
import { logAudit } from "../../helpers/auditHelpers";
import { orderAuditIdentifier } from "./orderAuditIdentifier";
import { getErrorMessage, HttpError, sendHttpError } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { parseId } from "../../../lib/parseId";
import type { Express, Request, Response } from "express";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { customerOrderBales, customerOrders, factoryBales } from "@shared/schema";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { linkOrderProformaAtomically, LinkOrderProformaError } from "./linkProformaAtomic";

export function registerOrderCrudRoutesPart4(app: Express) {
  app.patch("/api/factory/customer-orders/:id/link-proforma", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const orderId = parseId(req.params.id);

      if (orderId === null) return res.status(400).json({ message: "Invalid id" });
      if (isNaN(orderId)) return res.status(400).json({ message: "Invalid order ID" });

      const { proformaId } = req.body;
      // proformaId may be null/0 to unlink
      const isUnlink = proformaId == null || proformaId === 0 || proformaId === "0";
      const proformaIdInt = isUnlink ? null : parseInt(proformaId);
      if (!isUnlink && (proformaIdInt === null || isNaN(proformaIdInt!)))
        return res.status(400).json({ message: "Invalid proformaId" });

      // Lock, checks and write run in one transaction (see linkProformaAtomic.ts):
      // a link made during loading is reference-only and re-linking the same
      // proforma keeps the order's expected plan.
      res.json(await linkOrderProformaAtomically({ companyId, orderId, proformaId: proformaIdInt }));
    } catch (error: unknown) {
      if (error instanceof LinkOrderProformaError) {
        return res.status(error.status).json(error.details ?? { message: error.message });
      }
      logger.error("Error linking proforma to loading:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // PATCH /api/factory/customer-orders/:id/loading-note — update the free-text
  // note on a loading order (works on any non-cancelled status so floor staff
  // can add or edit notes at any point during the loading lifecycle).
  app.patch("/api/factory/customer-orders/:id/loading-note", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const orderId = parseId(req.params.id);

      if (orderId === null) return res.status(400).json({ message: "Invalid id" });
      const { note } = req.body;

      const [order] = await db
        .select()
        .from(customerOrders)
        .where(and(eq(customerOrders.id, orderId), eq(customerOrders.companyId, companyId)));
      if (!order) return res.status(404).json({ message: "Loading not found" });

      // Phase 21 (B): the write and its audit commit together.
      const updated = await db.transaction(async (tx) => {
        const [written] = await tx
          .update(customerOrders)
          .set({ containerNotes: note?.trim() || null, updatedAt: new Date() })
          .where(eq(customerOrders.id, orderId))
          .returning();

        await logAudit(
          {
            userId: req.session.userId!,
            username: req.session.username || req.session.userId!,
            companyId,
            action: "update",
            tableName: "factory_customer_orders",
            recordId: orderId,
            recordIdentifier: orderAuditIdentifier(order, orderId),
            changes: { loadingNote: { old: order.containerNotes ?? null, new: note?.trim() || null } },
          },
          tx
        );
        return written;
      });
      res.json({ success: true, order: updated });
    } catch (error: unknown) {
      logger.error("Error updating loading note:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.delete("/api/factory/customer-orders/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const orderId = parseId(req.params.id);

      if (orderId === null) return res.status(400).json({ message: "Invalid id" });

      await db.transaction(async (tx) => {
        const [order] = await tx
          .select()
          .from(customerOrders)
          .where(
            and(
              eq(customerOrders.id, orderId),
              eq(customerOrders.companyId, companyId),
              isNull(customerOrders.deletedAt)
            )
          )
          .for("update");
        // Both conditions are caller errors, and throwing plain Errors from
        // inside the transaction meant the catch reported them as 500s. The
        // checks stay inside the transaction so the row stays locked between
        // the read and the soft-delete.
        if (!order) throw new HttpError(404, "Order not found");

        if (order.status === "FINALIZED") {
          throw new HttpError(409, "Cannot delete a finalized invoice. Cancel it first if needed.");
        }

        // Soft-delete: release bales back to stock so they can be re-sold,
        // but preserve order/lines/charges/bale links so the order can be
        // restored from Settings → Deleted Items (note: bales currently in
        // stock will need to be re-reserved manually after restore).
        const bales = await tx
          .select({ baleId: customerOrderBales.baleId })
          .from(customerOrderBales)
          .where(eq(customerOrderBales.orderId, orderId));
        const baleIds = [
          ...new Set(bales.map((b) => b.baleId).filter((id): id is number => Number.isSafeInteger(id) && id > 0)),
        ];
        // A soft-deleted loading is no longer an active allocation. Release its
        // physical bales, but never make a bale available when a different
        // non-deleted order still owns it (e.g. an already verified invoice).
        if (baleIds.length > 0) {
          await tx
            .update(factoryBales)
            .set({ status: "IN_STOCK", updatedAt: new Date() })
            .where(
              and(
                eq(factoryBales.companyId, companyId),
                isNull(factoryBales.deletedAt),
                inArray(factoryBales.id, baleIds),
                sql`NOT EXISTS (
                SELECT 1 FROM customer_order_bales cob
                JOIN customer_orders co ON co.id = cob.order_id
                WHERE cob.bale_id = ${factoryBales.id}
                  AND co.company_id = ${companyId}
                  AND co.id <> ${orderId}
                  AND co.deleted_at IS NULL
                  AND co.status <> 'CANCELLED'
              )`
              )
            );
        }

        await tx
          .update(customerOrders)
          .set({ deletedAt: new Date(), updatedAt: new Date() })
          .where(
            and(
              eq(customerOrders.id, orderId),
              eq(customerOrders.companyId, companyId),
              isNull(customerOrders.deletedAt)
            )
          );
        await logAudit(
          {
            userId: req.session.userId!,
            username: req.session.username || req.session.userId!,
            companyId,
            action: "delete",
            tableName: "factory_customer_orders",
            recordId: orderId,
            recordIdentifier: `Order #${orderId}`,
            changes: null,
          },
          tx
        );
      });

      res.json({ success: true, message: "Order moved to Deleted Items; eligible bales returned to stock" });
    } catch (error: unknown) {
      logger.error("Error deleting customer order:", { error: error });
      sendHttpError(res, error);
    }
  });
}
