import { parseId } from "../../../lib/parseId";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import type { Express, Request, Response } from "express";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { validateRequest } from "../../../lib/validateRequest";
import { deleteBatchSourceInput, deleteReceiptInput, patchReceiptInput } from "./rawStockWriteRouteSchemas";
import {
  factorySuppliers,
  factoryContainers,
  factoryRawStock,
  factoryMixBatches,
  factoryMixBatchSources,
  factoryDaybookEntries,
} from "@shared/schema";
import { eq, and, sql, isNull } from "drizzle-orm";
import type Decimal from "decimal.js";
import { MoneyDecimal, parseMoneyInput, toMoney } from "../../../lib/money";
import { syncContainerCommissionJournalTx } from "../../../services/factory/containerCommissionJournal";
import { ZERO, registerRawStockAdjRoutesPart1 } from "./registerRawStockAdjRoutesPart1";
import { registerRawStockAdjRoutesPart2 } from "./registerRawStockAdjRoutesPart2";

export function registerRawStockAdjRoutes(app: Express) {
  registerRawStockAdjRoutesPart1(app);
  registerRawStockAdjRoutesPart2(app);
  registerRawStockAdjRoutesPart3(app);
}

function registerRawStockAdjRoutesPart3(app: Express) {
  // DELETE a batch source entry for a supplier from a batch (reverses usedKg on raw stock)
  app.delete(
    "/api/factory/raw-stock/batch-source",
    requireAuth,
    validateRequest(deleteBatchSourceInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const batchId = parseId(req.body.batchId) ?? -1;
        const supplierId = parseId(req.body.supplierId) ?? -1;
        if (isNaN(batchId) || isNaN(supplierId))
          return res.status(400).json({ message: "batchId and supplierId are required" });

        await db.transaction(async (tx) => {
          // Verify batch belongs to this company
          const [batch] = await tx
            .select()
            .from(factoryMixBatches)
            .where(and(eq(factoryMixBatches.id, batchId), eq(factoryMixBatches.companyId, companyId)))
            .limit(1);
          if (!batch) throw new Error("Batch not found");

          // Find all source records for this supplier in this batch
          const sources = await tx
            .select()
            .from(factoryMixBatchSources)
            .where(
              and(eq(factoryMixBatchSources.mixBatchId, batchId), eq(factoryMixBatchSources.supplierId, supplierId))
            );
          if (sources.length === 0) throw new Error("No source records found for this supplier in this batch");

          let totalKgToReverse: Decimal = ZERO;
          let totalCostToReverse: Decimal = ZERO;

          for (const src of sources) {
            const srcKg = toMoney(src.weightKg);
            totalKgToReverse = totalKgToReverse.plus(srcKg);
            totalCostToReverse = totalCostToReverse.plus(toMoney(src.totalCost));

            // If this source references a container raw stock row, reverse usedKg
            if (src.containerId) {
              await tx
                .update(factoryRawStock)
                .set({ usedKg: sql`GREATEST(0, ${factoryRawStock.usedKg} - ${srcKg.toString()})` })
                .where(and(eq(factoryRawStock.companyId, companyId), eq(factoryRawStock.containerId, src.containerId)));
            }
          }

          // Delete all source records for this supplier in this batch
          await tx
            .delete(factoryMixBatchSources)
            .where(
              and(eq(factoryMixBatchSources.mixBatchId, batchId), eq(factoryMixBatchSources.supplierId, supplierId))
            );

          // Update the batch totals
          const newTotalKg = MoneyDecimal.max(0, toMoney(batch.totalWeightKg).minus(totalKgToReverse));
          const newTotalCost = MoneyDecimal.max(0, toMoney(batch.totalCost).minus(totalCostToReverse));
          // total_weight_kg holds 3 decimals, total_cost and cost_per_kg 7.
          const newCostPerKg = newTotalKg.gt(0) ? newTotalCost.div(newTotalKg) : ZERO;

          await tx
            .update(factoryMixBatches)
            .set({
              totalWeightKg: newTotalKg.toFixed(3),
              totalCost: newTotalCost.toFixed(7),
              costPerKg: newCostPerKg.toFixed(7),
              updatedAt: new Date(),
            })
            .where(eq(factoryMixBatches.id, batchId));
        });

        res.json({ success: true });
      } catch (error: unknown) {
        logger.error("Error deleting batch source:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  // DELETE a container raw stock receipt (only if no kg has been used yet)
  app.delete(
    "/api/factory/raw-stock/receipts/:rawStockId",
    requireAuth,
    validateRequest(deleteReceiptInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const rawStockId = parseId(req.params.rawStockId);

        if (rawStockId === null) return res.status(400).json({ message: "Invalid id" });
        if (isNaN(rawStockId)) return res.status(400).json({ message: "Invalid rawStockId" });

        const [row] = await db
          .select()
          .from(factoryRawStock)
          .where(and(eq(factoryRawStock.id, rawStockId), eq(factoryRawStock.companyId, companyId)))
          .limit(1);
        if (!row) return res.status(404).json({ message: "Raw stock record not found" });

        const usedKg = toMoney(row.usedKg);
        if (usedKg.gt("0.001")) {
          return res.status(400).json({
            message: `Cannot delete: ${usedKg.toFixed(3)} kg have already been used from this receipt in batches. Delete the batch sources first or edit the balance instead.`,
          });
        }

        await db.transaction(async (tx) => {
          // Soft-delete the raw stock record
          await tx
            .update(factoryRawStock)
            .set({ deletedAt: new Date() })
            .where(and(eq(factoryRawStock.id, rawStockId), eq(factoryRawStock.companyId, companyId)));
          // Wave 14: a commission held on this row leaves the ledger with it.
          if (toMoney(row.commissionAmount ?? 0).greaterThan(0)) {
            await syncContainerCommissionJournalTx(tx, companyId, row.containerId);
          }

          // Delete linked OFFLOAD_RAW_STOCK daybook entry
          await tx
            .delete(factoryDaybookEntries)
            .where(
              and(
                eq(factoryDaybookEntries.companyId, companyId),
                eq(factoryDaybookEntries.txType, "OFFLOAD_RAW_STOCK"),
                eq(factoryDaybookEntries.referenceId, rawStockId)
              )
            );
        });

        res.json({ success: true });
      } catch (error: unknown) {
        logger.error("Error deleting raw stock receipt:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  // PATCH update receivedKg on a container raw stock record (fixes balance going forward)
  app.patch(
    "/api/factory/raw-stock/receipts/:rawStockId",
    requireAuth,
    validateRequest(patchReceiptInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const rawStockId = parseId(req.params.rawStockId);

        if (rawStockId === null) return res.status(400).json({ message: "Invalid id" });
        if (isNaN(rawStockId)) return res.status(400).json({ message: "Invalid rawStockId" });

        const { receivedKg } = req.body;
        const newKg = parseMoneyInput(receivedKg);
        if (newKg === null || newKg.lt(0))
          return res.status(400).json({ message: "receivedKg must be a non-negative number" });

        const [row] = await db
          .select()
          .from(factoryRawStock)
          .where(and(eq(factoryRawStock.id, rawStockId), eq(factoryRawStock.companyId, companyId)))
          .limit(1);
        if (!row) return res.status(404).json({ message: "Raw stock record not found" });

        const usedKg = toMoney(row.usedKg);
        if (newKg.lt(usedKg.minus("0.001"))) {
          return res.status(400).json({
            message: `Cannot set receivedKg below already-used amount (${usedKg.toFixed(3)} kg used). Delete the batch sources first or set a higher value.`,
          });
        }

        await db
          .update(factoryRawStock)
          .set({ receivedKg: String(newKg.toNumber()) })
          .where(and(eq(factoryRawStock.id, rawStockId), eq(factoryRawStock.companyId, companyId)));

        res.json({ success: true });
      } catch (error: unknown) {
        logger.error("Error updating raw stock receipt:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  app.get("/api/factory/raw-stock/by-container", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const results = await db
        .select({
          id: factoryRawStock.id,
          companyId: factoryRawStock.companyId,
          containerId: factoryRawStock.containerId,
          receivedKg: factoryRawStock.receivedKg,
          usedKg: factoryRawStock.usedKg,
          costPerKg: factoryRawStock.costPerKg,
          costPerKgUsd: factoryRawStock.costPerKgUsd,
          offloadedAt: factoryRawStock.offloadedAt,
          createdAt: factoryRawStock.createdAt,
          containerNumber: factoryContainers.containerNumber,
          containerStatus: factoryContainers.status,
          supplierName: factorySuppliers.name,
          supplierId: factoryContainers.supplierId,
          origin: factoryContainers.origin,
        })
        .from(factoryRawStock)
        .innerJoin(factoryContainers, eq(factoryRawStock.containerId, factoryContainers.id))
        .leftJoin(factorySuppliers, eq(factoryContainers.supplierId, factorySuppliers.id))
        .where(
          and(
            eq(factoryRawStock.companyId, companyId),
            sql`${factoryContainers.status} != 'DELETED'`,
            isNull(factoryRawStock.deletedAt),
            isNull(factoryContainers.deletedAt)
          )
        );

      const enriched = results.map((r) => {
        const remainingKg = toMoney(r.receivedKg).minus(toMoney(r.usedKg));
        return { ...r, remainingKg: remainingKg.toFixed(3) };
      });

      res.json(enriched);
    } catch (error: unknown) {
      logger.error("Error fetching factory raw stock by container:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
