import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import type { Express } from "express";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { adjustInventory } from "../../../inventoryHelper";
import { postStockMovementTx } from "../../../services/inventory/stockMovementIntegrityService";
import { recordFactoryStockValueEventTx, valuedBalesCostTx } from "../../../services/factory/factoryStockValueEvents";
import { stockItems, factoryDaybookEntries, factoryBaleWasteDispatches } from "@shared/schema";
import { eq, and, sql } from "drizzle-orm";
import { resultRows } from "../../../lib/queryResult";
import {
  canonicalStockMovementAdapter,
  registerEmployeeLedgerWasteRoutesPart1,
} from "./registerEmployeeLedgerWasteRoutesPart1";
import { registerEmployeeLedgerWasteRoutesPart2 } from "./registerEmployeeLedgerWasteRoutesPart2";
import { registerEmployeeLedgerWasteRoutesPart4 } from "./registerEmployeeLedgerWasteRoutesPart4";

export function registerEmployeeLedgerWasteRoutes(app: Express) {
  registerEmployeeLedgerWasteRoutesPart1(app);
  registerEmployeeLedgerWasteRoutesPart2(app);
  registerEmployeeLedgerWasteRoutesPart3(app);

  // ─── Factory POS ────────────────────────────────────────────────────────────

  // GET /api/factory/pos/sales — list factory POS sales
}

function registerEmployeeLedgerWasteRoutesPart3(app: Express) {
  // ── DELETE /api/factory/waste-dispatch/:id ─────────────────────────────────
  // Reverses a waste dispatch: restores bales to IN_STOCK, reverses ERP stock, deletes daybook entry.
  app.delete(
    "/api/factory/waste-dispatch/:id",
    requireAuth,
    async (req: import("express").Request, res: import("express").Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const dispatchId = parseInt(req.params.id);
        if (isNaN(dispatchId)) return res.status(400).json({ message: "Invalid dispatch id" });

        const [dispatch] = await db
          .select()
          .from(factoryBaleWasteDispatches)
          .where(
            and(eq(factoryBaleWasteDispatches.id, dispatchId), eq(factoryBaleWasteDispatches.companyId, companyId))
          );

        if (!dispatch) return res.status(404).json({ message: "Dispatch not found" });

        // Fetch all bales linked to this dispatch
        const linkedBales = await db.execute(sql`
        SELECT id, erp_location_id AS "erpLocationId", product_id AS "productId", article_code AS "articleCode"
        FROM factory_bales
        WHERE company_id = ${companyId} AND waste_dispatch_id = ${dispatchId}
      `);
        const bales = Array.isArray(linkedBales) ? linkedBales : resultRows(linkedBales);

        await db.transaction(async (tx) => {
          const now = new Date();

          // 1. Restore each bale to IN_STOCK and clear waste_dispatch_id
          for (const bale of bales) {
            await tx.execute(
              sql`UPDATE factory_bales SET status = 'IN_STOCK', waste_dispatch_id = NULL, updated_at = ${now} WHERE id = ${bale.id}`
            );

            // 2. Reverse the ERP stock adjustment (+1 per bale)
            if (bale.articleCode && bale.erpLocationId) {
              const [existing] = await tx
                .select({ id: stockItems.id })
                .from(stockItems)
                .where(and(eq(stockItems.companyId, companyId), eq(stockItems.code, bale.articleCode)));
              if (existing) {
                // The ERP bale mirror is quantity only (wave 11): rate 0.
                await adjustInventory(tx, bale.erpLocationId, existing.id, 1, companyId, 0);
                await postStockMovementTx(
                  tx,
                  {
                    companyId,
                    stockItemId: existing.id,
                    kind: "adjustment",
                    quantity: "1",
                    unitCost: "0",
                    toLocationId: bale.erpLocationId,
                    occurredAt: now.toISOString(),
                    source: {
                      sourceType: "factory_waste_dispatch_restore",
                      sourceId: String(dispatchId),
                      idempotencyKey: `factory-waste-dispatch:restore:${companyId}:${dispatchId}:${bale.id}`,
                    },
                    actor: {
                      userId: req.session.userId,
                      username: req.session.username,
                      reason: `Delete waste dispatch ${dispatch.dispatchNumber}`,
                    },
                  },
                  canonicalStockMovementAdapter
                );
              }
            }
          }

          // Perpetual inventory: the restored bales are factory stock again at
          // their cost, reversing the write-off (wave 11).
          await recordFactoryStockValueEventTx(tx, {
            companyId,
            kind: "WASTE",
            amount: await valuedBalesCostTx(
              tx,
              companyId,
              bales.map((bale) => Number(bale.id))
            ),
            sourceType: "factory-waste-dispatch-restore",
            sourceId: dispatchId,
          });

          // 3. Delete the daybook entry for this dispatch
          await tx
            .delete(factoryDaybookEntries)
            .where(
              and(
                eq(factoryDaybookEntries.referenceTable, "factory_bale_waste_dispatches"),
                eq(factoryDaybookEntries.referenceId, dispatchId)
              )
            );

          // 4. Delete the dispatch record
          await tx.delete(factoryBaleWasteDispatches).where(eq(factoryBaleWasteDispatches.id, dispatchId));
        });

        res.json({ message: "Waste dispatch deleted and bales restored to stock", restoredBales: bales.length });
      } catch (error: unknown) {
        logger.error("[Waste Dispatch DELETE]", { error: getErrorMessage(error) });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  registerEmployeeLedgerWasteRoutesPart4(app);
}
