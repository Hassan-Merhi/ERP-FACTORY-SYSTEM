import type { Express } from "express";
import { eq } from "drizzle-orm";
import { APPLICATION_LANGUAGES, parseApplicationLanguage } from "@shared/applicationLanguageContract";
import { userLanguagePreferences } from "@shared/schema";
import { requireAuth } from "../../auth";
import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { emptyQuery, validateRequest, type RequestSchemas } from "../../lib/validateRequest";
import { z } from "zod";

// An unsupported language string still reaches the handler's own message.
const updateLanguagePreferenceInput = {
  query: emptyQuery,
  body: z.strictObject({ preferredLanguage: z.string().optional() }),
} satisfies RequestSchemas;

export function registerLanguagePreferenceRoutes(app: Express) {
  app.get("/api/language-preference", requireAuth, async (req, res) => {
    try {
      if (!req.user) return res.status(401).json({ message: "Unauthorized" });
      const [row] = await db
        .select({ preferredLanguage: userLanguagePreferences.preferredLanguage })
        .from(userLanguagePreferences)
        .where(eq(userLanguagePreferences.userId, req.user.id))
        .limit(1);
      return res.json({ preferredLanguage: parseApplicationLanguage(row?.preferredLanguage) });
    } catch (error: unknown) {
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.put("/api/language-preference", requireAuth, validateRequest(updateLanguagePreferenceInput), async (req, res) => {
    try {
      if (!req.user) return res.status(401).json({ message: "Unauthorized" });
      const requestedLanguage = req.body?.preferredLanguage;
      if (!APPLICATION_LANGUAGES.includes(requestedLanguage)) {
        return res.status(400).json({ message: "Invalid application language" });
      }
      const preferredLanguage = parseApplicationLanguage(requestedLanguage);
      await db
        .insert(userLanguagePreferences)
        .values({ userId: req.user.id, preferredLanguage, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: userLanguagePreferences.userId,
          set: { preferredLanguage, updatedAt: new Date() },
        });
      return res.json({ preferredLanguage });
    } catch (error: unknown) {
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
