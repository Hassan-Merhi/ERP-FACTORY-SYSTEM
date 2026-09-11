import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { db } from "../../db";
import { storage } from "../../storage";
import { requireAuth, requireNonPOS } from "../../auth";
import { upload, logAudit } from "../_helpers";
import {
  inventory,
  stockItems,
  stockGroups,
  stockItemCodeAliases,
  stockItemLocationPrices,
  insertStockItemSchema,
  locations,
  userLocations,
  locationPriceGroups,
  stockGrades,
  stockCategories,
  type StockItem,
} from "@shared/schema";
import { eq, and, inArray, sql, isNull } from "drizzle-orm";
import { readExcel, sheetToJson } from "../../excelHelper";

type PriceListRow = {
  stockItemId: number;
  code: string;
  name: string;
  stockGroupName: string;
  baseSellingPrice: string | null;
  hasCustomPrice: boolean;
  sellingPrice: string | null;
  quantity: string;
  costPrice?: string | null;
  offloadingCost?: string | null;
};

export function registerStockPriceListImportRoutes(app: Express) {
  app.get("/api/location-price-groups", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const rows = await db.select().from(locationPriceGroups).where(eq(locationPriceGroups.companyId, companyId));

      // Group by masterLocationId
      const map = new Map<number, number[]>();
      for (const r of rows) {
        if (!map.has(r.masterLocationId)) map.set(r.masterLocationId, []);
        map.get(r.masterLocationId)!.push(r.followerLocationId);
      }
      const result = Array.from(map.entries()).map(([masterLocationId, followerLocationIds]) => ({
        masterLocationId,
        followerLocationIds,
      }));
      res.json(result);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // PUT: replaces the full group config for the company
  app.put("/api/location-price-groups", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      // groups: Array<{ masterLocationId: number; followerLocationIds: number[] }>
      const { groups } = req.body as { groups: { masterLocationId: number; followerLocationIds: number[] }[] };
      if (!Array.isArray(groups)) return res.status(400).json({ message: "groups must be an array" });

      // Delete all existing for this company, then re-insert
      await db.delete(locationPriceGroups).where(eq(locationPriceGroups.companyId, companyId));

      const toInsert = groups.flatMap((g) =>
        g.followerLocationIds.map((fid) => ({
          companyId,
          masterLocationId: g.masterLocationId,
          followerLocationId: fid,
        }))
      );
      if (toInsert.length > 0) {
        await db.insert(locationPriceGroups).values(toInsert);
      }

      res.json({ message: "Price groups saved" });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // POS Price List: get all stock items with location-specific selling prices
  // Fallback rule: if no custom location price, falls back to stock item base selling price
  app.get("/api/pos/price-list", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const locationIdParam = req.query.locationId as string;
      const showAll = locationIdParam === "all";
      const locationId = showAll ? null : parseInt(locationIdParam);

      if (!showAll && isNaN(locationId as number)) {
        return res.status(400).json({ message: "locationId query parameter is required" });
      }

      const isPOS = req.user?.role === "POS";
      const isPrivileged = ["Admin", "Owner", "Manager", "Developer"].includes(req.user?.role || "");

      if (showAll && isPOS) {
        return res.status(403).json({ message: "Forbidden" });
      }

      if (!showAll) {
        if (isPOS) {
          const assigned = await db
            .select({ locationId: userLocations.locationId })
            .from(userLocations)
            .where(and(eq(userLocations.userId, req.user!.id), eq(userLocations.companyId, companyId)));
          const assignedIds = assigned.map((r) => r.locationId);
          if (!assignedIds.includes(locationId as number)) {
            return res.status(403).json({ message: "Forbidden: location not assigned to this user" });
          }
        } else {
          const [loc] = await db
            .select({ id: locations.id })
            .from(locations)
            .where(and(eq(locations.id, locationId as number), eq(locations.companyId, companyId)));
          if (!loc) {
            return res.status(403).json({ message: "Forbidden: location not found" });
          }
        }
      }

      let rows: PriceListRow[];

      if (showAll) {
        rows = await db
          .select({
            stockItemId: stockItems.id,
            code: stockItems.code,
            name: stockItems.name,
            stockGroupName: sql<string>`COALESCE(${stockGroups.name}, '')`,
            baseSellingPrice: stockItems.sellingPrice,
            hasCustomPrice: sql<boolean>`false`,
            sellingPrice: stockItems.sellingPrice,
            quantity: sql<string>`'0'`,
          })
          .from(stockItems)
          .leftJoin(stockGroups, eq(stockItems.stockGroupId, stockGroups.id))
          .where(and(eq(stockItems.companyId, companyId), isNull(stockItems.deletedAt)))
          .orderBy(stockItems.name);
      } else {
        rows = await db
          .select({
            stockItemId: stockItems.id,
            code: stockItems.code,
            name: stockItems.name,
            stockGroupName: sql<string>`COALESCE(${stockGroups.name}, '')`,
            baseSellingPrice: stockItems.sellingPrice,
            hasCustomPrice: sql<boolean>`(${stockItemLocationPrices.sellingPrice} IS NOT NULL)`,
            sellingPrice: sql<string>`COALESCE(${stockItemLocationPrices.sellingPrice}, ${stockItems.sellingPrice})`,
            quantity: sql<string>`COALESCE(${inventory.quantity}::text, '0')`,
          })
          .from(stockItems)
          .leftJoin(stockGroups, eq(stockItems.stockGroupId, stockGroups.id))
          .leftJoin(
            stockItemLocationPrices,
            and(
              eq(stockItemLocationPrices.stockItemId, stockItems.id),
              eq(stockItemLocationPrices.locationId, locationId as number)
            )
          )
          .leftJoin(
            inventory,
            and(eq(inventory.stockItemId, stockItems.id), eq(inventory.locationId, locationId as number))
          )
          .where(and(eq(stockItems.companyId, companyId), isNull(stockItems.deletedAt)))
          .orderBy(stockItems.name);
      }

      // For privileged users, fetch Dubai cost (from latest PO line rate) and offloading cost
      if (isPrivileged && rows.length > 0) {
        const [dubaiCostRes, offloadCostRes] = await Promise.all([
          db.execute(sql`
            SELECT DISTINCT ON (pli.stock_item_id)
              pli.stock_item_id AS "stockItemId",
              pli.rate AS "costDubai"
            FROM po_line_items pli
            JOIN purchase_orders po ON pli.po_id = po.id
            JOIN containers c ON po.container_id = c.id
            WHERE po.company_id = ${companyId}
            ORDER BY pli.stock_item_id, pli.id DESC
          `),
          db.execute(sql`
            SELECT DISTINCT ON (pli.stock_item_id)
              pli.stock_item_id AS "stockItemId",
              co.additional_cost_per_bale AS "offloadingCost"
            FROM container_offloads co
            JOIN containers c ON co.container_id = c.id
            JOIN purchase_orders po ON po.container_id = c.id
            JOIN po_line_items pli ON pli.po_id = po.id
            WHERE c.company_id = ${companyId}
            ORDER BY pli.stock_item_id, co.offloaded_at DESC
          `),
        ]);

        const dubaiMap = new Map<number, string>();
        for (const r of dubaiCostRes.rows) {
          dubaiMap.set(Number(r.stockItemId), String(r.costDubai ?? "0"));
        }
        const offloadMap = new Map<number, string>();
        for (const r of offloadCostRes.rows) {
          offloadMap.set(Number(r.stockItemId), String(r.offloadingCost ?? "0"));
        }

        rows = rows.map((row) => ({
          ...row,
          costPrice: dubaiMap.get(row.stockItemId) ?? null,
          offloadingCost: offloadMap.get(row.stockItemId) ?? null,
        }));
      }

      res.json(rows);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Price list for All Locations view: one price column per configured master location
  app.get("/api/pos/price-list-by-masters", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const isPrivileged = ["Admin", "Owner", "Manager", "Developer"].includes(req.user?.role || "");

      // Get all configured master location IDs
      const groupRows = await db
        .select({ masterLocationId: locationPriceGroups.masterLocationId })
        .from(locationPriceGroups)
        .where(eq(locationPriceGroups.companyId, companyId));

      const masterIds = [...new Set(groupRows.map((r) => r.masterLocationId))];

      // Get master location names
      const masterLocations =
        masterIds.length > 0
          ? await db
              .select({ id: locations.id, name: locations.name })
              .from(locations)
              .where(and(eq(locations.companyId, companyId), inArray(locations.id, masterIds)))
          : [];

      // Get all active stock items
      const items = await db
        .select({
          stockItemId: stockItems.id,
          code: stockItems.code,
          name: stockItems.name,
          stockGroupName: sql<string>`COALESCE(${stockGroups.name}, '')`,
          baseSellingPrice: stockItems.sellingPrice,
        })
        .from(stockItems)
        .leftJoin(stockGroups, eq(stockItems.stockGroupId, stockGroups.id))
        .where(and(eq(stockItems.companyId, companyId), isNull(stockItems.deletedAt)))
        .orderBy(stockItems.name);

      // Get location-specific prices for all master locations in one query
      const masterPriceRows =
        masterIds.length > 0
          ? await db
              .select({
                stockItemId: stockItemLocationPrices.stockItemId,
                locationId: stockItemLocationPrices.locationId,
                sellingPrice: stockItemLocationPrices.sellingPrice,
              })
              .from(stockItemLocationPrices)
              .where(
                and(
                  inArray(stockItemLocationPrices.locationId, masterIds),
                  inArray(
                    stockItemLocationPrices.stockItemId,
                    items.map((i) => i.stockItemId)
                  )
                )
              )
          : [];

      // Build a nested map: stockItemId -> locationId -> price
      const priceMap = new Map<number, Map<number, string>>();
      for (const p of masterPriceRows) {
        if (!priceMap.has(p.stockItemId)) priceMap.set(p.stockItemId, new Map());
        priceMap.get(p.stockItemId)!.set(p.locationId, p.sellingPrice);
      }

      // Attach cost data for privileged users
      const dubaiMap = new Map<number, string>();
      const offloadMap = new Map<number, string>();
      if (isPrivileged && items.length > 0) {
        const [dubaiCostRes, offloadCostRes] = await Promise.all([
          db.execute(sql`
            SELECT DISTINCT ON (pli.stock_item_id)
              pli.stock_item_id AS "stockItemId",
              pli.rate AS "costDubai"
            FROM po_line_items pli
            JOIN purchase_orders po ON pli.po_id = po.id
            JOIN containers c ON po.container_id = c.id
            WHERE po.company_id = ${companyId}
            ORDER BY pli.stock_item_id, pli.id DESC
          `),
          db.execute(sql`
            SELECT DISTINCT ON (pli.stock_item_id)
              pli.stock_item_id AS "stockItemId",
              co.additional_cost_per_bale AS "offloadingCost"
            FROM container_offloads co
            JOIN containers c ON co.container_id = c.id
            JOIN purchase_orders po ON po.container_id = c.id
            JOIN po_line_items pli ON pli.po_id = po.id
            WHERE c.company_id = ${companyId}
            ORDER BY pli.stock_item_id, co.offloaded_at DESC
          `),
        ]);
        for (const r of dubaiCostRes.rows) dubaiMap.set(Number(r.stockItemId), String(r.costDubai ?? "0"));
        for (const r of offloadCostRes.rows) offloadMap.set(Number(r.stockItemId), String(r.offloadingCost ?? "0"));
      }

      const result = items.map((item) => {
        const itemPrices: Record<number, string> = {};
        for (const mloc of masterLocations) {
          const custom = priceMap.get(item.stockItemId)?.get(mloc.id);
          itemPrices[mloc.id] = custom ?? item.baseSellingPrice ?? "0";
        }
        const base: {
          masterPrices: Record<number, string>;
          stockItemId: number;
          code: string;
          name: string;
          stockGroupName: string;
          baseSellingPrice: string | null;
          costPrice?: string | null;
          offloadingCost?: string | null;
        } = { ...item, masterPrices: itemPrices };
        if (isPrivileged) {
          base.costPrice = dubaiMap.get(item.stockItemId) ?? null;
          base.offloadingCost = offloadMap.get(item.stockItemId) ?? null;
        }
        return base;
      });

      res.json({ masters: masterLocations, items: result });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

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

      const results: {
        created: StockItem[];
        skipped: Array<{ code: string; name: string; reason: string }>;
        errors: Array<{ code: unknown; name: unknown; error: string }>;
      } = {
        created: [],
        skipped: [],
        errors: [],
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

        const rows = sheetToJson(wb.Sheets[sheetName]);

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
              const [created] = await db
                .insert(stockGrades)
                .values({ name: rawGrade, companyId, active: true })
                .returning();
              gradeByName.set(gradeKey, created);
              summary.gradesCreated++;
              grade = created;
            } else if (!grade.active) {
              // Reactivate inactive grade
              await db.update(stockGrades).set({ active: true }).where(eq(stockGrades.id, grade.id));
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
              const [created] = await db
                .insert(stockCategories)
                .values({ name: rawCategory, companyId, active: true })
                .returning();
              categoryByName.set(catKey, created);
              summary.categoriesCreated++;
              category = created;
            } else if (!category.active) {
              await db.update(stockCategories).set({ active: true }).where(eq(stockCategories.id, category.id));
              category.active = true;
            }
            categoryId = category.id;
          }

          // Update stock item — only gradeId and categoryId
          await db.update(stockItems).set({ gradeId, categoryId }).where(eq(stockItems.id, stockItemId));

          summary.itemsUpdated++;
        }

        // Audit log
        try {
          await logAudit({
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
          });
        } catch {
          /* non-fatal */
        }

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
