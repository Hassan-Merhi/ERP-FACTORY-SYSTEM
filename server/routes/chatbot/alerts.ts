/**
 * chatbotRoutes: ChatbotAlert endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { db } from "../../db";
import { requireAuth, requireNonPOS } from "../../auth";
import { inventory, stockItems, purchaseOrders, customers, customerBalances, users, aiActionLog } from "@shared/schema";
import { eq, and, sql } from "drizzle-orm";
import { requireAIActionPermission } from "../../lib/aiActionPermission";

export function registerChatbotAlertRoutes(app: Express) {
  // ── PROACTIVE ALERTS DIGEST (5a) ──
  app.get("/api/chatbot/alerts", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      // Low stock items
      const inventoryRows = await db
        .select({ stockItemId: inventory.stockItemId, quantity: inventory.quantity })
        .from(inventory)
        .where(eq(inventory.companyId, companyId));

      const stockRows = await db
        .select({
          id: stockItems.id,
          name: stockItems.name,
          code: stockItems.code,
          reorderLevel: stockItems.reorderLevel,
        })
        .from(stockItems)
        .where(and(eq(stockItems.companyId, companyId), eq(stockItems.active, true)));

      const invMap = new Map(inventoryRows.map((i) => [i.stockItemId, parseFloat(i.quantity || "0")]));
      const lowStock = stockRows
        .filter((s) => {
          const lvl = parseFloat(s.reorderLevel || "0");
          return lvl > 0 && (invMap.get(s.id) || 0) <= lvl;
        })
        .map((s) => ({
          id: s.id,
          name: s.name,
          code: s.code,
          qty: invMap.get(s.id) || 0,
          reorderLevel: parseFloat(s.reorderLevel || "0"),
        }));

      // Open POs (awaiting)
      const openPOs = await db
        .select({
          id: purchaseOrders.id,
          poNumber: purchaseOrders.poNumber,
          supplierId: purchaseOrders.supplierId,
          status: purchaseOrders.status,
        })
        .from(purchaseOrders)
        .where(and(eq(purchaseOrders.companyId, companyId), eq(purchaseOrders.status, "Open")));

      // Customer receivables (overdue balances > 0)
      const customerBalanceRows = await db
        .select({
          customerId: customerBalances.customerId,
          totalDebit: sql<string>`COALESCE(SUM(CAST(${customerBalances.debitAmount} AS NUMERIC)), 0)`,
          totalCredit: sql<string>`COALESCE(SUM(CAST(${customerBalances.creditAmount} AS NUMERIC)), 0)`,
        })
        .from(customerBalances)
        .where(eq(customerBalances.companyId, companyId))
        .groupBy(customerBalances.customerId);

      const customerRows = await db
        .select({ id: customers.id, legalName: customers.legalName })
        .from(customers)
        .where(eq(customers.companyId, companyId));
      const custMap = new Map(customerRows.map((c) => [c.id, c.legalName]));

      const overdueCustomers = customerBalanceRows
        .map((cb) => {
          const balance = parseFloat(cb.totalDebit) - parseFloat(cb.totalCredit);
          return { customerId: cb.customerId, name: custMap.get(cb.customerId) || "Unknown", balance };
        })
        .filter((c) => c.balance > 0.01)
        .slice(0, 10);

      // Pending payrolls (DRAFT status in factory_payrolls)
      let pendingPayrolls: unknown[] = [];
      try {
        const { factoryPayrolls } = await import("@shared/schema");
        pendingPayrolls = await db
          .select({
            id: factoryPayrolls.id,
            periodStart: factoryPayrolls.periodStart,
            periodEnd: factoryPayrolls.periodEnd,
            status: factoryPayrolls.status,
          })
          .from(factoryPayrolls)
          .where(and(eq(factoryPayrolls.companyId, companyId), eq(factoryPayrolls.status, "DRAFT")))
          .limit(5);
      } catch (_) {
        // Failure here is non-fatal and the surrounding flow continues deliberately.
      }

      res.json({
        lowStock: lowStock.slice(0, 10),
        openPOs: openPOs.slice(0, 10),
        overdueCustomers,
        pendingPayrolls,
      });
    } catch (_error: unknown) {
      res.status(500).json({ message: "Internal server error" });
    }
  });

  // Toggle chatbot for a user (Admin/Owner only)
  app.patch("/api/users/:userId/chatbot", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const userRole = req.session.currentRole;

      // Only Admin/Owner can toggle chatbot
      if (userRole !== "Admin" && userRole !== "Owner" && userRole !== "Developer") {
        return res.status(403).json({ message: "Access denied" });
      }

      const { userId } = req.params;
      const { enabled } = req.body;
      if (typeof enabled !== "boolean") {
        return res.status(400).json({ message: "enabled must be a boolean" });
      }

      await db.update(users).set({ chatbotEnabled: enabled }).where(eq(users.id, userId));

      res.json({ message: `Chatbot ${enabled ? "enabled" : "disabled"} for user` });
    } catch (_error: unknown) {
      res.status(500).json({ message: "Internal server error" });
    }
  });

  // Get users with their chatbot status (Admin/Owner only)
  app.get("/api/users/chatbot-status", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const userRole = req.session.currentRole;

      if (userRole !== "Admin" && userRole !== "Owner" && userRole !== "Developer") {
        return res.status(403).json({ message: "Access denied" });
      }

      const allUsers = await db
        .select({
          id: users.id,
          username: users.username,
          chatbotEnabled: users.chatbotEnabled,
          active: users.active,
        })
        .from(users)
        .where(eq(users.active, true));

      res.json(allUsers);
    } catch (_error: unknown) {
      res.status(500).json({ message: "Internal server error" });
    }
  });

  // ── AI Action Audit Log endpoint ────────────────────────────────────
  app.post("/api/chatbot/log-action", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId;
      const companyId = req.session.currentCompanyId;
      if (!userId || !companyId) return res.status(400).json({ message: "No company selected" });

      const { sessionId, prompt, draftJson, actionType, actionName, createdRecordId, status } = req.body;

      // Determine permission tier from client-supplied actionType
      const tier: "read" | "draft" | "write" =
        actionType === "write" ? "write" : actionType === "draft" ? "draft" : "read";

      const denied = await requireAIActionPermission(req, tier);
      if (denied) return res.status(denied.code).json({ message: denied.message });

      await db.insert(aiActionLog).values({
        companyId,
        userId,
        sessionId: sessionId || null,
        prompt: prompt || null,
        draftJson: draftJson || null,
        actionType: tier,
        actionName: actionName || null,
        createdRecordId: createdRecordId || null,
        status: status || "confirmed",
      });
      res.json({ success: true });
    } catch (_error: unknown) {
      res.status(500).json({ message: "Internal server error" });
    }
  });
}
