/**
 * chatbotRoutes: ChatbotGithubSettings endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { db } from "../../db";
import { requireAuth, requireNonPOS } from "../../auth";
import { systemSettings } from "@shared/schema";
import { eq } from "drizzle-orm";
import { encryptToken } from "./_helpers";
import { z } from "zod";
import { emptyQuery, validateRequest, type RequestSchemas } from "../../lib/validateRequest";

// The handler answers its own 400 when neither field is given.
const updateGithubSettingsInput = {
  query: emptyQuery,
  body: z.strictObject({
    repoUrl: z.string().nullable().optional(),
    token: z.string().nullable().optional(),
  }),
} satisfies RequestSchemas;

export function registerChatbotGithubSettingsRoutes(app: Express) {
  // ── GitHub settings ────────────────────────────────────────────────────────
  app.get("/api/chatbot/github-settings", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const userRole = req.session.currentRole;
      if (userRole !== "Admin" && userRole !== "Owner" && userRole !== "Developer") {
        return res.status(403).json({ message: "Access denied" });
      }

      const [urlRow, tokenRow] = await Promise.all([
        db
          .select({ value: systemSettings.value })
          .from(systemSettings)
          .where(eq(systemSettings.key, "github_repo_url"))
          .limit(1),
        db
          .select({ value: systemSettings.value })
          .from(systemSettings)
          .where(eq(systemSettings.key, "github_token"))
          .limit(1),
      ]);

      const baseUrl = urlRow[0]?.value ?? "";
      const hasToken = !!tokenRow[0]?.value;

      // Strip any embedded token from URL before returning (never expose token)
      const safeUrl = baseUrl.replace(/https?:\/\/[^@]+@/, "https://");

      res.json({ repoUrl: safeUrl, hasToken, configured: !!baseUrl });
    } catch (_error: unknown) {
      res.status(500).json({ message: "Internal server error" });
    }
  });

  app.patch(
    "/api/chatbot/github-settings",
    requireAuth,
    requireNonPOS,
    validateRequest(updateGithubSettingsInput),
    async (req, res) => {
      try {
        const userRole = req.session.currentRole;
        if (userRole !== "Admin" && userRole !== "Owner" && userRole !== "Developer") {
          return res.status(403).json({ message: "Only Admin/Developer users can configure GitHub settings" });
        }

        const { repoUrl, token } = req.body;
        if (!repoUrl && !token) {
          return res.status(400).json({ message: "repoUrl or token is required" });
        }

        // Helper to upsert a systemSettings key
        const upsertSetting = async (key: string, value: string) => {
          const existing = await db
            .select({ id: systemSettings.id })
            .from(systemSettings)
            .where(eq(systemSettings.key, key))
            .limit(1);
          if (existing.length > 0) {
            await db.update(systemSettings).set({ value, updatedAt: new Date() }).where(eq(systemSettings.key, key));
          } else {
            await db.insert(systemSettings).values({ key, value });
          }
        };

        if (repoUrl && typeof repoUrl === "string" && repoUrl.trim()) {
          // Strip any accidentally embedded token from URL — token is stored separately
          const cleanUrl = repoUrl.trim().replace(/https?:\/\/[^@]+@/, "https://");
          await upsertSetting("github_repo_url", cleanUrl);
        }

        if (token && typeof token === "string" && token.trim()) {
          await upsertSetting("github_token", encryptToken(token.trim()));
        }

        res.json({ success: true });
      } catch (_error: unknown) {
        res.status(500).json({ message: "Internal server error" });
      }
    }
  );
}
