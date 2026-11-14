import type { Express, NextFunction, Request, Response } from "express";
import multer from "multer";
import { sizeLimitLabel, spreadsheetImportLimitBytes } from "@shared/fileSizePolicy";
import { and, eq, isNull, sql } from "drizzle-orm";
import { factoryBaleProducts, factoryCategories } from "@shared/schema";
import { parseFactoryArabicImportMode } from "@shared/factoryBilingualContract";
import { requireAuth } from "../../auth";
import { db } from "../../db";
import { contentDisposition } from "../../lib/contentDisposition";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { requireActionAccess, requireExportAccess } from "../../lib/permissionMiddleware";
import { writeAuditEvent } from "../../services/audit/auditService";
import {
  createArabicTranslationErrorWorkbook,
  createArabicTranslationPreviewEnvelope,
  createArabicTranslationTemplate,
  createWorkbookSha256,
  parseArabicTranslationWorkbook,
  previewArabicTranslationImport,
  type TranslationCatalogProduct,
  type TranslationImportMode,
  type TranslationPreview,
  type TranslationPreviewEnvelope,
} from "../../services/factoryArabicTranslationWorkbook";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const MAX_PREVIEW_RESPONSE_ROWS = 200;
const AUDIT_BRANCH_SIZE = 100;

function receiveArabicWorkbook(req: Request, res: Response, next: NextFunction): void {
  const maxBytes = spreadsheetImportLimitBytes(req.session?.currentRole);
  multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes, files: 1 },
    fileFilter: (_req, file, callback) => {
      const validExtension = file.originalname.toLowerCase().endsWith(".xlsx");
      const validMime = !file.mimetype || file.mimetype === XLSX_MIME || file.mimetype === "application/octet-stream";
      if (!validExtension || !validMime) {
        callback(new Error("Only .xlsx files are supported"));
        return;
      }
      callback(null, true);
    },
  }).single("file")(req, res, next);
}

class TranslationRouteError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "TranslationRouteError";
  }
}

function uploadArabicWorkbook(req: Request, res: Response, next: NextFunction): void {
  receiveArabicWorkbook(req, res, (error: unknown) => {
    if (!error) {
      next();
      return;
    }
    const tooLarge = error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE";
    const message = tooLarge
      ? `Workbook exceeds the ${sizeLimitLabel(spreadsheetImportLimitBytes(req.session?.currentRole))} upload limit`
      : getErrorMessage(error);
    res.status(tooLarge ? 413 : 400).json({ code: tooLarge ? "UPLOAD_FILE_TOO_LARGE" : "INVALID_UPLOAD", message });
  });
}

