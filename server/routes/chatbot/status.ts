/**
 * chatbotRoutes: ChatbotStatus endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { db } from "../../db";
import { requireAuth, requireNonPOS } from "../../auth";
import {} from "../../chatService";
import { users, systemSettings } from "@shared/schema";
import { eq } from "drizzle-orm";

export function registerChatbotStatusRoutes(app: Express) {
  app.get("/api/chatbot/status", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId;
      const companyId = req.session.currentCompanyId;
      const userRole = req.session.currentRole;

      if (!userId || !companyId) {
        return res.json({ enabled: false });
      }

      // Run both DB queries in parallel — they are independent.
      const [, providerRows] = await Promise.all([
        db.select({ chatbotEnabled: users.chatbotEnabled }).from(users).where(eq(users.id, userId)),
        db
          .select({ value: systemSettings.value })
          .from(systemSettings)
          .where(eq(systemSettings.key, "ai_provider"))
          .limit(1),
      ]);

      // Get selected AI provider and check if its API key is configured
      const providerSetting = providerRows;
      const selectedProvider =
        providerSetting.length > 0 && providerSetting[0].value ? providerSetting[0].value.toLowerCase() : "gemini";
      let hasApiKey = false;
      let providerName = "Gemini";
      if (selectedProvider === "chatgpt") {
        hasApiKey = !!process.env.OPENAI_API_KEY;
        providerName = "OpenAI";
      } else if (selectedProvider === "grok") {
        hasApiKey = !!process.env.XAI_API_KEY;
        providerName = "Grok";
      } else {
        hasApiKey = !!process.env.GEMINI_API_KEY;
        providerName = "Gemini";
      }

      res.set("Cache-Control", "private, max-age=120");
      res.json({
        enabled: true,
        providerName,
        selectedProvider,
        hasApiKey,
        isAdminOrOwner: userRole === "Admin" || userRole === "Owner" || userRole === "Developer",
      });
    } catch (_error: unknown) {
      res.status(500).json({ message: "Internal server error" });
    }
  });

  // Send a chat message

  // Update AI provider setting
  app.patch("/api/chatbot/provider", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const userRole = req.session.currentRole;
      if (userRole !== "Admin" && userRole !== "Owner" && userRole !== "Developer") {
        return res.status(403).json({ message: "Only admins can change AI provider" });
      }

      const { provider } = req.body;
      if (!provider || !["gemini", "chatgpt", "grok"].includes(provider.toLowerCase())) {
        return res.status(400).json({ message: "Invalid provider. Must be gemini, chatgpt, or grok" });
      }

      const normalizedProvider = provider.toLowerCase();

      // Check if setting exists
      const existing = await db.select().from(systemSettings).where(eq(systemSettings.key, "ai_provider")).limit(1);

      if (existing.length > 0) {
        await db
          .update(systemSettings)
          .set({ value: normalizedProvider, updatedAt: new Date() })
          .where(eq(systemSettings.key, "ai_provider"));
      } else {
        await db.insert(systemSettings).values({
          key: "ai_provider",
          value: normalizedProvider,
        });
      }

      res.json({ success: true, provider: normalizedProvider });
    } catch (_error: unknown) {
      res.status(500).json({ message: "Internal server error" });
    }
  });
}
