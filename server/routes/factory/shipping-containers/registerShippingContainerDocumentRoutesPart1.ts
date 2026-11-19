// Extracted from ./documents.ts
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { factoryShippingContainerRows, factoryShippingContainerDocuments } from "@shared/schema";
import { eq, and, sql } from "drizzle-orm";
import path from "path";
import fs from "fs";
import { getCompanyId, safeDownloadName, scrUpload } from "./_helpers";

export function registerShippingContainerDocumentRoutesPart1(app: Express) {
  // ── GET serve document file ───────────────────────────────────────────────────
  app.get("/api/factory/shipping-container-docs/:filename", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const filename = req.params.filename;

      // Path traversal guard (applied before any I/O)
      const base = path.resolve(process.cwd(), "uploads", "shipping-container-docs");
      const target = path.resolve(base, filename);
      const relative = path.relative(base, target);
      if (relative.startsWith("..") || path.isAbsolute(relative))
        return res.status(400).json({ message: "Invalid filename" });

      // A. Query DB first — ownership must be verified before serving any file
      const [docRow] = await db
        .select({
          fileData: factoryShippingContainerDocuments.fileData,
          fileType: factoryShippingContainerDocuments.fileType,
          originalName: factoryShippingContainerDocuments.originalName,
          companyId: factoryShippingContainerDocuments.companyId,
        })
        .from(factoryShippingContainerDocuments)
        .where(eq(factoryShippingContainerDocuments.fileName, filename));

      // B. No DB row → 404
      if (!docRow)
        return res.status(404).json({
          message:
            "File not found. This file may have been uploaded on a different server instance and is no longer available. Please delete and re-upload the document.",
        });
      // C. Company mismatch → 403
      if (docRow.companyId !== companyId) return res.status(403).json({ message: "Forbidden" });

      // D. Serve from disk cache if available
      if (fs.existsSync(target)) return res.sendFile(target);

      // E. Fall back to DB base64 data
      if (!docRow.fileData)
        return res.status(404).json({
          message:
            "File content is not stored in the database. This document was uploaded before cloud storage was enabled. Please delete and re-upload the file.",
        });

      const buffer = Buffer.from(docRow.fileData, "base64");
      const ct = docRow.fileType || "application/octet-stream";
      res.setHeader("Content-Type", ct);
      const isInline = ct.startsWith("image/") || ct === "application/pdf";
      const disposition = isInline ? "inline" : "attachment";
      res.setHeader("Content-Disposition", `${disposition}; filename="${safeDownloadName(docRow.originalName)}"`);
      res.send(buffer);
    } catch (error: unknown) {
      logger.error("Error serving document:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ── POST upload shipping-company invoice ──────────────────────────────────────
  app.post(
    "/api/factory/shipping-container-rows/:id/shipping-invoice",
    requireAuth,
    scrUpload,
    async (req: Request, res: Response) => {
      try {
        const companyId = getCompanyId(req);
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const id = parseInt(req.params.id);
        if (isNaN(id)) return res.status(400).json({ message: "Invalid id" });
        if (!req.file) return res.status(400).json({ message: "No file uploaded" });

        const [row] = await db
          .select({ id: factoryShippingContainerRows.id })
          .from(factoryShippingContainerRows)
          .where(and(eq(factoryShippingContainerRows.id, id), eq(factoryShippingContainerRows.companyId, companyId)));
        if (!row) return res.status(404).json({ message: "Row not found" });

        const ext = path.extname(req.file.originalname);
        const generatedFilename = `si-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
        const fileUrl = `/api/factory/shipping-invoice-docs/${generatedFilename}`;
        const fileData = req.file.buffer.toString("base64");

        // Disk cache (non-fatal)
        try {
          const dir = path.join(process.cwd(), "uploads", "shipping-invoice-docs");
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, generatedFilename), req.file.buffer);
        } catch (e) {
          logger.warn("Shipping invoice disk cache write failed (non-fatal):", { error: e });
        }

        await db
          .update(factoryShippingContainerRows)
          .set({
            shippingInvoiceFileName: generatedFilename,
            shippingInvoiceOriginalName: req.file.originalname,
            shippingInvoiceFileUrl: fileUrl,
            shippingInvoiceFileData: fileData,
            shippingInvoiceFileType: req.file.mimetype,
            updatedAt: new Date(),
          })
          .where(eq(factoryShippingContainerRows.id, id));

        res.json({ fileUrl, originalName: req.file.originalname, fileType: req.file.mimetype });
      } catch (error: unknown) {
        logger.error("Error uploading shipping invoice:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  // ── DELETE shipping-company invoice ───────────────────────────────────────────
  app.delete(
    "/api/factory/shipping-container-rows/:id/shipping-invoice",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const companyId = getCompanyId(req);
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const id = parseInt(req.params.id);
        if (isNaN(id)) return res.status(400).json({ message: "Invalid id" });

        const [row] = await db
          .select({
            id: factoryShippingContainerRows.id,
            fileName: factoryShippingContainerRows.shippingInvoiceFileName,
          })
          .from(factoryShippingContainerRows)
          .where(and(eq(factoryShippingContainerRows.id, id), eq(factoryShippingContainerRows.companyId, companyId)));
        if (!row) return res.status(404).json({ message: "Row not found" });

        // Remove disk cache (non-fatal)
        if (row.fileName) {
          try {
            const base = path.resolve(process.cwd(), "uploads", "shipping-invoice-docs");
            const target = path.resolve(base, row.fileName);
            const relative = path.relative(base, target);
            if (relative.startsWith("..") || path.isAbsolute(relative))
              return res.status(400).json({ message: "Invalid file path" });
            if (fs.existsSync(target)) fs.unlinkSync(target);
          } catch {
            // Failure here is non-fatal and the surrounding flow continues deliberately.
          }
        }

        await db
          .update(factoryShippingContainerRows)
          .set({
            shippingInvoiceFileName: null,
            shippingInvoiceOriginalName: null,
            shippingInvoiceFileUrl: null,
            shippingInvoiceFileData: null,
            shippingInvoiceFileType: null,
            updatedAt: new Date(),
          })
          .where(eq(factoryShippingContainerRows.id, id));

        res.json({ ok: true });
      } catch (error: unknown) {
        logger.error("Error deleting shipping invoice:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  // ── GET serve shipping-company invoice file ───────────────────────────────────
  app.get("/api/factory/shipping-invoice-docs/:filename", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const filename = req.params.filename;

      // Path traversal guard (applied before any I/O)
      const base = path.resolve(process.cwd(), "uploads", "shipping-invoice-docs");
      const diskPath = path.resolve(base, filename);
      const relative = path.relative(base, diskPath);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        return res.status(400).json({ message: "Invalid filename" });
      }

      // A. Query DB first — ownership must be verified before serving any file
      const [row] = await db
        .select({
          shippingInvoiceFileData: factoryShippingContainerRows.shippingInvoiceFileData,
          shippingInvoiceFileType: factoryShippingContainerRows.shippingInvoiceFileType,
          shippingInvoiceOriginalName: factoryShippingContainerRows.shippingInvoiceOriginalName,
          companyId: factoryShippingContainerRows.companyId,
        })
        .from(factoryShippingContainerRows)
        .where(eq(factoryShippingContainerRows.shippingInvoiceFileName, filename));

      // B. No DB row → 404
      if (!row) return res.status(404).json({ message: "File not found" });
      // C. Company mismatch → 403
      if (row.companyId !== companyId) return res.status(403).json({ message: "Forbidden" });

      // D. Serve from disk cache if available
      if (fs.existsSync(diskPath)) return res.sendFile(diskPath);

      // E. Fall back to DB data
      if (!row.shippingInvoiceFileData) return res.status(404).json({ message: "File data unavailable" });

      const buffer = Buffer.from(row.shippingInvoiceFileData, "base64");
      if (row.shippingInvoiceFileType) res.setHeader("Content-Type", row.shippingInvoiceFileType);
      res.setHeader("Content-Disposition", `inline; filename="${safeDownloadName(row.shippingInvoiceOriginalName)}"`);
      res.send(buffer);
    } catch (error: unknown) {
      logger.error("Error serving shipping invoice:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ── POST cleanup ghost document records ──────────────────────────────────────
  // Admin/dev utility: removes rows with no real file content.
  app.post("/api/factory/shipping-container-docs/cleanup-ghosts", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const result = await db.execute(sql`
        DELETE FROM factory_shipping_container_documents
        WHERE company_id = ${companyId}
          AND (file_name IS NULL OR file_name = '' OR file_name = '-')
          AND file_data IS NULL
          AND (file_url IS NULL OR file_url = '' OR file_url = '-')
      `);

      const removed = result.rowCount ?? 0;
      res.json({ success: true, removed });
    } catch (error: unknown) {
      logger.error("Error cleaning up ghost documents:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