function getFactoryCompanyId(req: Request): number | null {
  const value = Number(req.session?.factoryCompanyId);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function getImportMode(value: unknown): TranslationImportMode {
  return parseFactoryArabicImportMode(value);
}

function getUpload(req: Request): { buffer: Buffer; fileName: string } {
  const file = (
    req as Request & {
      file?: { buffer: Buffer; originalname: string };
    }
  ).file;
  if (!file?.buffer) {
    throw new TranslationRouteError(400, "An .xlsx workbook is required");
  }
  return {
    buffer: file.buffer,
    fileName: file.originalname.trim().slice(0, 255) || "factory-arabic-names.xlsx",
  };
}

async function loadCatalog(
  companyId: number,
  executor: Pick<typeof db, "select"> = db
): Promise<TranslationCatalogProduct[]> {
  return executor
    .select({
      id: factoryBaleProducts.id,
      categoryId: factoryBaleProducts.categoryId,
      articleCode: factoryBaleProducts.articleCode,
      name: factoryBaleProducts.name,
      nameAr: factoryBaleProducts.nameAr,
      descriptionAr: factoryBaleProducts.descriptionAr,
      categoryName: factoryCategories.name,
      categoryNameAr: factoryCategories.nameAr,
    })
    .from(factoryBaleProducts)
    .leftJoin(
      factoryCategories,
      and(
        eq(factoryCategories.id, factoryBaleProducts.categoryId),
        eq(factoryCategories.companyId, companyId),
        isNull(factoryCategories.deletedAt)
      )
    )
    .where(and(eq(factoryBaleProducts.companyId, companyId), isNull(factoryBaleProducts.deletedAt)))
    .orderBy(factoryBaleProducts.id);
}

function previewSummary(preview: TranslationPreview) {
  return {
    totalRows: preview.totalRows,
    matchedProducts: preview.matchedProducts,
    unchangedRows: preview.unchangedRows,
    rowsToApply: preview.rowsToApply,
    productsToUpdate: preview.productsToUpdate,
    categoriesToUpdate: preview.categoriesToUpdate,
    unknownArticleCodes: preview.unknownArticleCodes,
    duplicateArticleCodes: preview.duplicateArticleCodes,
    ambiguousArticleCodes: preview.ambiguousArticleCodes,
    blankOrInvalidArabicNames: preview.blankOrInvalidArabicNames,
    categoryConflicts: preview.categoryConflicts,
    blocked: preview.blocked,
    rejectedRows: preview.rows.filter((row) => !["update", "unchanged"].includes(row.status)).length,
  };
}

function previewForResponse(preview: TranslationPreviewEnvelope) {
  const rejectedRows = preview.rows.filter((row) => !["update", "unchanged"].includes(row.status));
  return {
    ...preview,
    rows: rejectedRows.slice(0, MAX_PREVIEW_RESPONSE_ROWS),
    returnedRows: Math.min(rejectedRows.length, MAX_PREVIEW_RESPONSE_ROWS),
    totalRejectedRows: rejectedRows.length,
    rowsTruncated: rejectedRows.length > MAX_PREVIEW_RESPONSE_ROWS,
  };
}

function chunkValues<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function auditSafeIdList(ids: number[]): unknown {
  const uniqueIds = [...new Set(ids)].sort((left, right) => left - right);
  if (uniqueIds.length <= AUDIT_BRANCH_SIZE) return uniqueIds;

  let level: unknown[] = chunkValues(uniqueIds, AUDIT_BRANCH_SIZE);
  while (level.length > AUDIT_BRANCH_SIZE) {
    level = chunkValues(level, AUDIT_BRANCH_SIZE);
  }
  return level;
}

async function buildPreview(input: {
  companyId: number;
  buffer: Buffer;
  mode: TranslationImportMode;
  executor?: Pick<typeof db, "select">;
}): Promise<TranslationPreviewEnvelope> {
  const rows = await parseArabicTranslationWorkbook(input.buffer);
  const preview = previewArabicTranslationImport(
    rows,
    await loadCatalog(input.companyId, input.executor ?? db),
    input.mode
  );
  return createArabicTranslationPreviewEnvelope({
    companyId: input.companyId,
    mode: input.mode,
    workbookSha256: createWorkbookSha256(input.buffer),
    preview,
  });
}

function sendWorkbook(res: Response, workbook: Buffer, fileName: string): Response {
  res.setHeader("Content-Type", XLSX_MIME);
  res.setHeader("Content-Disposition", contentDisposition(fileName, "attachment"));
  res.setHeader("Cache-Control", "private, no-store");
  return res.send(workbook);
}

function sendRouteError(res: Response, error: unknown): Response {
  if (error instanceof TranslationRouteError) {
    return res.status(error.status).json({ message: error.message, ...error.details });
  }
  return res.status(400).json({ message: getErrorMessage(error) });
}

export function registerFactoryArabicTranslationRoutes(app: Express) {
  app.get(
    "/api/factory/bale-products/arabic-import/capabilities/import",
    requireAuth,
    requireActionAccess("act_import_data"),
    (_req, res) => res.json({ allowed: true })
  );

  app.get(
    "/api/factory/bale-products/arabic-import/capabilities/export",
    requireAuth,
    requireActionAccess("act_import_data"),
    requireExportAccess("exp_excel"),
    (_req, res) => res.json({ allowed: true })
  );

  app.get(
    "/api/factory/bale-products/arabic-template",
    requireAuth,
    requireActionAccess("act_import_data"),
    requireExportAccess("exp_excel"),
    async (req: Request, res: Response) => {
      try {
        const companyId = getFactoryCompanyId(req);
        if (!companyId) {
          throw new TranslationRouteError(403, "Factory company access required");
        }
        const workbook = await createArabicTranslationTemplate(await loadCatalog(companyId));
        return sendWorkbook(res, workbook, "factory-arabic-names-template.xlsx");
      } catch (error) {
        logger.error("Failed to export Factory Arabic translation template", {
          error,
        });
        return sendRouteError(res, error);
      }
    }
  );

  app.post(
    "/api/factory/bale-products/arabic-import/preview",
    requireAuth,
    requireActionAccess("act_import_data"),
    uploadArabicWorkbook,
    async (req: Request, res: Response) => {
      try {
        const companyId = getFactoryCompanyId(req);
        if (!companyId) {
          throw new TranslationRouteError(403, "Factory company access required");
        }
        const { buffer } = getUpload(req);
        const preview = await buildPreview({
          companyId,
          buffer,
          mode: getImportMode((req.body as Record<string, unknown> | undefined)?.mode),
        });
        return res.json(previewForResponse(preview));
      } catch (error) {
        return sendRouteError(res, error);
      }
    }
  );

  app.post(
    "/api/factory/bale-products/arabic-import/errors",
    requireAuth,
    requireActionAccess("act_import_data"),
    requireExportAccess("exp_excel"),
    uploadArabicWorkbook,
    async (req: Request, res: Response) => {
      try {
        const companyId = getFactoryCompanyId(req);
        if (!companyId) {
          throw new TranslationRouteError(403, "Factory company access required");
        }
        const { buffer } = getUpload(req);
        const preview = await buildPreview({
          companyId,
          buffer,
          mode: getImportMode((req.body as Record<string, unknown> | undefined)?.mode),
        });
        return sendWorkbook(
          res,
          await createArabicTranslationErrorWorkbook(preview),
          "factory-arabic-import-errors.xlsx"
        );
      } catch (error) {
        return sendRouteError(res, error);
      }
    }
  );

  app.post(
    "/api/factory/bale-products/arabic-import/apply",
    requireAuth,
    requireActionAccess("act_import_data"),
    uploadArabicWorkbook,
    async (req: Request, res: Response) => {
      try {
        const companyId = getFactoryCompanyId(req);
        if (!companyId) {
          throw new TranslationRouteError(403, "Factory company access required");
        }
        const { buffer, fileName } = getUpload(req);
        const body = (req.body ?? {}) as Record<string, unknown>;
        const mode = getImportMode(body.mode);
        const suppliedPreviewToken = typeof body.previewToken === "string" ? body.previewToken.trim() : "";
        if (!suppliedPreviewToken) {
          throw new TranslationRouteError(400, "Preview the workbook before applying it");
        }

        const result = await db.transaction(
          async (tx) => {
            await tx.execute(sql`
              SELECT id
              FROM factory_bale_products
              WHERE company_id = ${companyId} AND deleted_at IS NULL
              ORDER BY id
              FOR UPDATE
            `);
            await tx.execute(sql`
              SELECT id
              FROM factory_categories
              WHERE company_id = ${companyId} AND deleted_at IS NULL
              ORDER BY id
              FOR UPDATE
            `);

            const preview = await buildPreview({
              companyId,
              buffer,
              mode,
              executor: tx as unknown as Pick<typeof db, "select">,
            });

            if (preview.previewToken !== suppliedPreviewToken) {
              throw new TranslationRouteError(
                409,
                "The workbook or catalog changed after preview. Preview it again before applying.",
                { preview: previewForResponse(preview) }
              );
            }
            if (preview.blocked) {
              throw new TranslationRouteError(
                409,
                "Import is blocked by duplicate codes, ambiguous catalog codes, or category conflicts",
                { preview: previewForResponse(preview) }
              );
            }

            const changedProductIds: number[] = [];
            const changedCategoryIds: number[] = [];
            const categoryTargets = new Map<number, string>();

            for (const row of preview.rows) {
              if (row.status !== "update" || !row.productId) continue;

              const productChanges: {
                nameAr?: string;
                descriptionAr?: string;
                updatedAt: Date;
              } = { updatedAt: new Date() };
              if (row.changes.productNameAr && row.targetProductNameAr) {
                productChanges.nameAr = row.targetProductNameAr;
              }
              if (row.changes.descriptionAr && row.targetDescriptionAr) {
                productChanges.descriptionAr = row.targetDescriptionAr;
              }

              if (row.changes.productNameAr || row.changes.descriptionAr) {
                const [updatedProduct] = await tx
                  .update(factoryBaleProducts)
                  .set(productChanges)
                  .where(
                    and(
                      eq(factoryBaleProducts.id, row.productId),
                      eq(factoryBaleProducts.companyId, companyId),
                      isNull(factoryBaleProducts.deletedAt)
                    )
                  )
                  .returning({ id: factoryBaleProducts.id });
                if (!updatedProduct) {
                  throw new TranslationRouteError(
                    409,
                    `Product ${row.productId} changed during import. Preview again.`
                  );
                }
                changedProductIds.push(updatedProduct.id);
              }

              if (row.categoryId && row.changes.categoryNameAr && row.targetCategoryNameAr) {
                categoryTargets.set(row.categoryId, row.targetCategoryNameAr);
              }
            }

            for (const [categoryId, nameAr] of categoryTargets) {
              const [updatedCategory] = await tx
                .update(factoryCategories)
                .set({ nameAr, updatedAt: new Date() })
                .where(
                  and(
                    eq(factoryCategories.id, categoryId),
                    eq(factoryCategories.companyId, companyId),
                    isNull(factoryCategories.deletedAt)
                  )
                )
                .returning({ id: factoryCategories.id });
              if (!updatedCategory) {
                throw new TranslationRouteError(409, `Category ${categoryId} changed during import. Preview again.`);
              }
              changedCategoryIds.push(updatedCategory.id);
            }

            const uniqueProductIds = [...new Set(changedProductIds)];
            const uniqueCategoryIds = [...new Set(changedCategoryIds)];
            const summary = {
              fileName,
              mode,
              workbookSha256: preview.workbookSha256,
              previewToken: preview.previewToken,
              ...previewSummary(preview),
              changedProductIds: uniqueProductIds,
              changedCategoryIds: uniqueCategoryIds,
              appliedByUserId: String(req.session.userId),
              companyId,
            };
            const auditSummary = {
              ...summary,
              changedProductIds: auditSafeIdList(uniqueProductIds),
              changedCategoryIds: auditSafeIdList(uniqueCategoryIds),
            };

            await writeAuditEvent(
              {
                userId: String(req.session.userId ?? ""),
                username: String(req.session.username ?? req.session.userId ?? "unknown"),
                companyId,
                action: "import",
                tableName: "factory_bale_products",
                recordIdentifier: fileName,
                changes: {
                  arabicTranslationImport: { new: auditSummary },
                },
              },
              tx
            );

            return summary;
          },
          { isolationLevel: "serializable" }
        );

        logger.info("Factory Arabic translation import applied", result);
        return res.json(result);
      } catch (error) {
        logger.error("Failed to apply Factory Arabic translation import", {
          error,
        });
        return sendRouteError(res, error);
      }
    }
  );
}
