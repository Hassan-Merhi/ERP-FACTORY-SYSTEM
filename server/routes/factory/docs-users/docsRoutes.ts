/**
 * factoryDocsUsersRoutes: FactoryDocs endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getClientDate } from "../../../lib/dateUtils";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { sanitiseFilename, contentDisposition } from "../../../lib/contentDisposition";
import { requireAuth } from "../../../auth";
import { writeDaybookEntry, isLegacySHA256Hash, verifySupervisorPassword } from "../_helpers";
import { users, userCompanyRoles, containerDocumentTypes, containerDocuments, containers } from "@shared/schema";
import { eq, and, inArray } from "drizzle-orm";
import bcrypt from "bcryptjs";
import path from "path";
import fs from "fs";

import { safeSendFile, verifyContainerOwnership } from "./_helpers";

export function registerFactoryDocsRoutes(app: Express) {
  // ─────────────────────────────────────────────────────────────────────────────
  // ADMIN OVERRIDE VERIFICATION
  // Validates admin credentials and grants a 10-minute session override token
  // that allows non-admin users to perform admin-only actions after approval.
  // ─────────────────────────────────────────────────────────────────────────────
  app.post(
    "/api/factory/admin-verify",
    requireAuth,
    async (req: import("express").Request, res: import("express").Response) => {
      try {
        const { username, password } = req.body as { username?: string; password?: string };
        if (!username || !password) {
          return res.status(400).json({ message: "Username and password are required." });
        }

        // Look up the user
        const [targetUser] = await db.select().from(users).where(eq(users.username, username));
        if (!targetUser) {
          return res.status(401).json({ message: "Invalid username or password." });
        }

        // Confirm the user account is active
        if (!targetUser.active) {
          return res.status(403).json({ message: "This account is inactive and cannot authorize actions." });
        }

        // Verify password (bcrypt or legacy SHA256)
        const valid = await (async () => {
          if (isLegacySHA256Hash(targetUser.password)) {
            return verifySupervisorPassword(password, targetUser.password);
          }
          return bcrypt.compare(password, targetUser.password);
        })();

        if (!valid) {
          return res.status(401).json({ message: "Invalid username or password." });
        }

        // Confirm the user has an admin-level role (Admin / Owner / Developer)
        const ADMIN_ROLES = ["Admin", "Owner", "Developer"];
        const companyId = req.session?.factoryCompanyId || req.session?.currentCompanyId;

        let hasAdminRole = false;
        if (companyId) {
          const [roleRow] = await db
            .select({ role: userCompanyRoles.role })
            .from(userCompanyRoles)
            .where(and(eq(userCompanyRoles.userId, targetUser.id), eq(userCompanyRoles.companyId, companyId)));
          if (roleRow && ADMIN_ROLES.includes(roleRow.role)) hasAdminRole = true;
        }

        // Fallback: check any company role
        if (!hasAdminRole) {
          const anyAdminRole = await db
            .select({ role: userCompanyRoles.role })
            .from(userCompanyRoles)
            .where(and(eq(userCompanyRoles.userId, targetUser.id), inArray(userCompanyRoles.role, ADMIN_ROLES)));
          if (anyAdminRole.length > 0) hasAdminRole = true;
        }

        if (!hasAdminRole) {
          return res.status(403).json({ message: "The provided credentials do not belong to an admin user." });
        }

        // Grant a 10-minute override window in the session
        const expiresAt = Date.now() + 10 * 60 * 1000;
        req.session.factoryAdminOverrideUntil = expiresAt;
        req.session.factoryAdminOverrideBy = targetUser.username;

        return res.json({ success: true, expiresAt, adminUsername: targetUser.username });
      } catch (error: unknown) {
        return res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  app.get(
    "/api/factory/container-doc-types",
    requireAuth,
    async (req: import("express").Request, res: import("express").Response) => {
      try {
        const rows = await db.select().from(containerDocumentTypes).orderBy(containerDocumentTypes.label);
        res.json(rows);
      } catch (error: unknown) {
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  app.post(
    "/api/factory/container-doc-types",
    requireAuth,
    async (req: import("express").Request, res: import("express").Response) => {
      try {
        const [row] = await db.insert(containerDocumentTypes).values(req.body).returning();
        res.json(row);
      } catch (error: unknown) {
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  // ─────── CONTAINER DOCUMENTS (upload / list / delete) ───────

  app.get(
    "/api/factory/containers/:containerId/documents",
    requireAuth,
    async (req: import("express").Request, res: import("express").Response) => {
      try {
        const containerId = Number(req.params.containerId);
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId || !(await verifyContainerOwnership(containerId, companyId))) {
          return res.status(403).json({ message: "Access denied" });
        }
        const rawDocs = await db
          .select()
          .from(containerDocuments)
          .where(eq(containerDocuments.containerId, containerId));
        const docTypes = await db.select().from(containerDocumentTypes).orderBy(containerDocumentTypes.label);
        const requiredTypes = docTypes.filter((dt) => dt.isRequired);
        const uploadedTypeIds = new Set(rawDocs.map((d) => d.docTypeId));
        const completeness = {
          total: requiredTypes.length,
          uploaded: requiredTypes.filter((rt) => uploadedTypeIds.has(rt.id)).length,
          complete: requiredTypes.every((rt) => uploadedTypeIds.has(rt.id)),
        };
        // Mark ghost docs (no storage key AND no file data) so the client
        // can show a delete-only state instead of a broken download button.
        const docs = rawDocs.map((d) => ({
          ...d,
          fileData: undefined, // strip large blob from listing response
          isGhost: !d.storageKey && !d.fileData,
        }));
        res.json({ documents: docs, docTypes, completeness });
      } catch (error: unknown) {
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  app.post(
    "/api/factory/containers/:containerId/documents",
    requireAuth,
    async (req: import("express").Request, res: import("express").Response) => {
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
    }
  );

  app.delete(
    "/api/factory/containers/:containerId/documents/:docId",
    requireAuth,
    async (req: import("express").Request, res: import("express").Response) => {
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

  // Authenticated, path-traversal-safe file serving.
  // Only the document's owner company can download a container-doc file.
  app.get(
    "/api/factory/uploads/:folder/:filename",
    requireAuth,
    async (req: import("express").Request, res: import("express").Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(403).json({ message: "Access denied" });

        const folder = String(req.params.folder);
        const filename = String(req.params.filename);

        // Reject any path-traversal attempts
        if (
          folder.includes("..") ||
          folder.includes("/") ||
          folder.includes("\\") ||
          filename.includes("..") ||
          filename.includes("/") ||
          filename.includes("\\")
        ) {
          return res.status(400).json({ message: "Invalid file path" });
        }

        // For container-doc files, verify the requesting company owns a document with that key
        const storageKey = `${folder}/${filename}`;
        if (folder === "container-docs") {
          const [doc] = await db
            .select({
              companyId: containerDocuments.companyId,
              fileData: containerDocuments.fileData,
              mimeType: containerDocuments.mimeType,
              fileName: containerDocuments.fileName,
            })
            .from(containerDocuments)
            .where(eq(containerDocuments.storageKey, storageKey));
          if (!doc || doc.companyId !== companyId) {
            return res.status(403).json({ message: "Access denied" });
          }

          // Try disk cache first
          const diskPath = path.join(process.cwd(), "uploads", folder, filename);
          if (fs.existsSync(diskPath)) return res.sendFile(diskPath);

          // Fall back to DB-stored file data
          if (!doc.fileData) {
            return res.status(404).json({
              message:
                "File content is not stored in the database. This document was uploaded before cloud storage was enabled. Please delete and re-upload the file.",
            });
          }
          const buffer = Buffer.from(doc.fileData, "base64");
          const ct = doc.mimeType || "application/octet-stream";
          res.setHeader("Content-Type", ct);
          const isInline = ct.startsWith("image/") || ct === "application/pdf";
          res.setHeader(
            "Content-Disposition",
            contentDisposition(sanitiseFilename(doc.fileName || "download"), isInline ? "inline" : "attachment")
          );
          return res.send(buffer);
        }

        safeSendFile(res, folder, filename);
      } catch (error: unknown) {
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}
