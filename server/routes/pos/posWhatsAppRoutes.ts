import { type Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { db } from "../../db";
import { requireAuth } from "../../auth";
import { locations, posShifts, inventory, stockItems, stockGroups, userCompanyRoles } from "@shared/schema";
import { eq, and, desc, asc, gte } from "drizzle-orm";
import { format } from "date-fns";
import { sendWhatsAppTextToChatIdPos } from "../../services/whatsappService";
import { toMoney } from "../../lib/money";

export function registerPosWhatsAppRoutes(app: Express): void {
  // ── POS WhatsApp Shift Report ─────────────────────────────────────────────
  app.post("/api/pos/send-shift-report", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const userId = req.session.userId!;

      // Determine location — POS users have an assigned location; admin can pass locationId
      let locationId: number | null = null;
      if (req.body.locationId) {
        locationId = parseInt(req.body.locationId as string);
      } else {
        const ucr = await db
          .select({ assignedLocationId: userCompanyRoles.assignedLocationId })
          .from(userCompanyRoles)
          .where(and(eq(userCompanyRoles.userId, userId), eq(userCompanyRoles.companyId, companyId)))
          .limit(1);
        locationId = ucr[0]?.assignedLocationId ?? null;
      }

      if (!locationId) return res.status(400).json({ message: "No location found for this user" });

      // Fetch location record (includes whatsapp_group_chat_id)
      const [location] = await db
        .select()
        .from(locations)
        .where(and(eq(locations.id, locationId), eq(locations.companyId, companyId)))
        .limit(1);

      if (!location) return res.status(404).json({ message: "Location not found" });

      if (!location.whatsappGroupChatId) {
        return res.status(400).json({ message: "WhatsApp group not configured for this location" });
      }

      // Fetch current stock for this location
      const stockRows = await db
        .select({
          name: stockItems.name,
          unit: stockItems.uom,
          quantity: inventory.quantity,
          groupName: stockGroups.name,
        })
        .from(inventory)
        .innerJoin(stockItems, eq(inventory.stockItemId, stockItems.id))
        .leftJoin(stockGroups, eq(stockItems.stockGroupId, stockGroups.id))
        .where(and(eq(inventory.locationId, locationId), eq(inventory.companyId, companyId)))
        .orderBy(asc(stockGroups.name), asc(stockItems.name));

      // Fetch today's open or most-recently-closed shift for context
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const shifts = await db
        .select()
        .from(posShifts)
        .where(
          and(eq(posShifts.locationId, locationId), eq(posShifts.companyId, companyId), gte(posShifts.openedAt, today))
        )
        .orderBy(desc(posShifts.openedAt))
        .limit(1);

      const shift = shifts[0] ?? null;
      const now = new Date();
      const dateStr = format(now, "dd MMM yyyy, h:mm a");

      // Build grouped stock lines
      let lastGroup = "";
      const stockLines: string[] = [];
      for (const row of stockRows) {
        const qty = toMoney(row.quantity).toNumber();
        const group = row.groupName ?? "General";
        if (group !== lastGroup) {
          stockLines.push(`\n*${group}*`);
          lastGroup = group;
        }
        const flag = qty < 0 ? " ⚠️" : "";
        const unitLabel = row.unit ? ` ${row.unit}` : "";
        stockLines.push(`  • ${row.name}: ${qty.toLocaleString()}${unitLabel}${flag}`);
      }

      const stockSection = stockLines.length ? stockLines.join("\n") : "  No stock data available";

      const salesLine = shift
        ? `*Sales Today:* ${shift.salesCount ?? 0} transactions | ${toMoney(shift.salesTotal).toNumber().toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        : "";

      const senderName = req.user?.username || userId;

      const message = [
        `📍 *${location.name} — Stock Report*`,
        `🕐 Sent by ${senderName} on ${dateStr}`,
        ``,
        `*Current Stock:*${stockSection}`,
        ``,
        salesLine,
      ]
        .filter((l) => l !== undefined)
        .join("\n")
        .trim();

      const result = await sendWhatsAppTextToChatIdPos(location.whatsappGroupChatId, message);
      if (!result.success) {
        return res.status(502).json({ message: result.error ?? "Failed to send WhatsApp message" });
      }

      res.json({ success: true, message: "Stock report sent to WhatsApp" });
    } catch (error: unknown) {
      logger.error("[/api/pos/send-shift-report]", {
        locationId: req.body.locationId,
        chatId: (error as { chatId: unknown })?.chatId ?? undefined,
        error: getErrorMessage(error) ?? error,
      });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
