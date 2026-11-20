/**
 * aiImportRoutes: AiImportCorrection endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { db } from "../../db";
import { requireAuth } from "../../auth";
import { validateRequest } from "../../lib/validateRequest";
import { deleteCorrectionInput } from "./aiImportSchemas";
import { aiCorrectionMemory } from "@shared/schema";
import { eq, and } from "drizzle-orm";

export function registerAiImportCorrectionRoutes(app: Express) {
  // GET /api/ai-import/corrections
  // List all correction memory entries for the current company.
  // Optional query param: ?memoryType=item_alias
  app.get("/api/ai-import/corrections", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const memoryTypeFilter = req.query.memoryType as string | undefined;

      const rows = await db
        .select()
        .from(aiCorrectionMemory)
        .where(
          memoryTypeFilter
            ? and(eq(aiCorrectionMemory.companyId, companyId), eq(aiCorrectionMemory.memoryType, memoryTypeFilter))
            : eq(aiCorrectionMemory.companyId, companyId)
        )
        .orderBy(aiCorrectionMemory.memoryType, aiCorrectionMemory.rawValue);

      res.json(rows);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // DELETE /api/ai-import/corrections/:id
  // Remove a specific correction so the validator falls back to fuzzy matching.
  app.delete(
    "/api/ai-import/corrections/:id",
    requireAuth,
    validateRequest(deleteCorrectionInput),
    async (req, res) => {
      try {
        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const corrId = parseInt(req.params.id);
        if (isNaN(corrId)) return res.status(400).json({ message: "Invalid id" });

        const [existing] = await db
          .select({ id: aiCorrectionMemory.id, companyId: aiCorrectionMemory.companyId })
          .from(aiCorrectionMemory)
          .where(eq(aiCorrectionMemory.id, corrId));

        if (!existing) return res.status(404).json({ message: "Correction not found" });
        if (existing.companyId !== companyId) return res.status(403).json({ message: "Forbidden" });

        await db.delete(aiCorrectionMemory).where(eq(aiCorrectionMemory.id, corrId));
        res.json({ success: true });
      } catch (error: unknown) {
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}
