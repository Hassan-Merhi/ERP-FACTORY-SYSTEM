/**
 * stockTransferAdjRoutes: StockItemImport endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { db } from "../../../db";
import { storage } from "../../../storage";
import { requireAuth, requireNonPOS } from "../../../auth";
import { stockItems, stockItemCodeAliases, insertStockItemSchema } from "@shared/schema";
import { eq } from "drizzle-orm";
import {
  addStockItemAliasTx,
  finishStockItemEditCaptureTx,
  stockItemEditRecorder,
} from "../../../services/inventory/stockItemEditCapture";
import { registerStockItemImportRoutesPart1 } from "./registerStockItemImportRoutesPart1";

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

      const recorder = stockItemEditRecorder("POST /api/stock-items/import-barcodes");
      if (recorder.active) {
        // Factory LAN server: one transaction, every added barcode recorded for the cloud.
        await db.transaction(async (tx) => {
          for (const row of rows) {
            const itemCodeKey = (row.itemCode || "").trim().toLowerCase();
            const barcodeKey = (row.barcode || "").trim().toLowerCase();
            const stockItemId = itemCodeKey ? itemByCode.get(itemCodeKey) : undefined;
            if (!itemCodeKey || !barcodeKey) {
              skipped++;
            } else if (!stockItemId) {
              notFoundCodes.push(row.itemCode);
            } else if (itemCodeKey === barcodeKey || aliasByCode.has(barcodeKey)) {
              skipped++;
            } else if (
              await addStockItemAliasTx(tx, recorder, { companyId, stockItemId, aliasCode: (row.barcode || "").trim() })
            ) {
              aliasByCode.set(barcodeKey, stockItemId);
              imported++;
            } else {
              skipped++;
            }
          }
          await finishStockItemEditCaptureTx(tx, req, recorder);
        });
        return res.json({ imported, skipped, notFound: notFoundCodes.length, notFoundCodes });
      }

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

  registerStockItemImportRoutesPart1(app);
}
