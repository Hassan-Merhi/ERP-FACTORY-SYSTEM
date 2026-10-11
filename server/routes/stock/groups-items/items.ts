/**
 * stockGroupsItemsRoutes: StockItem endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { db } from "../../../db";
import { storage } from "../../../storage";
import { requireAuth, requireNonPOS } from "../../../auth";
import { logAudit } from "../../_helpers";
import { stockItems, insertStockItemSchema } from "@shared/schema";
import { eq, and, or, asc, sql, isNull, ilike, type SQL } from "drizzle-orm";
import { toMoney } from "../../../lib/money";

export function registerStockItemRoutes(app: Express) {
  // Stock Items
  app.get("/api/stock-items", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.currentCompanyId || req.session.factoryCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const { page, pageSize, search, stockGroupId, active } = req.query;

      // No page param → flat array (backward-compat for dropdowns / offline sync)
      if (!page) {
        const items = await storage.getAllStockItems(companyId);
        return res.json(items);
      }

      // Paginated path
      const pageNum = Math.max(1, parseInt(page as string) || 1);
      const pageSizeNum = Math.min(500, Math.max(1, parseInt(pageSize as string) || 50));
      const offset = (pageNum - 1) * pageSizeNum;

      const conditions: (SQL | undefined)[] = [eq(stockItems.companyId, companyId), isNull(stockItems.deletedAt)];
      if (search && typeof search === "string" && search.trim()) {
        const q = `%${search.trim()}%`;
        conditions.push(or(ilike(stockItems.name, q), ilike(stockItems.code, q)));
      }
      if (stockGroupId && stockGroupId !== "all") {
        conditions.push(eq(stockItems.stockGroupId, parseInt(stockGroupId as string)));
      }
      const { gradeId, categoryId } = req.query;
      if (gradeId === "none") {
        conditions.push(isNull(stockItems.gradeId));
      } else if (gradeId && gradeId !== "all") {
        conditions.push(eq(stockItems.gradeId, parseInt(gradeId as string)));
      }
      if (categoryId === "none") {
        conditions.push(isNull(stockItems.categoryId));
      } else if (categoryId && categoryId !== "all") {
        conditions.push(eq(stockItems.categoryId, parseInt(categoryId as string)));
      }
      if (active === "true") {
        conditions.push(eq(stockItems.active, true));
      } else if (active === "false") {
        conditions.push(eq(stockItems.active, false));
      }
      const where = and(...conditions);

      const [{ total }] = await db
        .select({ total: sql<number>`count(*)::int` })
        .from(stockItems)
        .where(where);

      const data = await db
        .select()
        .from(stockItems)
        .where(where)
        .orderBy(asc(stockItems.name))
        .limit(pageSizeNum)
        .offset(offset);

      return res.json({
        data,
        page: pageNum,
        pageSize: pageSizeNum,
        total,
        totalPages: Math.ceil(total / pageSizeNum),
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Bulk rename existing stock items by primary code. Intentionally name-only:
  // inventory, costs, prices, barcodes, groups, grades and categories are untouched.
  app.post("/api/stock-items/update-names-by-code", requireAuth, requireNonPOS, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const inputRows = req.body?.rows as Array<{ code?: unknown; newName?: unknown }> | undefined;
      if (!Array.isArray(inputRows) || inputRows.length === 0) {
        return res.status(400).json({ message: "rows must be a non-empty array" });
      }
      if (inputRows.length > 5000) {
        return res.status(400).json({ message: "A maximum of 5,000 rows can be updated at once" });
      }

      const rows = inputRows.map((row, index) => ({
        row: index + 1,
        code: String(row?.code ?? "").trim(),
        newName: String(row?.newName ?? "").trim(),
      }));
      const invalidRows = rows.filter((row) => !row.code || !row.newName || row.newName.length > 500);
      if (invalidRows.length > 0) {
        return res.status(400).json({
          message: "Every row requires a code and a new name of 500 characters or fewer",
          invalidRows: invalidRows.map((row) => row.row),
        });
      }

      const seen = new Set<string>();
      const duplicateCodes = new Set<string>();
      for (const row of rows) {
        const key = row.code.toLowerCase();
        if (seen.has(key)) duplicateCodes.add(row.code);
        seen.add(key);
      }
      if (duplicateCodes.size > 0) {
        return res.status(400).json({
          message: "Duplicate item codes were found in the upload",
          duplicateCodes: Array.from(duplicateCodes),
        });
      }

      const existingItems = await db
        .select({ id: stockItems.id, code: stockItems.code, name: stockItems.name })
        .from(stockItems)
        .where(and(eq(stockItems.companyId, companyId), isNull(stockItems.deletedAt)));
      const itemByCode = new Map(existingItems.map((item) => [item.code.trim().toLowerCase(), item]));

      const notFoundCodes: string[] = [];
      const changed: Array<{ id: number; code: string; oldName: string; newName: string }> = [];
      let unchanged = 0;

      await db.transaction(async (tx) => {
        for (const row of rows) {
          const item = itemByCode.get(row.code.toLowerCase());
          if (!item) {
            notFoundCodes.push(row.code);
            continue;
          }
          if (item.name === row.newName) {
            unchanged++;
            continue;
          }

          await tx
            .update(stockItems)
            .set({ name: row.newName })
            .where(and(eq(stockItems.id, item.id), eq(stockItems.companyId, companyId), isNull(stockItems.deletedAt)));
          changed.push({ id: item.id, code: item.code, oldName: item.name, newName: row.newName });
          // Phase 21 (B): each rename's audit row commits with the renames.
          await logAudit(
            {
              userId: req.session.userId!,
              username: req.session.username || "unknown",
              companyId,
              action: "update",
              tableName: "stock_items",
              recordId: item.id,
              recordIdentifier: `${item.code} - ${row.newName}`,
              changes: { name: { old: item.name, new: row.newName } },
            },
            tx
          );
        }
      });

      return res.json({
        message: `Name update complete: ${changed.length} updated, ${unchanged} unchanged, ${notFoundCodes.length} code(s) not found`,
        updated: changed.length,
        unchanged,
        notFound: notFoundCodes.length,
        notFoundCodes,
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/stock-items", requireAuth, requireNonPOS, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      // Inject companyId before schema validation
      const dataWithCompany = {
        ...req.body,
        companyId: req.session.currentCompanyId,
      };

      const parsed = insertStockItemSchema.parse(dataWithCompany);

      // Require a valid stock group (no null/uncategorized)
      if (!parsed.stockGroupId) {
        return res.status(400).json({ message: "Stock Group is required. Please select a valid stock group." });
      }

      // Check for duplicate code within the same company
      const existing = await storage.getStockItemByCode(parsed.code, req.session.currentCompanyId);
      if (existing) {
        return res.status(400).json({ message: "Stock item code already exists in this company" });
      }

      // Calculate opening value if qty and rate provided
      if (parsed.openingQty && parsed.openingRate) {
        const qty = toMoney(parsed.openingQty).toNumber();
        const rate = toMoney(parsed.openingRate).toNumber();
        parsed.openingValue = (qty * rate).toFixed(2);
      }

      // Phase 21 (B): the write and its audit commit together.
      const item = await db.transaction(async (tx) => {
        const written = await storage.createStockItem(parsed, tx);
        await logAudit(
          {
            userId: req.session.userId!,
            username: req.session.username || "unknown",
            companyId: req.session.currentCompanyId!,
            action: "create",
            tableName: "stock_items",
            recordId: written.id,
            recordIdentifier: written.name,
            changes: {
              name: { new: written.name },
              code: { new: written.code },
              uom: { new: written.uom },
              sellingPrice: { new: written.sellingPrice || "0" },
              openingQty: { new: written.openingQty || "0" },
              openingRate: { new: written.openingRate || "0" },
            },
          },
          tx
        );
        return written;
      });
      res.status(201).json(item);
    } catch (error: unknown) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });
}
