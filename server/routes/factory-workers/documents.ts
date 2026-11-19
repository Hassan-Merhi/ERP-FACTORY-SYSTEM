/**
 * factoryWorkerRoutes: FactoryWorkerDocument endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Database } from "../../db";
import type { Express, Request, Response, RequestHandler } from "express";
import { parseId } from "../../lib/parseId";
import { validateRequest } from "../../lib/validateRequest";
import { deleteWorkerDocumentInput, workerDocumentUploadInput } from "./factoryWorkerWriteSchemas";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { eq, and, desc } from "drizzle-orm";
import path from "path";
import fs from "fs";
import { factoryWorkerDocuments } from "@shared/schema";

import { getFactoryCompanyId } from "./_helpers";
import multer from "multer";

export function registerFactoryWorkerDocumentRoutes(app: Express, requireAuth: RequestHandler, db: Database) {
  // Use memory storage so file bytes are always available in req.file.buffer —
  // no disk dependency for the primary save path. Ephemeral disk environments
  // (Replit/Render deployments) cannot reliably persist files across restarts,
  // so base64 content is stored directly in the DB column.
  const docUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
  });

  // POST /api/factory/workers/:id/documents - Upload document
  app.post(
    "/api/factory/workers/:id/documents",
    requireAuth,
    docUpload.single("file"),
    validateRequest(workerDocumentUploadInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = getFactoryCompanyId(req);
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const workerId = parseId(req.params.id);
        if (workerId === null) return res.status(400).json({ message: "Invalid id" });
        if (!req.file) return res.status(400).json({ message: "No file uploaded" });

        // Generate a stable filename (same format as before so existing URLs keep working)
        const ext = path.extname(req.file.originalname);
        const generatedFilename = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
        const fileUrl = `/api/factory/uploads/workers/docs/${generatedFilename}`;

        // Store base64 content directly from the in-memory buffer — guaranteed
        // to succeed regardless of disk availability.
        const fileData = req.file.buffer.toString("base64");

        // Optionally write to disk as a fast-path cache for subsequent serves.
        try {
          const dir = path.join(process.cwd(), "uploads", "workers", "docs");
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, generatedFilename), req.file.buffer);
        } catch (cacheErr) {
          // Non-fatal — DB is the source of truth; disk is just a cache.
          logger.warn("Worker doc disk cache write failed (non-fatal):", { error: cacheErr });
        }

        const [doc] = await db
          .insert(factoryWorkerDocuments)
          .values({
            companyId,
            workerId,
            fileName: generatedFilename,
            originalName: req.file.originalname,
            fileUrl,
            fileType: req.file.mimetype,
            fileSize: req.file.size,
            fileData,
          })
          .returning();
        res.json(doc);
      } catch (error: unknown) {
        logger.error("Error uploading worker document:", { error: error });
        res.status(400).json({ message: getErrorMessage(error) });
      }
    }
  );

  // GET /api/factory/workers/:id/documents - List documents
  // Note: file_data is intentionally excluded — it's a (potentially large)
  // base64 blob and the listing UI only needs metadata. The actual bytes
  // are streamed from /api/factory/uploads/workers/docs/:filename.
  app.get("/api/factory/workers/:id/documents", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getFactoryCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const workerId = parseId(req.params.id);
      if (workerId === null) return res.status(400).json({ message: "Invalid id" });
      const docs = await db
        .select({
          id: factoryWorkerDocuments.id,
          companyId: factoryWorkerDocuments.companyId,
          workerId: factoryWorkerDocuments.workerId,
          fileName: factoryWorkerDocuments.fileName,
          originalName: factoryWorkerDocuments.originalName,
          fileUrl: factoryWorkerDocuments.fileUrl,
          fileType: factoryWorkerDocuments.fileType,
          fileSize: factoryWorkerDocuments.fileSize,
          uploadedAt: factoryWorkerDocuments.uploadedAt,
        })
        .from(factoryWorkerDocuments)
        .where(and(eq(factoryWorkerDocuments.workerId, workerId), eq(factoryWorkerDocuments.companyId, companyId)))
        .orderBy(desc(factoryWorkerDocuments.uploadedAt));
      res.json(docs);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // DELETE /api/factory/workers/:id/documents/:docId - Delete document
  app.delete(
    "/api/factory/workers/:id/documents/:docId",
    requireAuth,
    validateRequest(deleteWorkerDocumentInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = getFactoryCompanyId(req);
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const workerId = parseId(req.params.id);
        if (workerId === null) return res.status(400).json({ message: "Invalid id" });
        const docId = parseId(req.params.docId);
        if (docId === null) return res.status(400).json({ message: "Invalid id" });
        const [doc] = await db
          .select()
          .from(factoryWorkerDocuments)
          .where(
            and(
              eq(factoryWorkerDocuments.id, docId),
              eq(factoryWorkerDocuments.workerId, workerId),
              eq(factoryWorkerDocuments.companyId, companyId)
            )
          );
        if (!doc) return res.status(404).json({ message: "Document not found" });
        const filePath = path.join(process.cwd(), "uploads", "workers", "docs", doc.fileName);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        await db.delete(factoryWorkerDocuments).where(eq(factoryWorkerDocuments.id, docId));
        res.json({ success: true });
      } catch (error: unknown) {
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  // GET /api/factory/uploads/workers/docs/:filename - Serve worker documents
  // Resolution order:
  //   1. Local disk cache (fast, used right after upload).
  //   2. Database fallback (file_data column) — needed because Render and
  //      Replit have ephemeral disks that get wiped on every redeploy.
  app.get("/api/factory/uploads/workers/docs/:filename", requireAuth, async (req: Request, res: Response) => {
    try {
      const filename = req.params.filename;
      const base = path.resolve(process.cwd(), "uploads", "workers", "docs");
      const filePath = path.resolve(base, filename);
      const relative = path.relative(base, filePath);

      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        return res.status(400).json({ message: "Invalid file path" });
      }

      if (fs.existsSync(filePath)) {
        return res.sendFile(filePath);
      }

      // Disk miss — fall back to the DB copy.
      const [doc] = await db
        .select({
          fileData: factoryWorkerDocuments.fileData,
          fileType: factoryWorkerDocuments.fileType,
          originalName: factoryWorkerDocuments.originalName,
        })
        .from(factoryWorkerDocuments)
        .where(eq(factoryWorkerDocuments.fileName, filename))
        .limit(1);

      if (!doc?.fileData) {
        return res.status(404).json({ message: "File not found" });
      }

      const buf = Buffer.from(doc.fileData, "base64");

      // Re-hydrate the disk cache so subsequent requests are fast.
      try {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(filePath, buf);
      } catch (cacheErr) {
        logger.error("Failed to re-hydrate worker doc disk cache:", { error: cacheErr });
      }

      res.setHeader("Content-Type", doc.fileType || "application/octet-stream");
      if (doc.originalName) {
        res.setHeader("Content-Disposition", `inline; filename="${doc.originalName.replace(/"/g, "")}"`);
      }
      res.send(buf);
    } catch (error: unknown) {
      logger.error("Error serving worker document:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
