/**
 * orderVerifyRecoverRoutes: OrderVerify endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../../lib/httpHandlers";
import { parseId } from "../../../../lib/parseId";
import { getClientDate } from "../../../../lib/dateUtils";
import { logger } from "../../../../lib/logger";
import { sendWhatsAppFileToChatIdPos } from "../../../../services/whatsappService";
import { db } from "../../../../db";
import { requireAuth } from "../../../../auth";
import { writeDaybookEntry } from "../../_helpers";
import {
  factoryBales,
  customerOrders,
  customerOrderBales,
  customers,
  locations,
  factoryDaybookEntries,
} from "@shared/schema";
import { eq, and, sql } from "drizzle-orm";
import { buildOrderExcelBuffer } from "../orderHelpers";
import { toMoney } from "../../../../lib/money";

export function registerOrderVerifyRoutes(app: Express) {
  app.post("/api/factory/customer-orders/:id/verify", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const orderId = parseId(req.params.id);

      if (orderId === null) return res.status(400).json({ message: "Invalid id" });
      const { approved, notes } = req.body;

      const [order] = await db
        .select()
        .from(customerOrders)
        .where(and(eq(customerOrders.id, orderId), eq(customerOrders.companyId, companyId)));
      if (!order) return res.status(404).json({ message: "Order not found" });
      if (!["PENDING_VERIFICATION", "VERIFIED"].includes(order.status))
        return res.status(400).json({ message: "Only PENDING_VERIFICATION or VERIFIED orders can be verified" });

      if (approved) {
        const [updated] = await db
          .update(customerOrders)
          .set({
            status: "VERIFIED",
            verifiedAt: new Date(),
            containerNotes: notes || order.containerNotes,
            updatedAt: new Date(),
          })
          .where(eq(customerOrders.id, orderId))
          .returning();
        const [verifyCustomer] = await db
          .select({ legalName: customers.legalName })
          .from(customers)
          .where(eq(customers.id, order.customerId));
        // Use grandTotal (bales + all charges including surcharges), not just bale sum
        const verifyTotalValue = toMoney(updated?.grandTotal || order.grandTotal).toNumber();
        const verifyToday = getClientDate(req);
        await db
          .delete(factoryDaybookEntries)
          .where(
            and(
              eq(factoryDaybookEntries.companyId, companyId),
              eq(factoryDaybookEntries.txType, "ORDER_VERIFIED"),
              eq(factoryDaybookEntries.referenceId, orderId)
            )
          );
        await writeDaybookEntry(db, {
          companyId,
          txDate: verifyToday,
          txType: "ORDER_VERIFIED",
          referenceId: orderId,
          referenceTable: "customer_orders",
          description: `Order verified for customer: ${verifyCustomer?.legalName || "Customer"}${notes ? ` – ${notes}` : ""}`,
          amountCurrency: verifyTotalValue,
          amountUsd: verifyTotalValue,
        });
        res.json(updated);

        // Fire-and-forget: send the Commercial Invoice Excel file to the location's
        // WhatsApp group chat. Runs after the response so it never blocks the API.
        setImmediate(async () => {
          try {
            if (!order.locationId) return;
            const [loc] = await db
              .select({ whatsappGroupChatId: locations.whatsappGroupChatId })
              .from(locations)
              .where(eq(locations.id, order.locationId));
            if (!loc?.whatsappGroupChatId) return;

            const { buffer, fileName } = await buildOrderExcelBuffer(orderId, companyId, false);
            const [verifyBaleCountRow] = await db
              .select({ count: sql<number>`COUNT(*)::int` })
              .from(customerOrderBales)
              .where(eq(customerOrderBales.orderId, orderId));

            const captionParts: string[] = [
              `*Container Verified* ✓`,
              ``,
              `Order #${orderId}`,
              order.containerNumber ? `Container: ${order.containerNumber}` : null,
              `Customer: ${verifyCustomer?.legalName || "—"}`,
              `Bales loaded: ${verifyBaleCountRow?.count ?? 0}`,
              order.destination ? `Destination: ${order.destination}` : null,
              `Date: ${verifyToday}`,
              notes ? `Notes: ${notes}` : null,
            ].filter(Boolean) as string[];

            await sendWhatsAppFileToChatIdPos(
              loc.whatsappGroupChatId,
              buffer,
              fileName,
              captionParts.join("\n"),
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            );
            logger.info(
              `[verify-whatsapp] Sent Excel invoice ${fileName} to ${loc.whatsappGroupChatId} for order #${orderId}`
            );
          } catch (e: unknown) {
            logger.error("[verify-whatsapp] Failed to send Excel to WhatsApp:", { error: getErrorMessage(e) });
          }
        });
      } else {
        const [updated] = await db
          .update(customerOrders)
          .set({
            containerNotes: notes || order.containerNotes,
            updatedAt: new Date(),
          })
          .where(eq(customerOrders.id, orderId))
          .returning();
        res.json(updated);
      }
    } catch (error: unknown) {
      logger.error("Error verifying order:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/factory/customer-orders/:id/return-to-loading", requireAuth, async (req: Request, res: Response) => {
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
      if (!["PENDING_VERIFICATION", "VERIFIED"].includes(order.status))
        return res
          .status(400)
          .json({ message: "Only PENDING_VERIFICATION or VERIFIED orders can be returned to loading" });

      const [updated] = await db
        .update(customerOrders)
        .set({
          status: "LOADING",
          // Preserve the business loading date even when an order is reopened.
          // Only the status/verification timestamp is being reset here.
          verifiedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(customerOrders.id, orderId))
        .returning();

      // If the order was already VERIFIED, reverse the verification daybook entry.
      if (order.status === "VERIFIED") {
        await db
          .delete(factoryDaybookEntries)
          .where(
            and(
              eq(factoryDaybookEntries.companyId, companyId),
              eq(factoryDaybookEntries.txType, "ORDER_VERIFIED"),
              eq(factoryDaybookEntries.referenceId, orderId)
            )
          );
      }

      // V5 orders: revert bales from SOLD → RESERVED_FOR_ORDER so they can be re-scanned or edited.
      // Legacy (non-V5) orders keep bales in RESERVED_FOR_ORDER throughout, so no change needed.
      if (order.proformaIdUsed) {
        const bales = await db.select().from(customerOrderBales).where(eq(customerOrderBales.orderId, orderId));
        for (const b of bales) {
          await db
            .update(factoryBales)
            .set({ status: "RESERVED_FOR_ORDER", updatedAt: new Date() })
            .where(and(eq(factoryBales.id, b.baleId), eq(factoryBales.status, "SOLD")));
        }
      }

      res.json(updated);
    } catch (error: unknown) {
      logger.error("Error returning order to loading:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  // ── Update order date (DRAFT only) ────────────────────────────────────────
}
