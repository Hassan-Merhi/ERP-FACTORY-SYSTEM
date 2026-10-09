/**
 * chatbotRoutes: ChatbotAlert endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { db } from "../../db";
import { requireAuth, requireNonPOS } from "../../auth";
import { inventory, stockItems, purchaseOrders, users, aiActionLog } from "@shared/schema";
import { sumMoney, toMoney } from "../../lib/money";
import { getPartyBalances } from "../../services/accounting/balances/ledgerBalanceEngine";
import { eq, and } from "drizzle-orm";
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

      // Customer receivables from the one balance engine (wave 13, A4): the
      // ledger balance of each customer of this company; amounts not yet in the
      // ledger are reported beside it, never added in.
      const { parties: customerParties } = await getPartyBalances(db, { companyId, kind: "customer", memo: true });
      const receivables = customerParties
        .filter((party) => party.id !== null && !party.deleted)
        .map((party) => ({
          customerId: party.id!,
          name: party.name || "Unknown",
          exact: toMoney(party.closing),
          notInLedger: toMoney(party.memoTotal),
        }));
      const overdueCustomers = receivables
        .filter((customer) => customer.exact.greaterThan(0.01))
        .sort((a, b) => b.exact.comparedTo(a.exact))
        .slice(0, 10)
        .map((customer) => ({
          customerId: customer.customerId,
          name: customer.name,
          balance: customer.exact.toNumber(),
          notInLedger: customer.notInLedger.toNumber(),
        }));
      const receivablesNotInLedger = sumMoney(receivables.map((customer) => customer.notInLedger)).toNumber();

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
        receivablesNotInLedger,
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

      // Without this, a body missing `enabled` left the update with nothing to
      // set, which drizzle rejects and the catch below reported as an opaque
      // 500 "Internal server error".
      if (typeof enabled !== "boolean") {
        return res.status(400).json({ message: "Invalid request data", field: "enabled" });
      }

      const [updated] = await db
        .update(users)
        .set({ chatbotEnabled: enabled })
        .where(eq(users.id, userId))
        .returning({ id: users.id });
      if (!updated) return res.status(404).json({ message: "User not found" });

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
