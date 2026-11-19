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
import { eq, and } from "drizzle-orm";
import path from "path";
import fs from "fs";
import { getCompanyId, scrUpload } from "./_helpers";
import { registerShippingContainerDocumentRoutesPart1 } from "./registerShippingContainerDocumentRoutesPart1";

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

  registerShippingContainerDocumentRoutesPart1(app);
}
