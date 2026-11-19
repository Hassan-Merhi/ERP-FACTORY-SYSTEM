// Extracted from ./docsRoutes.ts
import type { Express, Request, Response } from "express";
import { getClientDate } from "../../../lib/dateUtils";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { writeDaybookEntry } from "../_helpers";
import {
  containerDocumentTypes,
  containerDocuments,
  containers,
  insertContainerDocumentTypeSchema,
} from "@shared/schema";
import { eq, and } from "drizzle-orm";
import { verifyContainerOwnership } from "./_helpers";

export function registerFactoryDocsRoutesPart1(app: Express) {
  app.post("/api/factory/container-doc-types", requireAuth, async (req: Request, res: Response) => {
    try {
      // This inserted req.body wholesale, so a body missing the NOT NULL code
      // and label failed the insert as a 500 — and any field the caller
      // invented went straight at the table. insertContainerDocumentTypeSchema
      // already describes this row (code and label required, id and createdAt
      // omitted) and was going unused.
      const parsed = insertContainerDocumentTypeSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid body", errors: parsed.error.flatten() });
      }
      const [row] = await db.insert(containerDocumentTypes).values(parsed.data).returning();
      res.json(row);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ─────── CONTAINER DOCUMENTS (upload / list / delete) ───────

  // This GET endpoint is owned by an earlier canonical route registrar.

  app.post("/api/factory/containers/:containerId/documents", requireAuth, async (req: Request, res: Response) => {
    try {
      const multer = (await import("multer")).default;
      const pathLib = await import("path");
      const fsLib = await import("fs");
      // Use memory storage so file bytes are available for DB storage (avoids ephemeral-disk loss in production)
      const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

      upload.single("file")(req, res, async (err) => {
        try {
          if (err) return res.status(400).json({ message: err.message });
          if (!req.file) return res.status(400).json({ message: "No file uploaded" });

          const containerId = Number(req.params.containerId);
          const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
          const docTypeId = Number(req.body.docTypeId);
          if (!companyId || !docTypeId) return res.status(400).json({ message: "Missing companyId or docTypeId" });

          if (!(await verifyContainerOwnership(containerId, companyId))) {
            return res.status(403).json({ message: "Access denied" });
          }

          const ext = pathLib.default.extname(req.file.originalname);
          const generatedFilename = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
          const storageKey = `container-docs/${generatedFilename}`;
          const fileData = req.file.buffer.toString("base64");

          // Also write to disk cache (non-fatal — DB is source of truth)
          try {
            const uploadDir = pathLib.default.join(process.cwd(), "uploads", "container-docs");
            if (!fsLib.existsSync(uploadDir)) fsLib.mkdirSync(uploadDir, { recursive: true });
            fsLib.writeFileSync(pathLib.default.join(uploadDir, generatedFilename), req.file.buffer);
          } catch (diskErr) {
            logger.warn("Container doc disk cache write failed (non-fatal):", { error: diskErr });
          }

          const [doc] = await db
            .insert(containerDocuments)
            .values({
              companyId,
              containerId,
              docTypeId,
              fileName: req.file.originalname,
              storageKey,
              mimeType: req.file.mimetype,
              uploadedBy: req.session.userId || null,
              fileData,
            })
            .returning();

          const docType = await db
            .select()
            .from(containerDocumentTypes)
            .where(eq(containerDocumentTypes.id, docTypeId));
          const docTypeName = docType[0]?.label || "Document";

          await writeDaybookEntry(db, {
            companyId,
            txDate: req.body.txDate || getClientDate(req),
            txType: "DOC_UPLOAD",
            referenceId: containerId,
            referenceTable: "containers",
            description: `Uploaded ${docTypeName}: ${req.file.originalname} for container #${containerId}`,
            metaJson: JSON.stringify({ docId: doc.id, docTypeId, fileName: req.file.originalname }),
            createdBy: req.session.userId || undefined,
          });

          const allDocs = await db
            .select()
            .from(containerDocuments)
            .where(eq(containerDocuments.containerId, containerId));
          const allDocTypes = await db.select().from(containerDocumentTypes);
          const requiredTypes = allDocTypes.filter((dt) => dt.isRequired);
          const uploadedTypeIds = new Set(allDocs.map((d) => d.docTypeId));
          const allComplete = requiredTypes.every((rt) => uploadedTypeIds.has(rt.id));
          await db.update(containers).set({ docReceived: allComplete }).where(eq(containers.id, containerId));

          res.json(doc);
        } catch (innerErr: unknown) {
          logger.error("Error uploading container document:", { error: innerErr });
          res.status(500).json({ message: getErrorMessage(innerErr) });
        }
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.delete(
    "/api/factory/containers/:containerId/documents/:docId",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const containerId = Number(req.params.containerId);
        const docId = Number(req.params.docId);
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;

        if (!companyId || !(await verifyContainerOwnership(containerId, companyId))) {
          return res.status(403).json({ message: "Access denied" });
        }

        const [deleted] = await db
          .delete(containerDocuments)
          .where(and(eq(containerDocuments.id, docId), eq(containerDocuments.containerId, containerId)))
          .returning();
        if (!deleted) return res.status(404).json({ message: "Document not found" });

        const fs = await import("fs");
        const path = await import("path");
        const filePath = path.default.join(process.cwd(), "uploads", deleted.storageKey);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

        await writeDaybookEntry(db, {
          companyId: companyId || deleted.companyId,
          txDate: req.body?.txDate || getClientDate(req),
          txType: "DOC_DELETE",
          referenceId: containerId,
          referenceTable: "containers",
          description: `Deleted document: ${deleted.fileName} from container #${containerId}`,
          metaJson: JSON.stringify({ docId: deleted.id, fileName: deleted.fileName }),
          createdBy: req.session.userId || undefined,
        });

        const allDocs = await db
          .select()
          .from(containerDocuments)
          .where(eq(containerDocuments.containerId, containerId));
        const allDocTypes = await db.select().from(containerDocumentTypes);
        const requiredTypes = allDocTypes.filter((dt) => dt.isRequired);
        const uploadedTypeIds = new Set(allDocs.map((d) => d.docTypeId));
        const allComplete = requiredTypes.length > 0 && requiredTypes.every((rt) => uploadedTypeIds.has(rt.id));
        await db.update(containers).set({ docReceived: allComplete }).where(eq(containers.id, containerId));

        res.json({ success: true });
      } catch (error: unknown) {
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}
