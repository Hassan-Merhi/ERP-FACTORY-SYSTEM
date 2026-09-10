/**
 * baleScanningRoutes: OrderBaleExchange endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../../lib/httpHandlers";
import { logger } from "../../../../lib/logger";
import { parseId } from "../../../../lib/parseId";
import { db } from "../../../../db";
import { requireAuth } from "../../../../auth";
import { recalculateOrderTotals } from "../../_helpers";
import { getProformaCapacitySnapshot } from "../proformaCapacity";
import { acquireProformaCapacityTransactionLock } from "../proformaCapacityConcurrency";
import { evaluateProformaArticleCapacity } from "../proformaCapacityEnforcement";
import {
  factoryBaleProducts,
  factoryBales,
  customerOrders,
  customerOrderLines,
  customerOrderBales,
  customerOrderCharges,
  customerOrderBaleRemovals,
} from "@shared/schema";
import { eq, and, or, desc, sql } from "drizzle-orm";
import { firstRow, resultRows } from "../../../../lib/queryResult";

export function registerOrderBaleExchangeRoutes(app: Express) {
  // POST /api/factory/customer-orders/:id/bales/exchange — swap one bale for another on a FINALIZED order
  app.post("/api/factory/customer-orders/:id/bales/exchange", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const orderId = parseId(req.params.id);

      if (orderId === null) return res.status(400).json({ message: "Invalid id" });
      const { orderBaleId, newBaleReference } = req.body;
      if (!orderBaleId || !newBaleReference?.trim()) {
        return res.status(400).json({ message: "orderBaleId and newBaleReference are required" });
      }

      await db.transaction(async (tx) => {
        const [order] = await tx
          .select()
          .from(customerOrders)
          .where(and(eq(customerOrders.id, orderId), eq(customerOrders.companyId, companyId)));
        if (!order) throw new Error("Order not found");
        if (!["FINALIZED", "VERIFIED"].includes(order.status)) {
          throw new Error("Bale exchange is only allowed on FINALIZED or VERIFIED orders");
        }

        // All capacity-changing writers use the same ordering: proforma lock
        // first, then order/bale row locks. A concurrent scan/import for this
        // proforma must therefore wait and re-read capacity after this swap.
        if (order.proformaIdUsed) {
          await acquireProformaCapacityTransactionLock(tx, {
            companyId,
            proformaId: order.proformaIdUsed,
          });
        }

        // Find and lock the customerOrderBales row to replace so two exchange
        // requests cannot both replace the same source row.
        const [oldOrderBale] = await tx
          .select()
          .from(customerOrderBales)
          .where(and(eq(customerOrderBales.id, orderBaleId), eq(customerOrderBales.orderId, orderId)))
          .for("update");
        if (!oldOrderBale) throw new Error("Bale not found in this order");

        // Find the new bale in stock — FOR UPDATE prevents a concurrent
        // exchange or sale from grabbing the same physical bale.
        const newRef = newBaleReference.trim();
        const [newBale] = await tx
          .select()
          .from(factoryBales)
          .where(
            and(
              eq(factoryBales.companyId, companyId),
              eq(factoryBales.status, "IN_STOCK"),
              or(eq(factoryBales.referenceNumber, newRef), eq(factoryBales.baleCode, newRef))
            )
          )
          .for("update");
        if (!newBale) throw new Error(`Bale "${newRef}" not found in stock or not available`);

        // V5 loadings keep bales IN_STOCK while loading. Status alone therefore
        // cannot prove this replacement bale is unused.
        const activeLink = firstRow(
          await tx.execute(sql`
            SELECT cob.order_id
            FROM customer_order_bales cob
            JOIN customer_orders co ON co.id = cob.order_id
            WHERE cob.bale_id = ${newBale.id}
              AND co.status <> 'CANCELLED'
              AND co.deleted_at IS NULL
            LIMIT 1
          `)
        );
        if (activeLink) {
          throw new Error(`Bale "${newRef}" is already linked to another active loading/order`);
        }

        // Resolve product name for new bale
        let newBaleName = newBale.productName || newBale.articleCode || newBale.baleCode || "";
        if (newBale.productId) {
          const [prod] = await tx
            .select({ name: factoryBaleProducts.name })
            .from(factoryBaleProducts)
            .where(eq(factoryBaleProducts.id, newBale.productId));
          if (prod?.name) newBaleName = prod.name;
        }
        const effectiveArticleCode = String(newBale.articleCode || oldOrderBale.articleCode || "").trim();

        // Remove the old capacity contribution first. If the new article is not
        // allowed, throwing below rolls this deletion and the status change back.
        await tx
          .update(factoryBales)
          .set({ status: "IN_STOCK", updatedAt: new Date() })
          .where(eq(factoryBales.id, oldOrderBale.baleId));
        await tx.delete(customerOrderBales).where(eq(customerOrderBales.id, orderBaleId));

        if (order.proformaIdUsed) {
          const capacity = await getProformaCapacitySnapshot(tx, {
            companyId,
            proformaId: order.proformaIdUsed,
            currentOrderId: orderId,
          });
          if (!capacity) throw new Error("Linked proforma is unavailable");
          const decision = evaluateProformaArticleCapacity(capacity, effectiveArticleCode, 1);
          if (!decision.allowed) {
            throw new Error(
              decision.reason === "not_in_proforma"
                ? `Replacement article ${effectiveArticleCode || "UNKNOWN"} is not requested on the linked proforma`
                : `Replacement article ${effectiveArticleCode || "UNKNOWN"} exceeds proforma quantity (${decision.consumedQty}/${decision.requestedQty})`
            );
          }
        }

        // Insert new order bale row (preserve price from the row being replaced)
        await tx.insert(customerOrderBales).values({
          orderId,
          baleId: newBale.id,
          baleReference: newBale.referenceNumber || newRef,
          locationId: oldOrderBale.locationId,
          weight: newBale.weightKg,
          articleCode: effectiveArticleCode || oldOrderBale.articleCode,
          baleName: newBaleName || oldOrderBale.baleName,
          priceUsed: oldOrderBale.priceUsed,
        });

        // Mark new bale as sold (same status as other finalized bales)
        await tx
          .update(factoryBales)
          .set({ status: "SOLD", updatedAt: new Date() })
          .where(eq(factoryBales.id, newBale.id));

        await recalculateOrderTotals(tx, orderId);
      });

      const [updatedOrder] = await db.select().from(customerOrders).where(eq(customerOrders.id, orderId));
      const updatedBales = await db.select().from(customerOrderBales).where(eq(customerOrderBales.orderId, orderId));
      const updatedLines = await db.select().from(customerOrderLines).where(eq(customerOrderLines.orderId, orderId));
      const updatedCharges = await db
        .select()
        .from(customerOrderCharges)
        .where(eq(customerOrderCharges.orderId, orderId));
      res.json({ ...updatedOrder, bales: updatedBales, lines: updatedLines, charges: updatedCharges });
    } catch (error: unknown) {
      logger.error("Exchange bale error:", { error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // GET removal log for a specific order/loading. includeScanAudit=1 reuses
  // this existing route so the route manifest stays unchanged.
  app.get("/api/factory/customer-orders/:id/bale-removals", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const orderId = parseId(req.params.id);
      if (orderId === null) return res.status(400).json({ message: "Invalid id" });
      const [order] = await db
        .select()
        .from(customerOrders)
        .where(and(eq(customerOrders.id, orderId), eq(customerOrders.companyId, companyId)));
      if (!order) return res.status(404).json({ message: "Order not found" });

      if (req.query.includeScanAudit === "1") {
        const auditResult = await db.execute(
          sql`SELECT id,
                     scanned_by AS "scannedBy",
                     scanned_at AS "scannedAt"
              FROM customer_order_bales
              WHERE order_id = ${orderId}
              ORDER BY id`
        );
        const scanAudit = resultRows(auditResult).map((row) => ({
          id: Number(row.id),
          scannedBy: row.scannedBy ?? null,
          scannedAt: row.scannedAt ?? null,
        }));
        return res.json({ scanAudit });
      }

      const removals = await db
        .select()
        .from(customerOrderBaleRemovals)
        .where(eq(customerOrderBaleRemovals.orderId, orderId))
        .orderBy(desc(customerOrderBaleRemovals.removedAt));
      res.json(removals);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
