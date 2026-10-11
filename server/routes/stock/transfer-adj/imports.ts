/**
 * stockTransferAdjRoutes: StockItemImport endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { db } from "../../../db";
import { storage } from "../../../storage";
import { requireAuth, requireNonPOS } from "../../../auth";
import { upload, logAudit } from "../../_helpers";
import { stockItems, stockItemCodeAliases, insertStockItemSchema, stockGrades, stockCategories } from "@shared/schema";
import { eq, and, isNull } from "drizzle-orm";
import { readExcel, sheetToJson } from "../../../excelHelper";

export function registerStockItemImportRoutes(app: Express) {
  // Bulk import stock items
  app.post("/api/stock-items/import", requireAuth, requireNonPOS, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const { items } = req.body;
      if (!Array.isArray(items)) {
        return res.status(400).json({ message: "Items must be an array" });
      }

      // Fetch all valid stock groups for this company for validation
      const validStockGroups = await storage.getAllStockGroups(req.session.currentCompanyId);
      const validStockGroupIds = new Set(validStockGroups.map((sg) => sg.id));

      const results = {
        created: [] as unknown[],
        skipped: [] as unknown[],
        errors: [] as unknown[],
      };

      for (const item of items) {
        try {
          // Ensure companyId matches session
          const itemWithCompany = {
            ...item,
            companyId: req.session.currentCompanyId,
          };

          // Validate stock group - require valid stockGroupId, reject if missing or invalid
          if (!itemWithCompany.stockGroupId || !validStockGroupIds.has(itemWithCompany.stockGroupId)) {
            results.errors.push({
              code: item.code,
              name: item.name,
              error: "Missing or invalid stock group. All stock items must have a valid stock group.",
            });
            continue;
          }

          const parsed = insertStockItemSchema.parse(itemWithCompany);

          // Check for duplicate code
          const existing = await storage.getStockItemByCode(parsed.code, req.session.currentCompanyId);
          if (existing) {
            results.skipped.push({
              code: parsed.code,
              name: parsed.name,
              reason: "Code already exists",
            });
            continue;
          }

          const created = await storage.createStockItem(parsed);
          results.created.push(created);
        } catch (error: unknown) {
          results.errors.push({
            code: item.code,
            name: item.name,
            error: getErrorMessage(error),
          });
        }
      }

      res.json({
        message: `Import completed: ${results.created.length} created, ${results.skipped.length} skipped, ${results.errors.length} errors`,
        results,
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ── Bulk barcode import (assigns alias codes to existing stock items) ──────────
  app.post("/api/stock-items/import-barcodes", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { rows } = req.body as { rows: { itemCode: string; barcode: string }[] };
      if (!Array.isArray(rows) || rows.length === 0)
        return res.status(400).json({ message: "rows must be a non-empty array" });

      // Build a lookup map: primary code (lower) → stockItem
      const allItems = await db
        .select({ id: stockItems.id, code: stockItems.code })
        .from(stockItems)
        .where(eq(stockItems.companyId, companyId));
      const itemByCode = new Map(allItems.map((i) => [i.code.trim().toLowerCase(), i.id]));

      // Also build alias → stockItemId map so we can detect barcodes already assigned
      const allAliases = await db
        .select({ aliasCode: stockItemCodeAliases.aliasCode, stockItemId: stockItemCodeAliases.stockItemId })
        .from(stockItemCodeAliases)
        .where(eq(stockItemCodeAliases.companyId, companyId));
      const aliasByCode = new Map(allAliases.map((a) => [a.aliasCode.trim().toLowerCase(), a.stockItemId]));

      let imported = 0;
      let skipped = 0;
      const notFoundCodes: string[] = [];

      for (const row of rows) {
        const itemCodeKey = (row.itemCode || "").trim().toLowerCase();
        const barcodeKey = (row.barcode || "").trim().toLowerCase();
        const barcodeRaw = (row.barcode || "").trim();

        if (!itemCodeKey || !barcodeKey) {
          skipped++;
          continue;
        }

        const stockItemId = itemByCode.get(itemCodeKey);
        if (!stockItemId) {
          notFoundCodes.push(row.itemCode);
          continue;
        }

        // Skip if barcode is already the primary code of this item
        if (itemCodeKey === barcodeKey) {
          skipped++;
          continue;
        }

        // Skip if already an alias (anywhere in the company)
        if (aliasByCode.has(barcodeKey)) {
          skipped++;
          continue;
        }

        try {
          await db
            .insert(stockItemCodeAliases)
            .values({
              companyId,
              stockItemId,
              aliasCode: barcodeRaw,
            })
            .onConflictDoNothing();
          aliasByCode.set(barcodeKey, stockItemId); // prevent re-insert in same batch
          imported++;
        } catch {
          skipped++;
        }
      }

      res.json({ imported, skipped, notFound: notFoundCodes.length, notFoundCodes });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ── Bulk category (stock group) update for existing stock items ───────────────
  app.post("/api/stock-items/update-categories", requireAuth, requireNonPOS, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { rows } = req.body as { rows: { itemCode: string; categoryName: string }[] };
      if (!Array.isArray(rows) || rows.length === 0)
        return res.status(400).json({ message: "rows must be a non-empty array" });

      // Build lookups
      const allItems = await db
        .select({ id: stockItems.id, code: stockItems.code })
        .from(stockItems)
        .where(and(eq(stockItems.companyId, companyId), isNull(stockItems.deletedAt)));
      const itemByCode = new Map(allItems.map((i) => [i.code.toLowerCase().trim(), i.id]));

      const allCats = await db
        .select({ id: stockCategories.id, name: stockCategories.name })
        .from(stockCategories)
        .where(eq(stockCategories.companyId, companyId));
      const catByName = new Map(allCats.map((c) => [c.name.toLowerCase().trim(), c.id]));

      let updated = 0;
      let notFound = 0;
      let categoryNotFound = 0;
      const notFoundCodes: string[] = [];
      const categoryNotFoundNames: string[] = [];

      for (const row of rows) {
        const code = String(row.itemCode || "").trim();
        const catName = String(row.categoryName || "").trim();
        if (!code || !catName) continue;

        const itemId = itemByCode.get(code.toLowerCase());
        if (!itemId) {
          notFound++;
          notFoundCodes.push(code);
          continue;
        }

        const catId = catByName.get(catName.toLowerCase());
        if (!catId) {
          categoryNotFound++;
          if (!categoryNotFoundNames.includes(catName)) categoryNotFoundNames.push(catName);
          continue;
        }

        await db.update(stockItems).set({ categoryId: catId }).where(eq(stockItems.id, itemId));
        updated++;
      }

      res.json({ updated, notFound, categoryNotFound, notFoundCodes, categoryNotFoundNames });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ── Grade/Category Template Import ────────────────────────────────────────────

  app.post(
    "/api/stock-items/import-grade-category-template",
    requireAuth,
    requireNonPOS,
    upload.single("file"),
    async (req: import("express").Request, res) => {
      try {
        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        if (!req.file) return res.status(400).json({ message: "No file uploaded" });

        const wb = await readExcel(req.file.buffer);
        const sheetName = wb.SheetNames[0];
        if (!sheetName) return res.status(400).json({ message: "Excel file has no sheets" });

        const rows = sheetToJson<Record<string, unknown>>(wb.Sheets[sheetName]);

        // Pre-fetch all stock items for this company (by code)
        const allItems = await db
          .select({ id: stockItems.id, code: stockItems.code })
          .from(stockItems)
          .where(and(eq(stockItems.companyId, companyId), isNull(stockItems.deletedAt)));
        const itemByCode = new Map<string, number>(allItems.map((i) => [i.code.toLowerCase().trim(), i.id]));

        // Pre-fetch all grades and categories for this company (including inactive)
        const allGrades = await db.select().from(stockGrades).where(eq(stockGrades.companyId, companyId));
        const allCategories = await db.select().from(stockCategories).where(eq(stockCategories.companyId, companyId));
        const gradeByName = new Map<string, (typeof allGrades)[0]>(
          allGrades.map((g) => [g.name.toLowerCase().trim(), g])
        );
        const categoryByName = new Map<string, (typeof allCategories)[0]>(
          allCategories.map((c) => [c.name.toLowerCase().trim(), c])
        );

        const summary = {
          rowsProcessed: 0,
          itemsUpdated: 0,
          gradesCreated: 0,
          categoriesCreated: 0,
          skipped: 0,
          errors: [] as { row: number; reason: string }[],
        };

        // Phase 21 (B): the rows and the import audit commit together.
        await db.transaction(async (tx) => {
          for (let i = 0; i < rows.length; i++) {
            const rowNum = i + 2; // 1-indexed, row 1 is header
            const row = rows[i];
            summary.rowsProcessed++;

            // Read Item Code (required)
            const rawCode = String(row["Item Code"] ?? "").trim();
            if (!rawCode) {
              summary.skipped++;
              summary.errors.push({ row: rowNum, reason: "Item Code is empty — row skipped" });
              continue;
            }

            const stockItemId = itemByCode.get(rawCode.toLowerCase());
            if (!stockItemId) {
              summary.skipped++;
              summary.errors.push({ row: rowNum, reason: `Item Code "${rawCode}" not found in this company` });
              continue;
            }

            // Resolve grade
            const rawGrade = String(row["Current Grade"] ?? "").trim();
            let gradeId: number | null = null;
            if (rawGrade) {
              const gradeKey = rawGrade.toLowerCase();
              let grade = gradeByName.get(gradeKey);
              if (!grade) {
                // Create new grade
                const [created] = await tx
                  .insert(stockGrades)
                  .values({ name: rawGrade, companyId, active: true })
                  .returning();
                gradeByName.set(gradeKey, created);
                summary.gradesCreated++;
                grade = created;
              } else if (!grade.active) {
                // Reactivate inactive grade
                await tx.update(stockGrades).set({ active: true }).where(eq(stockGrades.id, grade.id));
                grade.active = true;
              }
              gradeId = grade.id;
            }

            // Resolve category
            const rawCategory = String(row["Current Category"] ?? "").trim();
            let categoryId: number | null = null;
            if (rawCategory) {
              const catKey = rawCategory.toLowerCase();
              let category = categoryByName.get(catKey);
              if (!category) {
                const [created] = await tx
                  .insert(stockCategories)
                  .values({ name: rawCategory, companyId, active: true })
                  .returning();
                categoryByName.set(catKey, created);
                summary.categoriesCreated++;
                category = created;
              } else if (!category.active) {
                await tx.update(stockCategories).set({ active: true }).where(eq(stockCategories.id, category.id));
                category.active = true;
              }
              categoryId = category.id;
            }

            // Update stock item — only gradeId and categoryId
            await tx.update(stockItems).set({ gradeId, categoryId }).where(eq(stockItems.id, stockItemId));

            summary.itemsUpdated++;
          }

          // Audit log
          await logAudit(
            {
              userId: req.session.userId!,
              username: req.session.username || "unknown",
              companyId,
              action: "create",
              tableName: "stock_items",
              recordIdentifier: "bulk-grade-category-import",
              changes: {
                itemsUpdated: { old: null, new: summary.itemsUpdated },
                gradesCreated: { old: null, new: summary.gradesCreated },
                categoriesCreated: { old: null, new: summary.categoriesCreated },
                skipped: { old: null, new: summary.skipped },
              },
            },
            tx
          );
        });

        res.json({
          message: `Import complete: ${summary.itemsUpdated} updated, ${summary.gradesCreated} grades created, ${summary.categoriesCreated} categories created, ${summary.skipped} skipped`,
          ...summary,
        });
      } catch (error: unknown) {
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}
