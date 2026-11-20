// Extracted from ./docsRoutes.ts
import type { Express, NextFunction, Request, Response } from "express";
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
import { z } from "zod";
import {
  emptyQuery,
  stringParam,
  validateRequest,
  validatedInput,
  type RequestSchemas,
} from "../../../lib/validateRequest";

const createContainerDocTypeInput = {
  query: emptyQuery,
  body: insertContainerDocumentTypeSchema.strict(),
} satisfies RequestSchemas;

// Multipart form fields (strings after multer); the file itself is req.file.
const uploadContainerDocumentInput = {
  params: z.strictObject({ containerId: stringParam }),
  query: emptyQuery,
  body: z.union([
    z.undefined(),
    z.strictObject({ docTypeId: z.union([z.string(), z.number()]).optional(), txDate: z.string().optional() }),
  ]),
} satisfies RequestSchemas;

const deleteContainerDocumentInput = {
  params: z.strictObject({ containerId: stringParam, docId: stringParam }),
  query: emptyQuery,
  body: z.union([z.undefined(), z.strictObject({ txDate: z.string().optional() })]),
} satisfies RequestSchemas;

/** Parses the multipart upload (memory storage, 20 MB) before validateRequest reads its fields. */
async function containerDocumentUpload(req: Request, res: Response, next: NextFunction) {
  try {
    const multer = (await import("multer")).default;
    // Use memory storage so file bytes are available for DB storage (avoids ephemeral-disk loss in production)
    const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
    upload.single("file")(req, res, (err) => {
      if (err) return res.status(400).json({ message: err.message });
      next();
    });
  } catch (error: unknown) {
    res.status(500).json({ message: getErrorMessage(error) });
  }
}

export function registerFactoryDocsRoutesPart1(app: Express) {
  app.post(
    "/api/factory/container-doc-types",
    requireAuth,
    validateRequest(createContainerDocTypeInput),
    async (req: Request, res: Response) => {
      try {
        // insertContainerDocumentTypeSchema (code and label required, id and
        // createdAt omitted) is checked by validateRequest before this runs.
        const { body } = validatedInput(req, createContainerDocTypeInput);
        const [row] = await db.insert(containerDocumentTypes).values(body).returning();
        res.json(row);
      } catch (error: unknown) {
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  // ─────── CONTAINER DOCUMENTS (upload / list / delete) ───────

  // This GET endpoint is owned by an earlier canonical route registrar.

  app.post(
    "/api/factory/containers/:containerId/documents",
    requireAuth,
    containerDocumentUpload,
    validateRequest(uploadContainerDocumentInput),
    async (req: Request, res: Response) => {
      try {
        const pathLib = await import("path");
        const fsLib = await import("fs");
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

        const docType = await db.select().from(containerDocumentTypes).where(eq(containerDocumentTypes.id, docTypeId));
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
    }
  );

  app.delete(
    "/api/factory/containers/:containerId/documents/:docId",
    requireAuth,
    validateRequest(deleteContainerDocumentInput),
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
