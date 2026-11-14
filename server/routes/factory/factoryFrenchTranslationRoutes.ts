import type { Express, Request } from "express";
import ExcelJS from "exceljs";
import { spreadsheetUpload } from "../helpers/uploadHelpers";
import { sql } from "drizzle-orm";
import { requireAuth } from "../../auth";
import { db } from "../../db";
import { contentDisposition } from "../../lib/contentDisposition";
import { getErrorMessage } from "../../lib/httpHandlers";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const upload = spreadsheetUpload;

function factoryCompanyId(req: Request): number | null {
  const value = Number(req.session?.factoryCompanyId);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function clean(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeCode(value: unknown): string {
  return clean(value)?.toUpperCase() ?? "";
}

async function ensureFrenchColumns() {
  await db.execute(
    sql.raw(`
    ALTER TABLE factory_categories ADD COLUMN IF NOT EXISTS name_fr VARCHAR(100);
    ALTER TABLE factory_bale_products ADD COLUMN IF NOT EXISTS name_fr TEXT;
    ALTER TABLE factory_bale_products ADD COLUMN IF NOT EXISTS description_fr TEXT;
  `)
  );
}

export function registerFactoryFrenchTranslationRoutes(app: Express) {
  app.get("/api/factory/french-catalog", requireAuth, async (req, res) => {
    try {
      const companyId = factoryCompanyId(req);
      if (!companyId) return res.status(403).json({ message: "Factory company access required" });
      await ensureFrenchColumns();
      const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
      const status = typeof req.query.status === "string" ? req.query.status : "all";
      const result = await db.execute(sql`
        SELECT p.id,
               p.article_code AS "articleCode",
               p.name AS "nameEn",
               p.name_ar AS "nameAr",
               p.name_fr AS "nameFr",
               p.description AS "descriptionEn",
               p.description_ar AS "descriptionAr",
               p.description_fr AS "descriptionFr",
               c.id AS "categoryId",
               c.name AS "categoryNameEn",
               c.name_ar AS "categoryNameAr",
               c.name_fr AS "categoryNameFr"
        FROM factory_bale_products p
        LEFT JOIN factory_categories c ON c.id = p.category_id AND c.company_id = p.company_id AND c.deleted_at IS NULL
        WHERE p.company_id = ${companyId}
          AND p.deleted_at IS NULL
          AND (${q} = '' OR p.article_code ILIKE ${`%${q}%`} OR p.name ILIKE ${`%${q}%`} OR p.name_ar ILIKE ${`%${q}%`} OR p.name_fr ILIKE ${`%${q}%`} OR p.description ILIKE ${`%${q}%`} OR p.description_ar ILIKE ${`%${q}%`} OR p.description_fr ILIKE ${`%${q}%`} OR c.name ILIKE ${`%${q}%`} OR c.name_ar ILIKE ${`%${q}%`} OR c.name_fr ILIKE ${`%${q}%`})
          AND (${status} = 'all' OR (${status} = 'missing' AND COALESCE(BTRIM(p.name_fr), '') = '') OR (${status} = 'complete' AND COALESCE(BTRIM(p.name_fr), '') <> ''))
        ORDER BY p.article_code NULLS LAST, p.id
      `);
      return res.json(result.rows);
    } catch (error: unknown) {
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.patch("/api/factory/french-catalog/products/:id", requireAuth, async (req, res) => {
    try {
      const companyId = factoryCompanyId(req);
      const id = Number(req.params.id);
      if (!companyId) return res.status(403).json({ message: "Factory company access required" });
      if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ message: "Invalid product id" });
      await ensureFrenchColumns();
      const nameFr = clean(req.body?.nameFr);
      const descriptionFr = clean(req.body?.descriptionFr);
      const result = await db.execute(sql`
        UPDATE factory_bale_products
        SET name_fr = ${nameFr}, description_fr = ${descriptionFr}, updated_at = NOW()
        WHERE id = ${id} AND company_id = ${companyId} AND deleted_at IS NULL
        RETURNING id, article_code AS "articleCode", name_fr AS "nameFr", description_fr AS "descriptionFr"
      `);
      if (!result.rows[0]) return res.status(404).json({ message: "Product not found" });
      return res.json(result.rows[0]);
    } catch (error: unknown) {
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.patch("/api/factory/french-catalog/categories/:id", requireAuth, async (req, res) => {
    try {
      const companyId = factoryCompanyId(req);
      const id = Number(req.params.id);
      if (!companyId) return res.status(403).json({ message: "Factory company access required" });
      if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ message: "Invalid category id" });
      await ensureFrenchColumns();
      const nameFr = clean(req.body?.nameFr);
      const result = await db.execute(sql`
        UPDATE factory_categories
        SET name_fr = ${nameFr}, updated_at = NOW()
        WHERE id = ${id} AND company_id = ${companyId} AND deleted_at IS NULL
        RETURNING id, name_fr AS "nameFr"
      `);
      if (!result.rows[0]) return res.status(404).json({ message: "Category not found" });
      return res.json(result.rows[0]);
    } catch (error: unknown) {
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/factory/french-catalog/template", requireAuth, async (req, res) => {
    try {
      const companyId = factoryCompanyId(req);
      if (!companyId) return res.status(403).json({ message: "Factory company access required" });
      await ensureFrenchColumns();
      const result = await db.execute(sql`
        SELECT p.article_code AS "articleCode", p.name AS "nameEn", p.name_fr AS "nameFr",
               c.name AS "categoryNameEn", c.name_fr AS "categoryNameFr",
               p.description AS "descriptionEn", p.description_fr AS "descriptionFr"
        FROM factory_bale_products p
        LEFT JOIN factory_categories c ON c.id = p.category_id AND c.company_id = p.company_id
        WHERE p.company_id = ${companyId} AND p.deleted_at IS NULL
        ORDER BY p.article_code NULLS LAST, p.id
      `);
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("French Translations");
      sheet.columns = [
        { header: "Article Code / Barcode", key: "articleCode", width: 24 },
        { header: "English Product Name", key: "nameEn", width: 34 },
        { header: "French Product Name", key: "nameFr", width: 34 },
        { header: "English Category", key: "categoryNameEn", width: 28 },
        { header: "French Category", key: "categoryNameFr", width: 28 },
        { header: "English Description", key: "descriptionEn", width: 44 },
        { header: "French Description", key: "descriptionFr", width: 44 },
      ];
      result.rows.forEach((row) => sheet.addRow(row));
      sheet.getRow(1).font = { bold: true };
      sheet.views = [{ state: "frozen", ySplit: 1 }];
      const buffer = await workbook.xlsx.writeBuffer();
      res.setHeader("Content-Type", XLSX_MIME);
      res.setHeader("Content-Disposition", contentDisposition("factory-french-translations.xlsx"));
      return res.send(Buffer.from(buffer));
    } catch (error: unknown) {
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/factory/french-catalog/import/preview", requireAuth, upload.single("file"), async (req, res) => {
    try {
      const companyId = factoryCompanyId(req);
      if (!companyId) return res.status(403).json({ message: "Factory company access required" });
      if (!req.file) return res.status(400).json({ message: "Excel file is required" });
      await ensureFrenchColumns();
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(req.file.buffer as unknown as ArrayBuffer);
      const sheet = workbook.worksheets[0];
      if (!sheet) return res.status(400).json({ message: "Workbook has no worksheet" });
      const headers = new Map<string, number>();
      sheet.getRow(1).eachCell((cell, col) =>
        headers.set(
          String(cell.value ?? "")
            .trim()
            .toLowerCase(),
          col
        )
      );
      const articleCol = headers.get("article code / barcode") ?? headers.get("article code");
      const productCol = headers.get("french product name");
      const categoryCol = headers.get("french category");
      const descriptionCol = headers.get("french description");
      if (!articleCol || !productCol) return res.status(400).json({ message: "Required columns are missing" });
      const rows: Array<Record<string, unknown>> = [];
      for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
        const row = sheet.getRow(rowNumber);
        const articleCode = normalizeCode(row.getCell(articleCol).text);
        if (!articleCode) continue;
        rows.push({
          rowNumber,
          articleCode,
          nameFr: clean(row.getCell(productCol).text),
          categoryNameFr: categoryCol ? clean(row.getCell(categoryCol).text) : null,
          descriptionFr: descriptionCol ? clean(row.getCell(descriptionCol).text) : null,
        });
      }
      const codes = rows.map((row) => String(row.articleCode));
      const catalog = codes.length
        ? await db.execute(sql`
            SELECT p.id, UPPER(BTRIM(p.article_code)) AS "articleCode", p.category_id AS "categoryId",
                   p.name_fr AS "currentNameFr", p.description_fr AS "currentDescriptionFr",
                   c.name_fr AS "currentCategoryNameFr"
            FROM factory_bale_products p
            LEFT JOIN factory_categories c ON c.id = p.category_id AND c.company_id = p.company_id
            WHERE p.company_id = ${companyId} AND UPPER(BTRIM(p.article_code)) = ANY(${codes})
          `)
        : { rows: [] };
      const byCode = new Map(catalog.rows.map((row: Record<string, unknown>) => [row.articleCode, row]));
      const preview = rows.map((row) => {
        const match = byCode.get(String(row.articleCode));
        return {
          ...row,
          productId: match?.id ?? null,
          categoryId: match?.categoryId ?? null,
          status: match ? "ready" : "unknown",
        };
      });
      return res.json({
        rows: preview,
        totalRows: preview.length,
        readyRows: preview.filter((row) => row.status === "ready").length,
        blocked: preview.some((row) => row.status !== "ready"),
      });
    } catch (error: unknown) {
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/factory/french-catalog/import/apply", requireAuth, async (req, res) => {
    try {
      const companyId = factoryCompanyId(req);
      if (!companyId) return res.status(403).json({ message: "Factory company access required" });
      const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
      if (rows.length === 0) return res.status(400).json({ message: "No translation rows supplied" });
      await ensureFrenchColumns();
      let updatedProducts = 0;
      let updatedCategories = 0;
      await db.transaction(async (tx) => {
        for (const row of rows) {
          const articleCode = normalizeCode(row.articleCode);
          if (!articleCode) continue;
          const product = await tx.execute(sql`
            UPDATE factory_bale_products
            SET name_fr = ${clean(row.nameFr)}, description_fr = ${clean(row.descriptionFr)}, updated_at = NOW()
            WHERE company_id = ${companyId} AND UPPER(BTRIM(article_code)) = ${articleCode} AND deleted_at IS NULL
            RETURNING category_id AS "categoryId"
          `);
          const categoryId = Number(product.rows[0]?.categoryId);
          if (!product.rows[0]) continue;
          updatedProducts += 1;
          if (
            Number.isSafeInteger(categoryId) &&
            categoryId > 0 &&
            Object.prototype.hasOwnProperty.call(row, "categoryNameFr")
          ) {
            await tx.execute(
              sql`UPDATE factory_categories SET name_fr = ${clean(row.categoryNameFr)}, updated_at = NOW() WHERE id = ${categoryId} AND company_id = ${companyId}`
            );
            updatedCategories += 1;
          }
        }
      });
      return res.json({ success: true, updatedProducts, updatedCategories });
    } catch (error: unknown) {
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
