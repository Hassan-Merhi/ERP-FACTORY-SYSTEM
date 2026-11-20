/**
 * aiImportRoutes: AiImportPost endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { db } from "../../db";
import { requireAuth } from "../../auth";
import { validateRequest } from "../../lib/validateRequest";
import { jobActionInput } from "./aiImportSchemas";
import { aiImportJobs, aiImportRows } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import { sql } from "drizzle-orm";

import { assertJobOwnership, postRows } from "./_helpers";

export function registerAiImportPostRoutes(app: Express) {
  // POST /api/ai-import/jobs/:id/post
  // Creates business records in a transaction; writes audit log; marks job posted
  app.post("/api/ai-import/jobs/:id/post", requireAuth, validateRequest(jobActionInput), async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      const userId = req.session.userId;
      const username = req.session.username || "Unknown";

      if (!companyId || !userId) return res.status(400).json({ message: "No company selected" });

      const jobId = parseInt(req.params.id);
      if (isNaN(jobId)) return res.status(400).json({ message: "Invalid job id" });

      const job = await assertJobOwnership(jobId, companyId);

      if (job.status === "posted") return res.status(409).json({ message: "Job is already posted" });
      if (job.status !== "staged") return res.status(409).json({ message: "Job must be confirmed before posting" });

      // Load valid/warning rows only
      const rows = await db
        .select({ id: aiImportRows.id, mappedData: aiImportRows.mappedData, status: aiImportRows.status })
        .from(aiImportRows)
        .where(and(eq(aiImportRows.jobId, jobId), sql`${aiImportRows.status} IN ('valid', 'warning')`))
        .orderBy(aiImportRows.rowNumber);

      if (!rows.length) return res.status(400).json({ message: "No valid rows to post" });

      const rowsToPost = rows.map((r) => ({ id: r.id, mappedData: r.mappedData }));

      // Run everything in a single transaction
      const created = await db.transaction(async (tx) => {
        const results = await postRows(
          companyId,
          userId,
          username,
          job.importType,
          rowsToPost,
          tx as unknown as Parameters<typeof postRows>[5]
        );

        // Update each row with the created record info
        for (const r of results) {
          await tx
            .update(aiImportRows)
            .set({
              status: "posted",
              createdRecordType: r.recordType,
              createdRecordId: r.recordId,
            })
            .where(eq(aiImportRows.id, r.rowId));
        }

        return results;
      });

      // Mark job as posted outside the transaction (no rollback needed)
      await db
        .update(aiImportJobs)
        .set({ status: "posted", postedAt: new Date(), updatedAt: new Date() })
        .where(eq(aiImportJobs.id, jobId));

      res.json({
        jobId,
        status: "posted",
        recordsCreated: created.length,
        records: created,
        message: `${created.length} record(s) created successfully.`,
      });
    } catch (error: unknown) {
      logger.error("[AI Import] post error:", { error: getErrorMessage(error) });
      res.status((error as { status: number }).status ?? 500).json({ message: getErrorMessage(error) });
    }
  });
}
