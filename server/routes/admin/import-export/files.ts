/**
 * importExportRoutes: File endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { upload } from "../../_helpers";
import { storedFiles, fileFolders } from "@shared/schema";
import { eq, and, desc, asc } from "drizzle-orm";

export function registerFileRoutes(app: Express) {
  app.get("/api/file-folders", requireAuth, async (req: import("express").Request, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      if (!companyId) return res.status(400).json({ message: "No company context" });
      const folders = await db
        .select()
        .from(fileFolders)
        .where(eq(fileFolders.companyId, companyId))
        .orderBy(asc(fileFolders.name));
      res.json(folders);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/file-folders", requireAuth, async (req: import("express").Request, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      if (!companyId) return res.status(400).json({ message: "No company context" });
      const { name } = req.body;
      if (!name?.trim()) return res.status(400).json({ message: "Folder name required" });
      const [folder] = await db.insert(fileFolders).values({ companyId, name: name.trim() }).returning();
      res.json(folder);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.patch("/api/file-folders/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const folderId = parseInt(req.params.id);
      const { name } = req.body;
      if (!name?.trim()) return res.status(400).json({ message: "Folder name required" });
      const [updated] = await db
        .update(fileFolders)
        .set({ name: name.trim() })
        .where(and(eq(fileFolders.id, folderId), eq(fileFolders.companyId, companyId)))
        .returning();
      if (!updated) return res.status(404).json({ message: "Folder not found" });
      res.json(updated);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.delete("/api/file-folders/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const folderId = parseInt(req.params.id);
      const filesInFolder = await db
        .select({ id: storedFiles.id })
        .from(storedFiles)
        .where(and(eq(storedFiles.companyId, companyId), eq(storedFiles.folderId, folderId)));
      if (filesInFolder.length > 0) {
        return res.status(409).json({
          message: `Folder has ${filesInFolder.length} file(s). Move or delete them first.`,
          fileCount: filesInFolder.length,
        });
      }
      const [deleted] = await db
        .delete(fileFolders)
        .where(and(eq(fileFolders.id, folderId), eq(fileFolders.companyId, companyId)))
        .returning({ id: fileFolders.id });
      if (!deleted) return res.status(404).json({ message: "Folder not found" });
      res.json({ message: "Folder deleted" });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ── File Storage ─────────────────────────────────────────────
  app.get("/api/files", requireAuth, async (req: import("express").Request, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      if (!companyId) return res.status(400).json({ message: "No company context" });
      const files = await db
        .select({
          id: storedFiles.id,
          folderId: storedFiles.folderId,
          fileName: storedFiles.fileName,
          displayName: storedFiles.displayName,
          fileType: storedFiles.fileType,
          fileSize: storedFiles.fileSize,
          description: storedFiles.description,
          uploadedBy: storedFiles.uploadedBy,
          uploadedAt: storedFiles.uploadedAt,
        })
        .from(storedFiles)
        .where(eq(storedFiles.companyId, companyId))
        .orderBy(desc(storedFiles.uploadedAt));
      res.json(files);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/files/upload", requireAuth, upload.single("file"), async (req: import("express").Request, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      if (!companyId) return res.status(400).json({ message: "No company context" });
      if (!req.file) return res.status(400).json({ message: "No file uploaded" });
      const { description, folderId } = req.body;
      const fileData = req.file.buffer.toString("base64");
      const folderIdNum = folderId ? parseInt(folderId) : null;
      const [inserted] = await db
        .insert(storedFiles)
        .values({
          companyId,
          folderId: folderIdNum,
          fileName: req.file.originalname,
          displayName: null,
          fileType: req.file.mimetype,
          fileSize: req.file.size,
          fileData,
          description: description || null,
          uploadedBy: null,
        })
        .returning({ id: storedFiles.id });
      res.json({ id: inserted.id, message: "File uploaded successfully" });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.patch("/api/files/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const fileId = parseInt(req.params.id);
      const { displayName, folderId } = req.body;
      const updates: PgUpdateSetSource<typeof storedFiles> = {};
      if (displayName !== undefined) updates.displayName = displayName || null;
      if (folderId !== undefined) updates.folderId = folderId === null ? null : parseInt(folderId);
      if (Object.keys(updates).length === 0) return res.status(400).json({ message: "Nothing to update" });
      const [updated] = await db
        .update(storedFiles)
        .set(updates)
        .where(and(eq(storedFiles.id, fileId), eq(storedFiles.companyId, companyId)))
        .returning({ id: storedFiles.id });
      if (!updated) return res.status(404).json({ message: "File not found" });
      res.json({ message: "File updated" });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/files/:id/download", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const fileId = parseInt(req.params.id);
      const [file] = await db
        .select()
        .from(storedFiles)
        .where(and(eq(storedFiles.id, fileId), eq(storedFiles.companyId, companyId)));
      if (!file) return res.status(404).json({ message: "File not found" });
      const buffer = Buffer.from(file.fileData, "base64");
      const outName = file.displayName || file.fileName;
      res.set("Content-Type", file.fileType);
      res.set("Content-Disposition", `attachment; filename="${encodeURIComponent(outName)}"`);
      res.set("Content-Length", buffer.length.toString());
      res.send(buffer);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/files/:id/preview", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const fileId = parseInt(req.params.id);
      const [file] = await db
        .select()
        .from(storedFiles)
        .where(and(eq(storedFiles.id, fileId), eq(storedFiles.companyId, companyId)));
      if (!file) return res.status(404).json({ message: "File not found" });
      const buffer = Buffer.from(file.fileData, "base64");
      res.set("Content-Type", file.fileType);
      res.set("Content-Disposition", `inline; filename="${encodeURIComponent(file.displayName || file.fileName)}"`);
      res.set("Content-Length", buffer.length.toString());
      res.send(buffer);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.delete("/api/files/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const fileId = parseInt(req.params.id);
      const [deleted] = await db
        .delete(storedFiles)
        .where(and(eq(storedFiles.id, fileId), eq(storedFiles.companyId, companyId)))
        .returning({ id: storedFiles.id });
      if (!deleted) return res.status(404).json({ message: "File not found" });
      res.json({ message: "File deleted" });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
