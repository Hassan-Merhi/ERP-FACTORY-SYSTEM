/**
 * aiImportRoutes: AiImportJob endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { db } from "../../db";
import { requireAuth } from "../../auth";
import { upload } from "../_helpers";
import { readExcel, sheetToJson } from "../../excelHelper";
import { aiImportJobs, aiImportRows } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import { assertJobOwnership, validateRows } from "./_helpers";

export function registerAiImportJobRoutes(app: Express) {
  // POST /api/ai-import/upload
  // Parse Excel, stage rows — does NOT insert business records
  app.post("/api/ai-import/upload", requireAuth, upload.single("file"), async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      const userId = req.session.userId;

      if (!companyId || !userId) return res.status(400).json({ message: "No company selected" });
      if (!req.file) return res.status(400).json({ message: "No file uploaded" });

      const importType = String(req.body.importType ?? "").trim();
      if (!importType) return res.status(400).json({ message: "importType is required" });

      const SUPPORTED = ["stock_items", "customers", "suppliers", "vouchers"];
      if (!SUPPORTED.includes(importType))
        return res.status(400).json({ message: `importType must be one of: ${SUPPORTED.join(", ")}` });

      // Parse the Excel file
      const workbook = await readExcel(req.file.buffer);
      const sheetName = workbook.SheetNames[0];
      if (!sheetName) return res.status(400).json({ message: "Excel file has no sheets" });

      const rawRows: Record<string, unknown>[] = sheetToJson(workbook.Sheets[sheetName]);
      if (!rawRows.length) return res.status(400).json({ message: "Excel file has no data rows" });

      // Create the job
      const [job] = await db
        .insert(aiImportJobs)
        .values({
          companyId,
          userId,
          importType,
          originalFileName: req.file.originalname,
          status: "uploaded",
          totalRows: rawRows.length,
          validRows: 0,
          warningRows: 0,
          errorRows: 0,
        })
        .returning();

      // Stage all rows as 'pending' — no validation yet
      const rowValues = rawRows.map((raw, i) => ({
        jobId: job.id,
        rowNumber: i + 1,
        rawData: raw,
        status: "pending",
        errors: [],
        warnings: [],
      }));

      await db.insert(aiImportRows).values(rowValues);

      res.json({
        jobId: job.id,
        importType,
        originalFileName: job.originalFileName,
        totalRows: rawRows.length,
        status: "uploaded",
        message: `${rawRows.length} rows staged. Call /validate to check them.`,
      });
    } catch (error: unknown) {
      logger.error("[AI Import] upload error:", { error: getErrorMessage(error) });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // GET /api/ai-import/jobs/:id
  app.get("/api/ai-import/jobs/:id", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const jobId = parseInt(req.params.id);
      if (isNaN(jobId)) return res.status(400).json({ message: "Invalid job id" });

      const job = await assertJobOwnership(jobId, companyId);
      res.json(job);
    } catch (error: unknown) {
      res.status((error as { status: number }).status ?? 500).json({ message: getErrorMessage(error) });
    }
  });

  // GET /api/ai-import/jobs/:id/rows
  app.get("/api/ai-import/jobs/:id/rows", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const jobId = parseInt(req.params.id);
      if (isNaN(jobId)) return res.status(400).json({ message: "Invalid job id" });

      await assertJobOwnership(jobId, companyId);

      const statusFilter = req.query.status as string | undefined;
      const rows = await db
        .select()
        .from(aiImportRows)
        .where(
          statusFilter
            ? and(eq(aiImportRows.jobId, jobId), eq(aiImportRows.status, statusFilter))
            : eq(aiImportRows.jobId, jobId)
        )
        .orderBy(aiImportRows.rowNumber);

      res.json(rows);
    } catch (error: unknown) {
      res.status((error as { status: number }).status ?? 500).json({ message: getErrorMessage(error) });
    }
  });

  // POST /api/ai-import/jobs/:id/validate
  // Checks rows against ERP tables; updates status/errors/warnings; recalculates counts
  app.post("/api/ai-import/jobs/:id/validate", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const jobId = parseInt(req.params.id);
      if (isNaN(jobId)) return res.status(400).json({ message: "Invalid job id" });

      const job = await assertJobOwnership(jobId, companyId);

      if (job.status === "posted") return res.status(409).json({ message: "Job is already posted" });

      // Load all rows
      const rows = await db
        .select({ id: aiImportRows.id, rowNumber: aiImportRows.rowNumber, rawData: aiImportRows.rawData })
        .from(aiImportRows)
        .where(eq(aiImportRows.jobId, jobId))
        .orderBy(aiImportRows.rowNumber);

      if (!rows.length) return res.status(400).json({ message: "Job has no rows" });

      // Validate (type-specific)
      const results = await validateRows(companyId, job.importType, rows);

      // Persist results
      for (const r of results) {
        await db
          .update(aiImportRows)
          .set({
            status: r.status,
            mappedData: r.mappedData,
            errors: r.errors,
            warnings: r.warnings,
          })
          .where(eq(aiImportRows.id, r.id));
      }

      const validRows = results.filter((r) => r.status === "valid").length;
      const warningRows = results.filter((r) => r.status === "warning").length;
      const errorRows = results.filter((r) => r.status === "error").length;

      await db
        .update(aiImportJobs)
        .set({
          status: errorRows > 0 ? "has_errors" : "validated",
          validRows,
          warningRows,
          errorRows,
          updatedAt: new Date(),
        })
        .where(eq(aiImportJobs.id, jobId));

      res.json({
        jobId,
        totalRows: rows.length,
        validRows,
        warningRows,
        errorRows,
        status: errorRows > 0 ? "has_errors" : "validated",
        canConfirm: errorRows === 0,
        message:
          errorRows > 0
            ? `${errorRows} row(s) have errors that must be fixed before confirming.`
            : `All rows valid. Call /confirm to proceed.`,
      });
    } catch (error: unknown) {
      logger.error("[AI Import] validate error:", { error: getErrorMessage(error) });
      res.status((error as { status: number }).status ?? 500).json({ message: getErrorMessage(error) });
    }
  });
}
