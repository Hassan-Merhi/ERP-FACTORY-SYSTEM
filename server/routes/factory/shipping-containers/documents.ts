/**
 * factoryShippingContainerRoutes: ShippingContainerDocument endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
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

export function registerShippingContainerDocumentRoutes(app: Express) {
  // ── GET documents for a row ───────────────────────────────────────────────────
  app.get("/api/factory/shipping-container-rows/:id/documents", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid id" });

      const [row] = await db
        .select({ id: factoryShippingContainerRows.id })
        .from(factoryShippingContainerRows)
        .where(and(eq(factoryShippingContainerRows.id, id), eq(factoryShippingContainerRows.companyId, companyId)));
      if (!row) return res.status(404).json({ message: "Row not found" });

      const allDocs = await db
        .select({
          id: factoryShippingContainerDocuments.id,
          scrId: factoryShippingContainerDocuments.scrId,
          displayName: factoryShippingContainerDocuments.displayName,
          fileName: factoryShippingContainerDocuments.fileName,
          originalName: factoryShippingContainerDocuments.originalName,
          fileUrl: factoryShippingContainerDocuments.fileUrl,
          fileType: factoryShippingContainerDocuments.fileType,
          fileSize: factoryShippingContainerDocuments.fileSize,
          uploadedBy: factoryShippingContainerDocuments.uploadedBy,
          uploadedAt: factoryShippingContainerDocuments.uploadedAt,
          hasFileData: factoryShippingContainerDocuments.fileData,
          // fileData full content intentionally excluded — large blob not needed for listing
        })
        .from(factoryShippingContainerDocuments)
        .where(
          and(
            eq(factoryShippingContainerDocuments.scrId, id),
            eq(factoryShippingContainerDocuments.companyId, companyId)
          )
        )
        .orderBy(factoryShippingContainerDocuments.uploadedAt);

      // Ghost detection: a doc is a ghost if it has no stored file_data.
      // file_data is the source of truth — disk is ephemeral and cannot be relied upon.
      // A row with file_data IS NULL was created before DB storage was added and
      // cannot be served. Any row with blank/dash fileName or missing display name
      // is also a ghost.
      function detectGhost(doc: (typeof allDocs)[0], hasFileData: string | null): boolean {
        if (!hasFileData || hasFileData.trim() === "") return true;
        const fn = (doc.fileName ?? "").trim();
        if (!fn || fn === "-") return true;
        const noName =
          (!doc.originalName || doc.originalName.trim() === "") && (!doc.displayName || doc.displayName.trim() === "");
        if (noName) return true;
        return false;
      }

      const docs = allDocs.map(({ hasFileData, ...doc }) => {
        const ghost = detectGhost({ ...doc, hasFileData } as (typeof allDocs)[0], hasFileData);
        if (ghost) {
          return {
            ...doc,
            isGhost: true,
            displayName: "Broken record",
            originalName: "",
            fileType: null,
            fileSize: null,
            uploadedBy: null,
          };
        }
        return { ...doc, isGhost: false };
      });

      res.json(docs);
    } catch (error: unknown) {
      logger.error("Error fetching documents:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ── POST upload document ──────────────────────────────────────────────────────
  app.post(
    "/api/factory/shipping-container-rows/:id/documents",
    requireAuth,
    scrUpload,
    async (req: Request, res: Response) => {
      try {
        const companyId = getCompanyId(req);
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const id = parseInt(req.params.id);
        if (isNaN(id)) return res.status(400).json({ message: "Invalid id" });
        if (!req.file) return res.status(400).json({ message: "No file uploaded" });
        if (!req.file.buffer || req.file.buffer.length === 0) {
          return res.status(400).json({ message: "Uploaded file is empty" });
        }
        if (!req.file.originalname || req.file.originalname.trim() === "") {
          return res.status(400).json({ message: "File name is required" });
        }

        const [row] = await db
          .select({ id: factoryShippingContainerRows.id })
          .from(factoryShippingContainerRows)
          .where(and(eq(factoryShippingContainerRows.id, id), eq(factoryShippingContainerRows.companyId, companyId)));
        if (!row) return res.status(404).json({ message: "Row not found" });

        const displayName: string =
          (req.body.displayName as string)?.trim() || req.file.originalname.replace(/\.[^.]+$/, "");
        const ext = path.extname(req.file.originalname);
        const generatedFilename = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
        if (!generatedFilename || generatedFilename.trim() === "") {
          return res.status(400).json({ message: "Failed to generate file name" });
        }
        const fileUrl = `/api/factory/shipping-container-docs/${generatedFilename}`;
        const fileData = req.file.buffer.toString("base64");
        if (!fileData || fileData.trim() === "") {
          return res.status(400).json({ message: "Failed to encode file data" });
        }

        // Disk cache (non-fatal — DB is source of truth)
        try {
          const dir = path.join(process.cwd(), "uploads", "shipping-container-docs");
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, generatedFilename), req.file.buffer);
        } catch (e) {
          logger.warn("Shipping container doc disk cache write failed (non-fatal):", { error: e });
        }

        const username: string | null = req.session.username || req.session.email || req.session.name || null;

        const [doc] = await db
          .insert(factoryShippingContainerDocuments)
          .values({
            companyId,
            scrId: id,
            displayName,
            fileName: generatedFilename,
            originalName: req.file.originalname,
            fileUrl,
            fileType: req.file.mimetype,
            fileSize: req.file.size,
            fileData,
            uploadedBy: username,
          })
          .returning({
            id: factoryShippingContainerDocuments.id,
            scrId: factoryShippingContainerDocuments.scrId,
            displayName: factoryShippingContainerDocuments.displayName,
            fileName: factoryShippingContainerDocuments.fileName,
            originalName: factoryShippingContainerDocuments.originalName,
            fileUrl: factoryShippingContainerDocuments.fileUrl,
            fileType: factoryShippingContainerDocuments.fileType,
            fileSize: factoryShippingContainerDocuments.fileSize,
            uploadedBy: factoryShippingContainerDocuments.uploadedBy,
            uploadedAt: factoryShippingContainerDocuments.uploadedAt,
          });

        if (!doc || !doc.id || !doc.fileName || !doc.fileUrl) {
          return res.status(500).json({ message: "Upload failed: database did not return a valid document record" });
        }

        res.json({ ...doc, isGhost: false });
      } catch (error: unknown) {
        logger.error("Error uploading document:", { error: error });
        res.status(400).json({ message: getErrorMessage(error) });
      }
    }
  );

  // ── DELETE document ───────────────────────────────────────────────────────────
  app.delete(
    "/api/factory/shipping-container-rows/:id/documents/:docId",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const companyId = getCompanyId(req);
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const id = parseInt(req.params.id);
        const docId = parseInt(req.params.docId);
        if (isNaN(id) || isNaN(docId)) return res.status(400).json({ message: "Invalid id" });

        // Verify ownership through both tables in one query
        const [doc] = await db
          .select({
            id: factoryShippingContainerDocuments.id,
            fileName: factoryShippingContainerDocuments.fileName,
          })
          .from(factoryShippingContainerDocuments)
          .innerJoin(
            factoryShippingContainerRows,
            eq(factoryShippingContainerDocuments.scrId, factoryShippingContainerRows.id)
          )
          .where(
            and(
              eq(factoryShippingContainerDocuments.id, docId),
              eq(factoryShippingContainerDocuments.scrId, id),
              eq(factoryShippingContainerRows.companyId, companyId)
            )
          );
        if (!doc) return res.status(404).json({ message: "Document not found" });

        await db.delete(factoryShippingContainerDocuments).where(eq(factoryShippingContainerDocuments.id, docId));

        // Remove disk cache (non-fatal) — skip if fileName is blank/ghost
        if (doc.fileName && doc.fileName.trim() !== "" && doc.fileName.trim() !== "-") {
          try {
            const diskPath = path.join(process.cwd(), "uploads", "shipping-container-docs", doc.fileName);
            if (fs.existsSync(diskPath)) fs.unlinkSync(diskPath);
          } catch {
            // Failure here is non-fatal and the surrounding flow continues deliberately.
          }
        }

        res.json({ success: true, deletedId: docId });
      } catch (error: unknown) {
        logger.error("Error deleting document:", { error: error });
        res.status(400).json({ message: getErrorMessage(error) });
      }
    }
  );

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
