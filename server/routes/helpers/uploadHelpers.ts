import type { NextFunction, Request, RequestHandler, Response } from "express";
import multer from "multer";
import { FILE_SIZE_LIMITS, generalUploadLimitBytes, sizeLimitLabel, spreadsheetImportLimitBytes } from "@shared/fileSizePolicy";

import {
  createTenantDatabaseScope,
  getDatabaseScopeRuntimeContext,
  runWithDatabaseScopeRuntimeContext,
} from "../../services/security/databaseScopeRuntimeContext";

const baseUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

function continueInSessionTenantScope(req: Request, res: Response, next: NextFunction): void {
  if (!req.session?.userId) {
    next();
    return;
  }

  const companyId = Number(req.session.currentCompanyId);
  if (!Number.isSafeInteger(companyId) || companyId <= 0) {
    next();
    return;
  }

  const currentScope = getDatabaseScopeRuntimeContext();
  if (currentScope?.kind === "tenant" && currentScope.companyId !== companyId) {
    res.status(403).json({
      code: "UPLOAD_COMPANY_SCOPE_MISMATCH",
      message: "Upload company scope does not match the active company.",
    });
    return;
  }

  const tenantScope =
    currentScope?.kind === "tenant" ? currentScope : createTenantDatabaseScope(companyId, [], "active-company");

  runWithDatabaseScopeRuntimeContext(tenantScope, () => next());
}

function withPostMultipartTenantScope(middleware: RequestHandler): RequestHandler {
  // The route manifest records each handler slot by function name, and this wrapper occupies the
  // multipart slot that Multer used to fill directly. Keeping the name means the snapshot still
  // reads `multerMiddleware` for every upload route, so a genuine handler-chain change stays
  // visible instead of being buried under a rename of every upload route at once.
  const multerMiddleware: RequestHandler = (req, res, next) => {
    middleware(req, res, (error?: unknown) => {
      if (error) {
        next(error);
        return;
      }

      continueInSessionTenantScope(req, res, next);
    });
  };
  return multerMiddleware;
}

/**
 * Multer can complete its multipart work from async resources that do not retain
 * request AsyncLocalStorage state. Every upload middleware therefore re-roots
 * the already-authenticated session company scope after Multer finishes and
 * immediately before the route handler executes.
 *
 * This does not authorize a company supplied by the request body. The only
 * fallback scope comes from the server-owned authenticated session company, and
 * an existing conflicting tenant scope still fails closed.
 */
export const upload = new Proxy(baseUpload, {
  get(target, property, receiver) {
    if (property === "single") {
      return (...args: Parameters<typeof target.single>) => withPostMultipartTenantScope(target.single(...args));
    }
    if (property === "array") {
      return (...args: Parameters<typeof target.array>) => withPostMultipartTenantScope(target.array(...args));
    }
    if (property === "fields") {
      return (...args: Parameters<typeof target.fields>) => withPostMultipartTenantScope(target.fields(...args));
    }
    if (property === "none") {
      return (...args: Parameters<typeof target.none>) => withPostMultipartTenantScope(target.none(...args));
    }
    if (property === "any") {
      return (...args: Parameters<typeof target.any>) => withPostMultipartTenantScope(target.any(...args));
    }

    return Reflect.get(target, property, receiver);
  },
});

/**
 * Role-aware Excel imports and general file-store uploads. Create the parser
 * after authentication using only req.session.currentRole, never form fields.
 * The existing 10 MB `upload` remains for specialized legacy endpoints.
 */
function scopedPolicyUpload(kind: "spreadsheet" | "general") {
  return {
    single(fieldName: string): RequestHandler {
      return withPostMultipartTenantScope((req, res, next) => {
        const maxBytes = kind === "spreadsheet"
          ? spreadsheetImportLimitBytes(req.session?.currentRole)
          : FILE_SIZE_LIMITS.general;
        multer({
          storage: multer.memoryStorage(),
          limits: { fileSize: maxBytes, files: 1 },
        }).single(fieldName)(req, res, (error?: unknown) => {
          if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
            res.status(413).json({
              code: "UPLOAD_FILE_TOO_LARGE",
              message: `File exceeds the ${sizeLimitLabel(maxBytes)} upload limit.`,
            });
            return;
          }
          if (error) return next(error);
          if (kind === "general" && req.file) {
            const tailored = generalUploadLimitBytes(req.file.originalname, req.file.mimetype);
            if (req.file.size > tailored) {
              res.status(413).json({
                code: "UPLOAD_FILE_TOO_LARGE",
                message: `File exceeds the ${sizeLimitLabel(tailored)} limit for this file type.`,
              });
              return;
            }
          }
          next();
        });
      });
    },
    fields(fields: Parameters<ReturnType<typeof multer>["fields"]>[0]): RequestHandler {
      return withPostMultipartTenantScope((req, res, next) => {
        const maxBytes = kind === "spreadsheet"
          ? spreadsheetImportLimitBytes(req.session?.currentRole)
          : FILE_SIZE_LIMITS.general;
        const files = fields.reduce((count, field) => count + (field.maxCount ?? 1), 0);
        multer({
          storage: multer.memoryStorage(),
          limits: { fileSize: maxBytes, files },
        }).fields(fields)(req, res, (error?: unknown) => {
          if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
            res.status(413).json({
              code: "UPLOAD_FILE_TOO_LARGE",
              message: `File exceeds the ${sizeLimitLabel(maxBytes)} upload limit.`,
            });
            return;
          }
          if (error) return next(error);
          next();
        });
      });
    },
  };
}

export const spreadsheetUpload = scopedPolicyUpload("spreadsheet");
export const generalUpload = scopedPolicyUpload("general");
