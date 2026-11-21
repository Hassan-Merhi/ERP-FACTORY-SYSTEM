// Extracted from ./bulk-ops.ts
import type { Express } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { db } from "../../../db";
import { storage } from "../../../storage";
import { requireAuth, requireNonPOS } from "../../../auth";
import { logAudit } from "../../_helpers";
import { stockItems } from "@shared/schema";
import { eq, and, or } from "drizzle-orm";
import { toMoney } from "../../../lib/money";
import {
  finishStockItemEditCaptureTx,
  stockItemEditRecorder,
  updateStockItemFieldsTx,
  upsertLocationPriceTx,
} from "../../../services/inventory/stockItemEditCapture";

export function registerStockItemBulkRoutesPart1(app: Express) {
  // Bulk update selling prices by barcode (global or location-specific)
  app.post("/api/stock-items/bulk-update-prices", requireAuth, requireNonPOS, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const { prices } = req.body;
      if (!Array.isArray(prices) || prices.length === 0) {
        return res.status(400).json({ message: "Invalid or empty prices array" });
      }

      const companyId = req.session.currentCompanyId;

      // Pre-fetch all items + aliases once to avoid N+1
      const allItems = await storage.getAllStockItems(companyId);
      const allAliases = await storage.getAllCompanyCodeAliases(companyId);
      const itemsById = new Map(allItems.map((i) => [i.id, i]));
      const itemsByCode = new Map<string, (typeof allItems)[0]>();
      for (const item of allItems) {
        if (item.code) itemsByCode.set(item.code.toLowerCase(), item);
      }
      for (const alias of allAliases) {
        if (alias.aliasCode && !itemsByCode.has(alias.aliasCode.toLowerCase())) {
          const item = itemsById.get(alias.stockItemId);
          if (item) itemsByCode.set(alias.aliasCode.toLowerCase(), item);
        }
      }

      let updated = 0;
      let notFound = 0;
      type GlobalUpdate = { id: number; sellingPrice: string };
      type LocationUpdate = { stockItemId: number; locationId: number; sellingPrice: string };
      const globalUpdates: GlobalUpdate[] = [];
      const locationUpdates: LocationUpdate[] = [];

      for (const priceEntry of prices) {
        const { barcode, sellingPrice, locationId } = priceEntry;
        if (!barcode || !sellingPrice) continue;
        const item = itemsByCode.get((barcode as string).toLowerCase());
        if (item) {
          if (locationId) {
            locationUpdates.push({ stockItemId: item.id, locationId, sellingPrice });
          } else {
            globalUpdates.push({ id: item.id, sellingPrice });
          }
          updated++;
        } else {
          notFound++;
        }
      }

      if (globalUpdates.length > 0 || locationUpdates.length > 0) {
        const recorder = stockItemEditRecorder("POST /api/stock-items/bulk-update-prices");
        await db.transaction(async (tx) => {
          for (const u of globalUpdates) {
            await updateStockItemFieldsTx(tx, recorder, u.id, { sellingPrice: u.sellingPrice });
          }
          for (const u of locationUpdates) {
            await upsertLocationPriceTx(tx, recorder, {
              stockItemId: u.stockItemId,
              locationId: u.locationId,
              sellingPrice: u.sellingPrice,
            });
          }
          // Factory LAN server: the price changes are recorded for the cloud.
          await finishStockItemEditCaptureTx(tx, req, recorder);
          // Phase 21 (B): the bulk price audit commits with the prices.
          await logAudit(
            {
              userId: req.session.userId!,
              username: req.session.username || "unknown",
              companyId: companyId,
              action: "update",
              tableName: "stock_items",
              recordId: 0,
              recordIdentifier: `Bulk price update (${updated} items)`,
              changes: {
                pricesUpdated: { new: updated },
                barcodesNotFound: { new: notFound },
              },
            },
            tx
          );
        });
      }

      const message = `Updated ${updated} price(s)${notFound > 0 ? `. ${notFound} barcode(s) not found.` : "."}`;
      res.json({ message, updated, notFound });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Import Opening Balances from Excel (columns: Barcode, Qty, Rate, Total Value)
  // This only updates stockItems opening fields, does NOT affect location inventory
  app.post("/api/stock-items/import-opening-balances", requireAuth, requireNonPOS, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const { openingBalances } = req.body;
      if (!Array.isArray(openingBalances) || openingBalances.length === 0) {
        return res.status(400).json({ message: "Invalid or empty opening balances array" });
      }

      let updated = 0;
      let notFound = 0;
      const notFoundBarcodes: string[] = [];

      // Pre-fetch all stock items once for efficient lookup
      const allItems = await storage.getAllStockItems(req.session.currentCompanyId);
      // Map by primary code field (skip empty/null codes)
      const itemsByCode = new Map<string, (typeof allItems)[0]>();
      const itemsById = new Map(allItems.map((i) => [i.id, i]));
      for (const item of allItems) {
        if (item.code && typeof item.code === "string") {
          itemsByCode.set((item.code || "").toLowerCase(), item);
        }
      }

      // Pre-fetch all code aliases and build alias lookup map (skip empty/null aliases)
      const allAliases = await storage.getAllCompanyCodeAliases(req.session.currentCompanyId);
      const itemsByAlias = new Map<string, (typeof allItems)[0]>();
      for (const alias of allAliases) {
        if (alias.aliasCode && typeof alias.aliasCode === "string") {
          const item = itemsById.get(alias.stockItemId);
          if (item) {
            itemsByAlias.set((alias.aliasCode || "").toLowerCase(), item);
          }
        }
      }

      const recorder = stockItemEditRecorder("POST /api/stock-items/import-opening-balances");
      await db.transaction(async (tx) => {
        for (const entry of openingBalances) {
          const { barcode, openingQty, openingRate, openingValue } = entry;
          if (!barcode || typeof barcode !== "string") continue;

          // Find item by primary code first, then by alias (case-insensitive)
          const barcodeLC = (barcode || "").toLowerCase();
          const item = itemsByCode.get(barcodeLC) || itemsByAlias.get(barcodeLC);

          if (item) {
            // Calculate total value if not provided: qty * rate
            const qty = toMoney(openingQty).toNumber();
            const rate = toMoney(openingRate).toNumber();
            let totalValue = toMoney(openingValue).toNumber();

            // If total value not provided, calculate from qty * rate
            if (totalValue === 0 && qty > 0 && rate > 0) {
              totalValue = qty * rate;
            }

            await updateStockItemFieldsTx(tx, recorder, item.id, {
              openingQty: String(qty),
              openingRate: String(rate),
              openingValue: String(totalValue),
            });
            updated++;
          } else {
            notFound++;
            notFoundBarcodes.push(barcode);
          }
        }
        // Factory LAN server: the opening balances are recorded for the cloud.
        await finishStockItemEditCaptureTx(tx, req, recorder);
      });

      const message = `Updated opening balances for ${updated} item(s)${notFound > 0 ? `. ${notFound} barcode(s) not found: ${notFoundBarcodes.slice(0, 5).join(", ")}${notFoundBarcodes.length > 5 ? "..." : ""}` : "."}`;
      res.json({ message, updated, notFound, notFoundBarcodes });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Bulk update UOM from "bale" to "BL"
  app.post("/api/stock-items/bulk-update-uom", requireAuth, requireNonPOS, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      // Find all stock items with UOM = "bale" for current company (case-insensitive)
      const baleItems = await db.query.stockItems.findMany({
        where: and(
          eq(stockItems.companyId, req.session.currentCompanyId),
          or(eq(stockItems.uom, "bale"), eq(stockItems.uom, "Bale"), eq(stockItems.uom, "BALE"))
        ),
      });

      if (baleItems.length === 0) {
        return res.json({ message: "No items with UOM 'bale' found to update", updated: 0 });
      }

      // Update all bale items to BL
      let updated = 0;
      const recorder = stockItemEditRecorder("POST /api/stock-items/bulk-update-uom");
      await db.transaction(async (tx) => {
        for (const item of baleItems) {
          await updateStockItemFieldsTx(tx, recorder, item.id, { uom: "BL" });
          updated++;
        }
        await finishStockItemEditCaptureTx(tx, req, recorder);
      });

      res.json({ message: `Successfully updated ${updated} stock item(s) from 'bale' to 'BL'`, updated });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
