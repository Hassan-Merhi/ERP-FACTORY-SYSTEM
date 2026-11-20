/**
 * GIT routes - Excel templates, the bulk container import, and its undo.
 *
 * Registered by ./index.ts in the same order as the original single file;
 * Express resolves first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { db } from "../../db";
import { requireAuth, requireRole } from "../../auth";
import { z } from "zod";
import { emptyQuery, validateRequest, type RequestSchemas } from "../../lib/validateRequest";
import { containers } from "../../../shared/schema";
import { eq } from "drizzle-orm";
import { importUndoStore, pruneImportUndoStore } from "./_helpers";
import { registerGitImportRoutesPart1 } from "./registerGitImportRoutesPart1";
import { registerGitImportRoutesPart2 } from "./registerGitImportRoutesPart2";

export function registerGitImportRoutes(app: Express) {
  registerGitImportRoutesPart1(app);
  registerGitImportRoutesPart2(app);
  registerGitImportRoutesPart3(app);
}

// The handler keeps its "importId required" check.
const importUndoInput = {
  query: emptyQuery,
  body: z.strictObject({ importId: z.string().optional() }),
} satisfies RequestSchemas;

function registerGitImportRoutesPart3(app: Express) {
  // ─── Undo last Excel import ───────────────────────────────────────────────
  app.post(
    "/api/git/containers/import-excel/undo",
    requireAuth,
    requireRole("Admin", "Owner", "Developer"),
    validateRequest(importUndoInput),
    async (req: import("express").Request, res: import("express").Response) => {
      try {
        const { importId } = req.body ?? {};
        if (!importId || typeof importId !== "string") {
          return res.status(400).json({ message: "importId required" });
        }
        pruneImportUndoStore();
        const snap = importUndoStore.get(importId);
        if (!snap) {
          return res
            .status(404)
            .json({ message: "Undo data not found — it may have expired (2 hr limit) or already been used." });
        }
        if (snap.companyId !== req.session.currentCompanyId) {
          return res.status(403).json({ message: "Forbidden" });
        }

        let reverted = 0;
        for (const change of snap.changes) {
          if (Object.keys(change.prevData).length === 0) continue;
          await db.update(containers).set(change.prevData).where(eq(containers.id, change.id));
          reverted++;
        }

        // Remove the undo snapshot so it can't be used twice
        importUndoStore.delete(importId);

        res.json({ reverted });
      } catch (err: unknown) {
        logger.error("[GIT import undo]", { error: err });
        res.status(500).json({ message: getErrorMessage(err) });
      }
    }
  );
}
