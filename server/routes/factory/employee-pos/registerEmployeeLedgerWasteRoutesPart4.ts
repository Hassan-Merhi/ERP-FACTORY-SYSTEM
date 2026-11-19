// Extracted from ./employeeLedgerWasteRoutes.ts
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import type { Express, Request, Response } from "express";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { adjustInventory } from "../../../inventoryHelper";
import { postStockMovementTx } from "../../../services/inventory/stockMovementIntegrityService";
import { writeDaybookEntry } from "../_helpers";
import { assertNoBaleOnLiveLoadingTx } from "../stock/liveLoadingBales";
import { recordFactoryStockValueEventTx, valuedBalesCostTx } from "../../../services/factory/factoryStockValueEvents";
import { factoryBaleProducts, factoryBales, stockItems, factoryBaleWasteDispatches } from "@shared/schema";
import { eq, and, desc, sql, inArray } from "drizzle-orm";
import { sumMoney, toMoney } from "../../../lib/money";
import { canonicalStockMovementAdapter } from "./registerEmployeeLedgerWasteRoutesPart1";

export function registerEmployeeLedgerWasteRoutesPart4(app: Express) {
  app.post("/api/factory/waste-dispatch/submit", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { baleIds, dispatchDate, notes } = req.body;
      if (!baleIds || !Array.isArray(baleIds) || baleIds.length === 0) {
        return res.status(400).json({ message: "baleIds array is required" });
      }
      if (!dispatchDate) {
        return res.status(400).json({ message: "dispatchDate is required" });
      }

      // `session.user` is never populated anywhere in this codebase — the login
      // flows set `session.userId` — so reading an id off it always produced
      // null and every waste dispatch was recorded with no creator.
      const userId = req.session.userId ?? null;

      const [lastDispatch] = await db
        .select({ dispatchNumber: factoryBaleWasteDispatches.dispatchNumber })
        .from(factoryBaleWasteDispatches)
        .where(eq(factoryBaleWasteDispatches.companyId, companyId))
        .orderBy(desc(factoryBaleWasteDispatches.id))
        .limit(1);

      let nextNum = 1;
      if (lastDispatch?.dispatchNumber) {
        const parts = lastDispatch.dispatchNumber.split("-");
        const last = parseInt(parts[parts.length - 1] || "0", 10);
        if (!isNaN(last)) nextNum = last + 1;
      }
      const dispatchNumber = `WD-${String(nextNum).padStart(4, "0")}`;

      const result = await db.transaction(async (tx) => {
        const balesToDispose = await tx
          .select()
          .from(factoryBales)
          .where(and(eq(factoryBales.companyId, companyId), inArray(factoryBales.id, baleIds)));

        if (balesToDispose.length === 0) throw new Error("No valid bales found");

        for (const bale of balesToDispose) {
          if (bale.status !== "IN_STOCK") {
            throw new Error(`Bale ${bale.referenceNumber} is not available (status: ${bale.status})`);
          }
        }
        // V5 loaded bales on a live loading are refused (main #2134).
        await assertNoBaleOnLiveLoadingTx(
          tx,
          companyId,
          balesToDispose.map((bale) => bale.id)
        );

        // Perpetual inventory: the bales' cost is a write-off in the daily
        // factory stock journal (wave 11).
        await recordFactoryStockValueEventTx(tx, {
          companyId,
          kind: "WASTE",
          amount: (
            await valuedBalesCostTx(
              tx,
              companyId,
              balesToDispose.map((bale) => bale.id)
            )
          ).negated(),
          sourceType: "factory-waste-dispatch",
          sourceId: dispatchNumber,
        });

        const totalWeightKg = sumMoney(balesToDispose.map((bale) => bale.weightKg as string)).toNumber();
        const totalCostWrittenOff = sumMoney(balesToDispose.map((bale) => bale.totalCost as string)).toNumber();

        const [dispatch] = await tx
          .insert(factoryBaleWasteDispatches)
          .values({
            companyId,
            dispatchNumber,
            dispatchDate,
            notes: notes || null,
            totalBales: balesToDispose.length,
            totalWeightKg: totalWeightKg.toFixed(3),
            totalCostWrittenOff: totalCostWrittenOff.toFixed(2),
            createdBy: userId,
          })
          .returning();

        const now = new Date();

        const productIds = [...new Set(balesToDispose.map((b) => b.productId).filter(Boolean))] as number[];
        const factoryProducts =
          productIds.length > 0
            ? await tx.select().from(factoryBaleProducts).where(inArray(factoryBaleProducts.id, productIds))
            : [];
        const productMap = new Map(factoryProducts.map((p) => [p.id, p]));
        const stockItemCache = new Map<string, number>();

        for (const bale of balesToDispose) {
          await tx.execute(
            sql`UPDATE factory_bales SET status = 'DISPATCHED', waste_dispatch_id = ${dispatch.id}, updated_at = ${now} WHERE id = ${bale.id}`
          );

          const product = productMap.get(bale.productId as number);
          const itemCode = product?.articleCode || product?.code || bale.articleCode || bale.baleCode;
          if (itemCode && bale.erpLocationId) {
            let erpStockItemId = stockItemCache.get(itemCode);
            if (!erpStockItemId) {
              const [existing] = await tx
                .select({ id: stockItems.id })
                .from(stockItems)
                .where(and(eq(stockItems.companyId, companyId), eq(stockItems.code, itemCode)));
              if (existing) {
                erpStockItemId = existing.id;
                stockItemCache.set(itemCode, erpStockItemId!);
              }
            }
            if (erpStockItemId) {
              const adjustment = await adjustInventory(tx, bale.erpLocationId, erpStockItemId, -1, companyId);
              await postStockMovementTx(
                tx,
                {
                  companyId,
                  stockItemId: erpStockItemId,
                  kind: "adjustment",
                  quantity: "1",
                  unitCost: String(Math.max(adjustment.averageRate || 0, 0)),
                  fromLocationId: bale.erpLocationId,
                  occurredAt: now.toISOString(),
                  source: {
                    sourceType: "factory_waste_dispatch",
                    sourceId: String(dispatch.id),
                    idempotencyKey: `factory-waste-dispatch:${companyId}:${dispatch.id}:${bale.id}`,
                  },
                  actor: {
                    userId: userId ?? undefined,
                    username: req.session.username,
                    reason: notes || `Waste dispatch ${dispatchNumber}`,
                  },
                  allowNegativeStock: true,
                },
                canonicalStockMovementAdapter
              );
            }
          }
        }

        return { dispatch, totalWeightKg, totalCostWrittenOff, bales: balesToDispose };
      });

      await writeDaybookEntry(db, {
        companyId,
        txDate: dispatchDate,
        txType: "WASTE_DISPOSAL",
        referenceId: result.dispatch.id,
        referenceTable: "factory_bale_waste_dispatches",
        description: `Waste disposal ${dispatchNumber}: ${result.bales.length} bale(s), ${result.totalWeightKg.toFixed(1)} kg written off.${notes ? " " + notes : ""}`,
        amountCurrency: result.totalCostWrittenOff,
        amountUsd: result.totalCostWrittenOff,
        createdBy: userId,
      });

      res.json({
        dispatch: result.dispatch,
        totalBales: result.bales.length,
        totalWeightKg: result.totalWeightKg,
        totalCostWrittenOff: result.totalCostWrittenOff,
        bales: result.bales.map((b) => ({
          id: b.id,
          referenceNumber: b.referenceNumber,
          weightKg: toMoney(b.weightKg as string).toNumber(),
          totalCost: toMoney(b.totalCost as string).toNumber(),
        })),
      });
    } catch (error: unknown) {
      logger.error("Error submitting waste dispatch:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });
}
