// Extracted from ./rawStockAdjRoutes.ts to keep that module under the source-size cap.
import { parseId } from "../../../lib/parseId";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import type { Express, Request, Response } from "express";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import {
  factoryContainers,
  factoryMixBatches,
  factoryMixBatchSources,
  factoryRawMaterialAdjustments,
  factoryRawStock,
  factorySuppliers,
} from "@shared/schema";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { MoneyDecimal, toMoney } from "../../../lib/money";

export const ZERO = new MoneyDecimal(0);

export function registerRawStockAdjRoutesPart1(app: Express) {
  app.get("/api/factory/raw-stock/adjustments", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const rows = await db
        .select({
          id: factoryRawMaterialAdjustments.id,
          companyId: factoryRawMaterialAdjustments.companyId,
          date: factoryRawMaterialAdjustments.date,
          type: factoryRawMaterialAdjustments.type,
          kg: factoryRawMaterialAdjustments.kg,
          costPerKg: factoryRawMaterialAdjustments.costPerKg,
          currencyCode: factoryRawMaterialAdjustments.currencyCode,
          supplierId: factoryRawMaterialAdjustments.supplierId,
          supplierName: factorySuppliers.name,
          materialLabel: factoryRawMaterialAdjustments.materialLabel,
          notes: factoryRawMaterialAdjustments.notes,
          createdAt: factoryRawMaterialAdjustments.createdAt,
        })
        .from(factoryRawMaterialAdjustments)
        .leftJoin(
          factorySuppliers,
          and(
            eq(factoryRawMaterialAdjustments.supplierId, factorySuppliers.id),
            eq(factorySuppliers.companyId, companyId)
          )
        )
        .where(
          and(eq(factoryRawMaterialAdjustments.companyId, companyId), isNull(factoryRawMaterialAdjustments.deletedAt))
        )
        .orderBy(desc(factoryRawMaterialAdjustments.createdAt));
      res.json(rows);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // GET combined history for a specific supplier's raw material
  // Returns adjustments + mix batch usage sorted newest-first
  app.get("/api/factory/raw-stock/history/:supplierId", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const supplierId = parseId(req.params.supplierId);
      if (supplierId === null) return res.status(400).json({ message: "Invalid id" });
      if (!supplierId) return res.status(400).json({ message: "supplierId required" });

      // 1. Manual adjustments for this supplier
      const adjRows = await db
        .select({
          id: factoryRawMaterialAdjustments.id,
          date: factoryRawMaterialAdjustments.date,
          type: factoryRawMaterialAdjustments.type,
          kg: factoryRawMaterialAdjustments.kg,
          costPerKg: factoryRawMaterialAdjustments.costPerKg,
          currencyCode: factoryRawMaterialAdjustments.currencyCode,
          notes: factoryRawMaterialAdjustments.notes,
          reference: factoryRawMaterialAdjustments.reference,
          materialLabel: factoryRawMaterialAdjustments.materialLabel,
          createdAt: factoryRawMaterialAdjustments.createdAt,
        })
        .from(factoryRawMaterialAdjustments)
        .where(
          and(
            eq(factoryRawMaterialAdjustments.companyId, companyId),
            eq(factoryRawMaterialAdjustments.supplierId, supplierId),
            isNull(factoryRawMaterialAdjustments.deletedAt)
          )
        )
        .orderBy(desc(factoryRawMaterialAdjustments.createdAt));

      // 2. Mix batch usage: batch sources referencing this supplier (aggregate per batch)
      //
      // IMPORTANT: costPerKg must come from factoryMixBatchSources (this supplier's own
      // rate for the material it contributed), NOT from factoryMixBatches.costPerKg.
      // The batch's costPerKg is a weighted BLEND across every supplier/source that fed
      // that batch — showing it here would silently attribute other suppliers' material
      // cost (or dilute this supplier's true cost) whenever a batch draws from more than
      // one source. Aggregating this supplier's own source rows (weight-averaged if a
      // batch drew from this supplier more than once) is the only correct per-supplier figure.
      const batchSourceRows = await db
        .select({
          batchId: factoryMixBatches.id,
          batchCode: factoryMixBatches.batchCode,
          batchName: factoryMixBatches.name,
          batchStatus: factoryMixBatches.status,
          batchDate: factoryMixBatches.batchDate,
          createdAt: factoryMixBatches.createdAt,
          weightKg: factoryMixBatchSources.weightKg,
          costPerKg: factoryMixBatchSources.costPerKg,
          totalCost: factoryMixBatchSources.totalCost,
        })
        .from(factoryMixBatchSources)
        .innerJoin(factoryMixBatches, eq(factoryMixBatchSources.mixBatchId, factoryMixBatches.id))
        .where(
          and(
            eq(factoryMixBatches.companyId, companyId),
            eq(factoryMixBatchSources.supplierId, supplierId),
            isNull(factoryMixBatches.deletedAt)
          )
        )
        .orderBy(desc(factoryMixBatches.createdAt));

      // Aggregate multiple source rows for the same batch into one timeline entry.
      // costPerKg is derived as totalCost / kg across THIS supplier's source rows only,
      // so a batch fed by this supplier more than once still shows one correct weighted rate.
      const batchAggMap = new Map();
      for (const r of batchSourceRows) {
        const kg = toMoney(r.weightKg);
        const storedCost = toMoney(r.totalCost);
        const cost = storedCost.isZero() ? kg.times(toMoney(r.costPerKg)) : storedCost;
        if (batchAggMap.has(r.batchId)) {
          const agg = batchAggMap.get(r.batchId);
          agg.kg = agg.kg.plus(kg);
          agg._cost = agg._cost.plus(cost);
        } else {
          batchAggMap.set(r.batchId, {
            kind: "batch" as const,
            date: r.batchDate || r.createdAt,
            createdAt: r.createdAt,
            type: "USED",
            kg,
            _cost: cost,
            currencyCode: "USD",
            notes: null,
            label: `Mix Batch — ${r.batchName || r.batchCode}`,
            ref: r.batchCode,
            batchStatus: r.batchStatus,
            batchId: r.batchId,
          });
        }
      }
      const batches = Array.from(batchAggMap.values()).map((r) => {
        const { _cost, kg, ...rest } = r;
        return { ...rest, kg: kg.toNumber(), costPerKg: kg.gt(0) ? _cost.div(kg).toNumber() : 0 };
      });

      // 3. Container-based raw stock receipts for this supplier
      const containerRows = await db
        .select({
          id: factoryRawStock.id,
          receivedKg: factoryRawStock.receivedKg,
          usedKg: factoryRawStock.usedKg,
          // costPerKgUsd is computed at offload time as totalCost / actualReceivedKg,
          // so it correctly reflects the reduced received quantity. costPerKg is the
          // declared container rate (based on full expected weight) and would be too low
          // when fewer kg were received.
          costPerKgUsd: factoryRawStock.costPerKgUsd,
          costPerKg: factoryRawStock.costPerKg,
          offloadedAt: factoryRawStock.offloadedAt,
          containerNumber: factoryContainers.containerNumber,
          origin: factoryContainers.origin,
          currencyCode: factoryContainers.currencyCode,
        })
        .from(factoryRawStock)
        .innerJoin(factoryContainers, eq(factoryRawStock.containerId, factoryContainers.id))
        .where(
          and(
            eq(factoryRawStock.companyId, companyId),
            eq(factoryContainers.supplierId, supplierId),
            sql`${factoryContainers.status} != 'DELETED'`
          )
        )
        .orderBy(desc(factoryRawStock.offloadedAt));

      const receipts = containerRows.map((r) => ({
        kind: "receipt" as const,
        date: r.offloadedAt,
        createdAt: r.offloadedAt,
        type: "RECEIPT",
        kg: toMoney(r.receivedKg).toNumber(),
        usedKg: toMoney(r.usedKg).toNumber(),
        rawStockId: r.id,
        // Prefer the USD rate (computed from actual received kg at offload time);
        // fall back to the native rate only if costPerKgUsd is absent (legacy rows).
        costPerKg: (toMoney(r.costPerKgUsd).isZero() ? toMoney(r.costPerKg) : toMoney(r.costPerKgUsd)).toNumber(),
        currencyCode: "USD",
        notes: r.origin ? `Origin: ${r.origin}` : null,
        label: `Container Receipt — ${r.containerNumber || `#${r.id}`}`,
        ref: r.containerNumber || `CONTAINER-${r.id}`,
        batchStatus: null,
        batchId: null,
      }));

      // Also expose adjId on adjustments
      const adjustmentsWithId = adjRows.map((r) => ({
        kind: "adjustment" as const,
        adjId: r.id,
        date: r.date || r.createdAt,
        createdAt: r.createdAt,
        type: r.type,
        kg: toMoney(r.kg).toNumber(),
        costPerKg: toMoney(r.costPerKg).toNumber(),
        currencyCode: r.currencyCode || "USD",
        notes: r.notes,
        reference: r.reference || null,
        label: r.type === "ADD" ? "Manual Addition" : r.type === "DEDUCT" ? "Deduct from Received" : "Manual Deduction",
        ref: r.reference ? r.reference : `ADJ-${r.id}`,
      }));

      const all = [...adjustmentsWithId, ...batches, ...receipts].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );

      res.json(all);
    } catch (error: unknown) {
      logger.error("Raw material history error:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
