/**
 * aiImportRoutes: AiImportConfirm endpoints.
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
import { jobActionInput, updateRowInput } from "./aiImportSchemas";
import { aiImportJobs, aiImportRows } from "@shared/schema";
import { eq } from "drizzle-orm";
import { assertJobOwnership, upsertCorrection, validateRows } from "./_helpers";

export function registerAiImportConfirmRoutes(app: Express) {
  // POST /api/ai-import/jobs/:id/confirm
  // Locks the job for posting; only works when errorRows = 0
  app.post("/api/ai-import/jobs/:id/confirm", requireAuth, validateRequest(jobActionInput), async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const jobId = parseInt(req.params.id);
      if (isNaN(jobId)) return res.status(400).json({ message: "Invalid job id" });

      const job = await assertJobOwnership(jobId, companyId);

      if (job.status === "posted") return res.status(409).json({ message: "Job is already posted" });
      if (job.status === "staged") return res.status(409).json({ message: "Job is already confirmed" });
      if (!["validated"].includes(job.status))
        return res.status(409).json({ message: "Job must be validated before confirming" });
      if ((job.errorRows ?? 0) > 0)
        return res.status(409).json({ message: `Cannot confirm: ${job.errorRows} row(s) still have errors` });

      await db
        .update(aiImportJobs)
        .set({ status: "staged", confirmedAt: new Date(), updatedAt: new Date() })
        .where(eq(aiImportJobs.id, jobId));

      res.json({
        jobId,
        status: "staged",
        validRows: job.validRows,
        warningRows: job.warningRows,
        message: "Job confirmed. Call /post to create the records.",
      });
    } catch (error: unknown) {
      logger.error("[AI Import] confirm error:", { error: getErrorMessage(error) });
      res.status((error as { status: number }).status ?? 500).json({ message: getErrorMessage(error) });
    }
  });

  // PATCH /api/ai-import/rows/:rowId
  // Save user corrections for one import row and re-validate it using correction memory.
  // Body: {
  //   mappedData?:  any                 — optional full override merged on top of re-validated data
  //   corrections:  Array<{             — list of entity resolutions to remember
  //     memoryType:    string,          — 'item_alias' | 'ledger_alias' | 'supplier_alias' | ...
  //     rawValue:      string,          — original cell value from the Excel file
  //     resolvedId:    number | null,   — ERP record id
  //     resolvedValue: string,          — canonical display name / code
  //     resolvedType:  string,          — e.g. 'stock_group', 'ledger_account'
  //     confidence?:   number           — default 100; only >=100 are auto-applied
  //   }>
  // }
  app.patch("/api/ai-import/rows/:rowId", requireAuth, validateRequest(updateRowInput), async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      const userId = req.session.userId;
      if (!companyId || !userId) return res.status(400).json({ message: "No company selected" });

      const rowId = parseInt(req.params.rowId);
      if (isNaN(rowId)) return res.status(400).json({ message: "Invalid row id" });

      // Load row + verify job ownership
      const [row] = await db
        .select({
          id: aiImportRows.id,
          jobId: aiImportRows.jobId,
          rowNumber: aiImportRows.rowNumber,
          rawData: aiImportRows.rawData,
        })
        .from(aiImportRows)
        .where(eq(aiImportRows.id, rowId));

      if (!row) return res.status(404).json({ message: "Row not found" });

      const job = await assertJobOwnership(row.jobId, companyId);
      if (job.status === "posted") return res.status(409).json({ message: "Job is already posted" });

      const { corrections = [], mappedData: overrideMappedData } = req.body;

      // Persist all corrections (upsert — case-insensitive match on rawValue)
      for (const c of corrections) {
        if (!c.memoryType || c.rawValue == null) continue;
        await upsertCorrection({
          companyId,
          userId,
          memoryType: String(c.memoryType),
          rawValue: String(c.rawValue),
          resolvedId: c.resolvedId ?? null,
          resolvedValue: c.resolvedValue ?? null,
          resolvedType: c.resolvedType ?? null,
          confidence: typeof c.confidence === "number" ? c.confidence : 100,
        });
      }

      // Re-validate this row from rawData — correction memory now has the fix applied,
      // so entity references will resolve automatically.
      const [result] = await validateRows(companyId, job.importType, [
        {
          id: row.id,
          rowNumber: row.rowNumber,
          rawData: row.rawData,
        },
      ]);

      // If caller also sent an explicit mappedData override, merge it on top.
      // This lets the frontend override freeform text fields (name, code, etc.)
      // that rawData-based re-validation cannot infer.
      const finalMappedData =
        overrideMappedData != null ? { ...(result.mappedData ?? {}), ...overrideMappedData } : result.mappedData;

      await db
        .update(aiImportRows)
        .set({
          status: result.status,
          mappedData: finalMappedData,
          errors: result.errors,
          warnings: result.warnings,
        })
        .where(eq(aiImportRows.id, rowId));

      res.json({
        id: rowId,
        status: result.status,
        mappedData: finalMappedData,
        errors: result.errors,
        warnings: result.warnings,
        correctionsApplied: corrections.length,
      });
    } catch (error: unknown) {
      res.status((error as { status: number }).status ?? 500).json({ message: getErrorMessage(error) });
    }
  });
}
