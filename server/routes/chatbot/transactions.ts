/**
 * chatbotRoutes: ChatbotTransaction endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { db } from "../../db";
import { requireAuth, requireNonPOS } from "../../auth";
import { clearERPContextCache } from "../../chatService";
import { inventory, stockItems, locations } from "@shared/schema";
import { eq, and, isNull } from "drizzle-orm";
import { requireAIActionPermission, logAIAction } from "../../lib/aiActionPermission";
import { toMoney } from "../../lib/money";
import { registerChatbotTransactionRoutesPart1 } from "./registerChatbotTransactionRoutesPart1";

export function registerChatbotTransactionRoutes(app: Express) {
  // ── Confirm Stock Transfer ────────────────────────────────────────────
  app.post("/api/chatbot/confirm-stock-transfer", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      const userId = req.session.userId;
      if (!companyId || !userId) return res.status(400).json({ message: "No company selected" });

      const denied = await requireAIActionPermission(req, "write");
      if (denied) return res.status(denied.code).json({ message: denied.message });

      const {
        date,
        sourceLocationId,
        destinationLocationId,
        notes,
        items,
        optional,
        analysisSummary,
        analysisDateRange,
      } = req.body;
      // Preserve the pre-existing direct/manual chatbot transfer behavior (real transfer,
      // inventory moves immediately) unless the caller explicitly opts into an optional
      // (AI-suggested, non-posting) transfer by sending optional:true. This keeps the
      // long-standing direct "transfer N of X from A to B" flow byte-for-byte unchanged.
      const isOptional = optional === true;

      if (!sourceLocationId || !destinationLocationId)
        return res.status(400).json({ message: "Source and destination locations are required" });
      if (!items?.length) return res.status(400).json({ message: "At least one item is required" });
      if (Number(sourceLocationId) === Number(destinationLocationId))
        return res.status(400).json({ message: "Source and destination must be different" });

      // ── Revalidate before creating anything (never trust the AI-produced numbers) ──
      const [srcLocRow, destLocRow] = await Promise.all([
        db
          .select({ id: locations.id })
          .from(locations)
          .where(and(eq(locations.id, Number(sourceLocationId)), eq(locations.companyId, companyId)))
          .limit(1),
        db
          .select({ id: locations.id })
          .from(locations)
          .where(and(eq(locations.id, Number(destinationLocationId)), eq(locations.companyId, companyId)))
          .limit(1),
      ]);
      if (!srcLocRow[0]) return res.status(404).json({ message: "Source location not found" });
      if (!destLocRow[0]) return res.status(404).json({ message: "Destination location not found" });

      for (const i of items) {
        const stockItemId = Number(i.stockItemId);
        const qty = Number(i.quantity);
        if (!stockItemId || isNaN(qty) || qty <= 0) {
          return res.status(400).json({ message: `Invalid item or quantity: ${JSON.stringify(i)}` });
        }
        const [itemRow] = await db
          .select({ id: stockItems.id })
          .from(stockItems)
          .where(and(eq(stockItems.id, stockItemId), eq(stockItems.companyId, companyId), isNull(stockItems.deletedAt)))
          .limit(1);
        if (!itemRow) return res.status(404).json({ message: `Stock item ${stockItemId} not found` });

        // Insufficient-stock enforcement only applies to AI-suggested (optional) drafts —
        // the pre-existing direct/manual chatbot transfer flow (optional:false) forwards to
        // /api/stock-transfers exactly as before, which already owns its own validation and
        // allows the same explicit negative-inventory override the manual UI supports.
        if (isOptional) {
          const [invRow] = await db
            .select({ quantity: inventory.quantity })
            .from(inventory)
            .where(
              and(
                eq(inventory.stockItemId, stockItemId),
                eq(inventory.locationId, Number(sourceLocationId)),
                eq(inventory.companyId, companyId)
              )
            )
            .limit(1);
          const currentStock = toMoney(invRow?.quantity).toNumber();
          // AI-driven confirmation must never authorize negative inventory; that override
          // stays a manual, explicit user action on the normal stock transfer screen.
          if (qty > currentStock) {
            return res.status(400).json({
              message: `Quantity ${qty} for stock item ${stockItemId} exceeds available stock (${currentStock})`,
            });
          }
        }
      }

      const resp = await fetch(`http://localhost:${process.env.PORT || 5000}/api/stock-transfers`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: req.headers.cookie || "" },
        body: JSON.stringify({
          sourceLocationId: Number(sourceLocationId),
          destinationLocationId: Number(destinationLocationId),
          notes: notes || "",
          voucherDate: date || new Date().toISOString().split("T")[0],
          optional: isOptional,
          items: items.map((i: Record<string, unknown>) => ({
            stockItemId: Number(i.stockItemId),
            quantity: String(i.quantity),
            sourceLocationId: Number(sourceLocationId),
          })),
        }),
      });
      const data = await resp.json();
      if (!resp.ok) return res.status(resp.status).json(data);

      const createdVoucherId = data.voucher?.id ?? data.voucherId ?? null;
      const createdTransferId = data.transfer?.id ?? data.id ?? null;

      // Write audit log via centralised helper
      await logAIAction({
        req,
        actionType: "write",
        actionName: "stock_transfer",
        inputJson: {
          sourceLocationId,
          destinationLocationId,
          date,
          notes,
          itemCount: items?.length ?? 0,
          optional: isOptional,
          analysisSummary: analysisSummary || null,
          analysisDateRange: analysisDateRange || null,
        },
        outputJson: { transferId: createdTransferId, voucherId: createdVoucherId },
        status: "success",
        createdRecordId: createdTransferId || createdVoucherId || null,
      });

      clearERPContextCache(companyId);
      res.json({
        success: true,
        transferId: createdTransferId,
        voucherId: createdVoucherId,
        optional: isOptional,
        voucher: data.voucher,
      });
    } catch (error: unknown) {
      logger.error("[Chatbot] confirm-stock-transfer error:", { error: getErrorMessage(error) });
      res.status(500).json({ message: "Internal server error" });
    }
  });

  registerChatbotTransactionRoutesPart1(app);
}
