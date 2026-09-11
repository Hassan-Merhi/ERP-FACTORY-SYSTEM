/**
 * chatbotRoutes: ChatbotMessage endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage, getErrorStack } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { db } from "../../db";
import { requireAuth, requireNonPOS } from "../../auth";
import {
  saveMessage,
  chat,
  getConversationHistory,
  getConversationHistoryForAI,
  getAllChatHistory,
} from "../../chatService";
import { users, userCompanyRoles, chatMessages } from "@shared/schema";
import { eq, and, desc, inArray, sql } from "drizzle-orm";
import { requireAIActionPermission, logAIAction } from "../../lib/aiActionPermission";
import { chatMessageRateLimiter } from "./_helpers";

export function registerChatbotMessageRoutes(app: Express) {
  app.post("/api/chatbot/message", requireAuth, chatMessageRateLimiter, async (req, res) => {
    try {
      const userId = req.session.userId;
      const companyId = req.session.currentCompanyId;

      if (!userId || !companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const denied = await requireAIActionPermission(req, "read");
      if (denied) return res.status(denied.code).json({ message: denied.message });

      const { message, sessionId, pageContext, sessionReadFiles } = req.body;
      if (!message || !sessionId) {
        return res.status(400).json({ message: "Message and sessionId are required" });
      }

      // Save user message
      await saveMessage(companyId, userId, "user", message, sessionId);

      // Get conversation history for AI context (excluding current message)
      const history = await getConversationHistoryForAI(sessionId, 10);

      // Get AI response (excluding current message from history context)
      const result = await chat(
        message,
        companyId,
        history.slice(0, -1),
        undefined,
        pageContext,
        sessionReadFiles ?? []
      );

      // Save assistant response
      await saveMessage(companyId, userId, "assistant", result.response, sessionId);

      await logAIAction({
        req,
        actionType: "read",
        actionName: "chat_message",
        inputJson: { message, sessionId },
        outputJson: {
          hasDraft: !!(
            result.voucherDraft ||
            result.stockTransferDraft ||
            result.stockItemDraft ||
            result.stockAdjustmentDraft
          ),
        },
        status: "success",
      });

      res.json({
        response: result.response,
        suggestions: result.suggestions,
        provider: result.provider ?? null,
        voucherDraft: result.voucherDraft ?? null,
        stockAdjustmentDraft: result.stockAdjustmentDraft ?? null,
        stockTransferDraft: result.stockTransferDraft ?? null,
        voucherSearchResults: result.voucherSearchResults ?? null,
        stockItemDraft: result.stockItemDraft ?? null,
        priceUpdateDraft: result.priceUpdateDraft ?? null,
        accountQueryResult: result.accountQueryResult ?? null,
        verifyContainerDraft: result.verifyContainerDraft ?? null,
        dataQueryResult: result.dataQueryResult ?? null,
        filePatchDrafts: result.filePatchDrafts ?? null,
        readFiles: result.readFiles ?? null,
      });
    } catch (error: unknown) {
      logger.error("[Chatbot] ERROR:", { error: getErrorMessage(error) });
      logger.error("[Chatbot] Stack:", { stack: getErrorStack(error) });
      res.status(500).json({ message: "Chat error: " + getErrorMessage(error) });
    }
  });

  // Get chat history for current session
  app.get("/api/chatbot/history/:sessionId", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId;
      if (!userId) {
        return res.status(401).json({ message: "Not authenticated" });
      }

      const { sessionId } = req.params;
      // Pass userId to ensure users can only access their own chat history
      const history = await getConversationHistory(sessionId, userId, 50);
      res.json(history);
    } catch (error: unknown) {
      logger.error("[Chatbot] History ERROR:", { error: getErrorMessage(error) });
      logger.error("[Chatbot] History Stack:", { stack: getErrorStack(error) });
      res.status(500).json({ message: "History error: " + getErrorMessage(error) });
    }
  });

  // Get all chat history (Admin/Owner only)
  app.get("/api/chatbot/all-history", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      const userRole = req.session.currentRole;

      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      // Only Admin/Owner can view all chat history
      if (userRole !== "Admin" && userRole !== "Owner" && userRole !== "Developer") {
        return res.status(403).json({ message: "Access denied" });
      }

      const history = await getAllChatHistory(companyId, 200);

      // Enrich with username and role. NULL authors never match the IN lists
      // below, so dropping them here cannot change which users are fetched.
      const userIds = Array.from(new Set(history.map((h) => h.userId).filter((id): id is string => id !== null)));
      const usersList =
        userIds.length > 0
          ? await db.select({ id: users.id, username: users.username }).from(users).where(inArray(users.id, userIds))
          : [];

      const userMap = new Map(usersList.map((u) => [u.id, u.username]));

      // Fetch roles for all message authors in this company
      let developerUserIds = new Set<string>();
      if (userIds.length > 0) {
        const roleRows = await db
          .select({ userId: userCompanyRoles.userId, role: userCompanyRoles.role })
          .from(userCompanyRoles)
          .where(
            and(
              eq(userCompanyRoles.companyId, companyId),
              eq(userCompanyRoles.role, "Developer"),
              inArray(userCompanyRoles.userId, userIds.map(String))
            )
          );
        developerUserIds = new Set(roleRows.map((r) => String(r.userId)));
      }

      // Admin/Owner cannot see Developer users' chats; Developer can see everything
      const isDeveloper = userRole === "Developer";
      const filteredHistory = isDeveloper ? history : history.filter((h) => !developerUserIds.has(String(h.userId)));

      const enrichedHistory = filteredHistory.map((h) => ({
        ...h,
        username: userMap.get(h.userId ?? "") || "Unknown",
      }));

      res.json(enrichedHistory);
    } catch (_error: unknown) {
      res.status(500).json({ message: "Internal server error" });
    }
  });

  // ── My chat sessions (any logged-in user, own history only) ──────────────
  app.get("/api/chatbot/my-sessions", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const userId = req.session.userId;
      const companyId = req.session.currentCompanyId;
      if (!userId || !companyId) return res.status(400).json({ message: "Not authenticated" });

      const rows = await db
        .select({
          sessionId: chatMessages.sessionId,
          messageCount: sql<number>`count(*)::int`,
          lastMessageTime: sql<string>`max(${chatMessages.createdAt})`,
          preview: sql<string>`min(case when ${chatMessages.role} = 'user' then ${chatMessages.content} end)`,
        })
        .from(chatMessages)
        .where(and(eq(chatMessages.userId, String(userId)), eq(chatMessages.companyId, companyId)))
        .groupBy(chatMessages.sessionId)
        .orderBy(desc(sql`max(${chatMessages.createdAt})`))
        .limit(100);

      res.json(
        rows.map((r) => ({
          sessionId: r.sessionId,
          messageCount: Number(r.messageCount),
          preview: r.preview ? String(r.preview).slice(0, 100) : "Chat session",
          lastMessageTime: r.lastMessageTime,
        }))
      );
    } catch (_error: unknown) {
      res.status(500).json({ message: "Internal server error" });
    }
  });

  // ── Delete a chat session ─────────────────────────────────────────────────
  app.delete("/api/chatbot/session/:sessionId", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const userId = req.session.userId;
      const companyId = req.session.currentCompanyId;
      const userRole = req.session.currentRole;
      if (!userId || !companyId) return res.status(400).json({ message: "Not authenticated" });

      const { sessionId } = req.params;

      const isDeveloper = userRole === "Developer";
      const isAdminOrOwner = userRole === "Admin" || userRole === "Owner";

      // Determine session owner
      const sessionOwnerRow = await db
        .select({ userId: chatMessages.userId })
        .from(chatMessages)
        .where(and(eq(chatMessages.sessionId, sessionId), eq(chatMessages.companyId, companyId)))
        .limit(1);

      if (sessionOwnerRow.length === 0) {
        return res.status(404).json({ message: "Session not found" });
      }

      const ownerUserId = sessionOwnerRow[0].userId;

      // Admin/Owner cannot delete Developer users' sessions
      if (isAdminOrOwner && !isDeveloper) {
        const ownerRoleRow = await db
          .select({ role: userCompanyRoles.role })
          .from(userCompanyRoles)
          .where(
            and(
              eq(userCompanyRoles.companyId, companyId),
              eq(userCompanyRoles.userId, String(ownerUserId)),
              eq(userCompanyRoles.role, "Developer")
            )
          )
          .limit(1);
        if (ownerRoleRow.length > 0) {
          return res.status(403).json({ message: "Cannot delete a Developer's conversation" });
        }
      }

      // Regular users can only delete their own sessions
      if (!isDeveloper && !isAdminOrOwner && ownerUserId !== String(userId)) {
        return res.status(403).json({ message: "Access denied" });
      }

      await db
        .delete(chatMessages)
        .where(and(eq(chatMessages.sessionId, sessionId), eq(chatMessages.companyId, companyId)));
      res.json({ success: true });
    } catch (_error: unknown) {
      res.status(500).json({ message: "Internal server error" });
    }
  });
}
