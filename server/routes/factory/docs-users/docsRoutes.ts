/**
 * factoryDocsUsersRoutes: FactoryDocs endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { db } from "../../../db";
import { sanitiseFilename, contentDisposition } from "../../../lib/contentDisposition";
import { requireAuth } from "../../../auth";
import { verifySupervisorPassword } from "../_helpers";
import { users, userCompanyRoles, containerDocumentTypes, containerDocuments } from "@shared/schema";
import { eq, and, inArray } from "drizzle-orm";
import { z } from "zod";
import { emptyQuery, validateRequest, type RequestSchemas } from "../../../lib/validateRequest";
import path from "path";
import fs from "fs";

import { safeSendFile } from "./_helpers";
import { registerFactoryDocsRoutesPart1 } from "./registerFactoryDocsRoutesPart1";

// client/src/components/AdminOverrideDialog.tsx; the handler keeps its own
// "Username and password are required." answer for empty values.
const adminVerifyInput = {
  query: emptyQuery,
  body: z.strictObject({ username: z.string().optional(), password: z.string().optional() }),
} satisfies RequestSchemas;

export function registerFactoryDocsRoutes(app: Express) {
  // ─────────────────────────────────────────────────────────────────────────────
  // ADMIN OVERRIDE VERIFICATION
  // Validates admin credentials and grants a 10-minute session override token
  // that allows non-admin users to perform admin-only actions after approval.
  // ─────────────────────────────────────────────────────────────────────────────
  app.post(
    "/api/factory/admin-verify",
    requireAuth,
    validateRequest(adminVerifyInput),
    async (req: Request, res: Response) => {
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

        // Privileged step-up requires bcrypt, never a legacy SHA-256 comparison.
        const valid = await verifySupervisorPassword(password, targetUser.password);

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

  app.get("/api/factory/container-doc-types", requireAuth, async (req: Request, res: Response) => {
    try {
      const rows = await db.select().from(containerDocumentTypes).orderBy(containerDocumentTypes.label);
      res.json(rows);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  registerFactoryDocsRoutesPart1(app);

  // Authenticated, path-traversal-safe file serving.
  // Only the document's owner company can download a container-doc file.
  app.get("/api/factory/uploads/:folder/:filename", requireAuth, async (req: Request, res: Response) => {
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
  });
}
