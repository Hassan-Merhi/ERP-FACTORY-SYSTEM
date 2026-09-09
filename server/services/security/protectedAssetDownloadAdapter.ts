import type { Database } from "../../db";
import type { NextFunction, Request, Response } from "express";
import fs from "fs";
import path from "path";
import { eq } from "drizzle-orm";
import { containerDocuments } from "@shared/schema";
import {
  ProtectedAssetAccessError,
  authorizeProtectedAssetAccess,
  type ProtectedAssetLookup,
  type ProtectedAssetRecord,
} from "./protectedAssetAccessPolicy";
import { AuthorizationDeniedError, type AuthorizationActor } from "./authorizationPolicy";

interface ContainerDocumentAsset extends ProtectedAssetRecord {
  fileData: string | null;
}

function actorFromRequest(req: Request): AuthorizationActor | null {
  const session = req.session;
  const companyId = session.currentCompanyId;
  if (!session.userId || !session.currentRole || !companyId) return null;
  if (session.factoryCompanyId != null && session.factoryCompanyId !== companyId) return null;
  return {
    userId: session.userId,
    role: session.currentRole,
    companyId,
    permissions: Array.isArray(session.securityPermissions)
      ? session.securityPermissions.filter((item): item is string => typeof item === "string")
      : [],
  };
}

export function attachmentContentDisposition(fileName: string): string {
  const asciiFallback = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\;]/g, "_");
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export async function authorizeContainerDocumentDownload(
  lookup: ProtectedAssetLookup,
  actor: AuthorizationActor | null,
  storageKey: string
) {
  return authorizeProtectedAssetAccess(lookup, {
    actor,
    assetId: storageKey,
    kind: "attachment",
    action: "download",
    domain: "factory",
    requiredPermission: "factory.documents.download",
    // Preserve current behavior for authenticated factory roles while the shared
    // policy supplies the canonical same-company and asset-integrity boundary.
    allowedRoles: actor?.role ? [actor.role] : [],
  });
}

/**
 * Serves container documents through the Program 3 protected-asset boundary.
 * Other legacy upload folders are delegated to the existing route.
 */
export function createContainerDocumentDownloadHandler(db: Database) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const folder = String(req.params.folder ?? "");
    if (folder !== "container-docs") return next();

    const filename = String(req.params.filename ?? "");
    const storageKey = `${folder}/${filename}`;
    const lookup: ProtectedAssetLookup = {
      async loadAsset(assetId, kind) {
        if (kind !== "attachment" || String(assetId) !== storageKey) return null;
        const [doc] = await db
          .select({
            id: containerDocuments.id,
            companyId: containerDocuments.companyId,
            uploadedBy: containerDocuments.uploadedBy,
            storageKey: containerDocuments.storageKey,
            fileName: containerDocuments.fileName,
            mimeType: containerDocuments.mimeType,
            fileData: containerDocuments.fileData,
          })
          .from(containerDocuments)
          .where(eq(containerDocuments.storageKey, storageKey))
          .limit(1);
        if (!doc) return null;
        const byteSize = doc.fileData ? Buffer.from(doc.fileData, "base64").byteLength : null;
        return {
          id: doc.id,
          kind: "attachment",
          companyId: doc.companyId,
          ownerUserId: doc.uploadedBy,
          storageKey: doc.storageKey,
          fileName: doc.fileName,
          mimeType: doc.mimeType,
          byteSize,
          deletedAt: null,
          fileData: doc.fileData,
        } as ContainerDocumentAsset;
      },
    };

    try {
      const decision = await authorizeContainerDocumentDownload(lookup, actorFromRequest(req), storageKey);
      const asset = decision.asset as ContainerDocumentAsset;
      const safeFileName = decision.safeFileName ?? "download";
      const mimeType = asset.mimeType || "application/octet-stream";
      const diskPath = path.join(process.cwd(), "uploads", asset.storageKey!);

      res.setHeader("Content-Type", mimeType);
      res.setHeader("Content-Disposition", attachmentContentDisposition(safeFileName));
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "private, no-store");

      if (fs.existsSync(diskPath)) return res.sendFile(diskPath);
      if (!asset.fileData) return res.status(404).json({ message: "Not found" });
      return res.send(Buffer.from(asset.fileData, "base64"));
    } catch (error) {
      if (error instanceof AuthorizationDeniedError) {
        return res.status(404).json({ message: "Not found" });
      }
      if (error instanceof ProtectedAssetAccessError) {
        const forbidden = error.message === "Forbidden";
        return res.status(forbidden ? 403 : 404).json({ message: forbidden ? "Forbidden" : "Not found" });
      }
      return next(error);
    }
  };
}
