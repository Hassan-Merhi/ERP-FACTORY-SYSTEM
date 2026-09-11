import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { getClientDate } from "../../../lib/dateUtils";
import type { Express, Request, Response } from "express";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { getLockedSupplierRate } from "../../../services/factory/rawStockLockedRate";
import { writeDaybookEntry, getOrFetchFxRateToUsd } from "../_helpers";
import {
  factorySuppliers,
  factoryContainers,
  factoryRawStock,
  factoryMixBatches,
  factoryMixBatchSources,
  factoryBales,
  factoryRawMaterialAdjustments,
  factorySupplierCategories,
} from "@shared/schema";
import { eq, and, desc, sql, isNull } from "drizzle-orm";

export function registerRawStockReceiptRoutes(app: Express) {
  app.get("/api/factory/raw-stock", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      // Pre-fetch all suppliers with their category info for this company
      const supplierRows = await db
        .select({
          id: factorySuppliers.id,
          supplierCategoryId: factorySuppliers.supplierCategoryId,
          categoryName: factorySupplierCategories.name,
          currentRawMaterialCostPerKgUsd: factorySuppliers.currentRawMaterialCostPerKgUsd,
        })
        .from(factorySuppliers)
        .leftJoin(factorySupplierCategories, eq(factorySuppliers.supplierCategoryId, factorySupplierCategories.id))
        .where(eq(factorySuppliers.companyId, companyId));
      const supplierCategoryMap = new Map<number, { categoryId: number | null; categoryName: string | null }>();
      // Authoritative locked rate (USD) per supplier — the single source of truth for
      // display everywhere. Never recomputed here from receipt history. For a supplier
      // whose locked rate has never been established (persisted column still NULL — e.g.
      // pre-dates the migration/backfill, or its container rows were seeded directly
      // rather than through a real offload), fall through to the SAME one-time lazy
      // derive-and-persist helper every other read path uses, so this endpoint can never
      // disagree with getLockedSupplierRate (used by the offload/mix-batch/diagnostic
      // code) about what a supplier's rate is.
      const supplierLockedRateMap = new Map<number, number>();
      for (const s of supplierRows) {
        supplierCategoryMap.set(s.id, {
          categoryId: s.supplierCategoryId ?? null,
          categoryName: s.categoryName ?? null,
        });
        const persisted = s.currentRawMaterialCostPerKgUsd;
        if (persisted !== null && persisted !== undefined) {
          supplierLockedRateMap.set(s.id, parseFloat(persisted as string) || 0);
        } else {
          try {
            supplierLockedRateMap.set(s.id, await getLockedSupplierRate(db, companyId, s.id));
          } catch (rateErr: unknown) {
            logger.error(`[raw-stock] getLockedSupplierRate failed for supplier ${s.id}:`, {
              error: getErrorMessage(rateErr),
            });
            supplierLockedRateMap.set(s.id, 0);
          }
        }
      }

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
          supplierId: factoryContainers.supplierId,
          supplierName: factorySuppliers.name,
          origin: factoryContainers.origin,
          containerStatus: factoryContainers.status,
          currencyCode: factoryContainers.currencyCode,
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

      const supplierMap = new Map();
      for (const r of results) {
        const isOB = r.containerStatus === "OPENING_BALANCE";
        // Always merge by supplier — one row per supplier regardless of OB vs Container
        const key = r.supplierId ? `supplier-${r.supplierId}` : r.supplierName || `unknown-${r.containerId}`;
        const received = parseFloat(r.receivedKg as string) || 0;
        const used = parseFloat(r.usedKg as string) || 0;
        const costPerKg = parseFloat(r.costPerKg as string) || 0;

        const costPerKgUsd = parseFloat(r.costPerKgUsd as string) || costPerKg;
        // Each raw-stock row is one specific container/source with its own cost/kg and its
        // own usedKg (usage is already attributed to the exact container it was drawn from
        // via factoryMixBatchSources). The remaining VALUE of this row is therefore
        // (received - used) * this row's own cost/kg — never a blended average of every
        // container's received cost re-applied across the supplier's total remaining kg.
        // Averaging received cost first and multiplying by remaining kg afterwards silently
        // misattributes the cost of whatever was actually used to every other container in
        // the blend, inflating (or deflating) the remaining stock value.
        const rowRemainingKg = received - used;
        const rowRemainingValueLocal = rowRemainingKg * costPerKg;
        const rowRemainingValueUsd = rowRemainingKg * costPerKgUsd;
        // The displayed "rate" (cost/kg) is a separate concept from remaining value: it's
        // the going purchase rate for this supplier's material, weighted by everything ever
        // RECEIVED. It should only move when a new container/receipt is added, never when
        // existing stock is consumed in a mix batch — so it's tracked independently of usage.
        if (supplierMap.has(key)) {
          const existing = supplierMap.get(key)!;
          const prevTotalCost = existing._totalReceived * existing._avgCostPerKg;
          const newTotalCost = received * costPerKg;
          const prevTotalCostUsd = existing._totalReceived * existing._avgCostPerKgUsd;
          const newTotalCostUsd = received * costPerKgUsd;
          existing._totalReceived += received;
          existing._totalUsed += used;
          existing._avgCostPerKg =
            existing._totalReceived > 0 ? (prevTotalCost + newTotalCost) / existing._totalReceived : 0;
          existing._avgCostPerKgUsd =
            existing._totalReceived > 0 ? (prevTotalCostUsd + newTotalCostUsd) / existing._totalReceived : 0;
          existing._remainingValueLocal += rowRemainingValueLocal;
          existing._remainingValueUsd += rowRemainingValueUsd;
          if (new Date(r.offloadedAt) > new Date(existing.lastOffloaded)) {
            existing.lastOffloaded = r.offloadedAt;
          }
          // If any container for this supplier is not OB, show as Container
          if (!isOB) existing.sourceType = "CONTAINER";
        } else {
          const catInfo = r.supplierId
            ? supplierCategoryMap.get(r.supplierId) || { categoryId: null, categoryName: null }
            : { categoryId: null, categoryName: null };
          supplierMap.set(key, {
            supplierName: r.supplierName || "Unknown",
            supplierId: r.supplierId,
            categoryId: catInfo.categoryId,
            categoryName: catInfo.categoryName,
            sourceType: isOB ? "OPENING_BALANCE" : "CONTAINER",
            currencyCode: r.currencyCode || "USD",
            _totalReceived: received,
            _totalUsed: used,
            _avgCostPerKg: costPerKg,
            _avgCostPerKgUsd: costPerKgUsd,
            _remainingValueLocal: rowRemainingValueLocal,
            _remainingValueUsd: rowRemainingValueUsd,
            lastOffloaded: r.offloadedAt,
          });
        }
      }

      // Fetch manual adjustments and merge into supplierMap
      const adjustments = await db
        .select()
        .from(factoryRawMaterialAdjustments)
        .where(
          and(eq(factoryRawMaterialAdjustments.companyId, companyId), isNull(factoryRawMaterialAdjustments.deletedAt))
        );

      for (const adj of adjustments) {
        if (adj.type === "DEDUCT") continue; // DEDUCT is history-only; receivedKg on rows already reduced
        const kg = parseFloat(adj.kg as string) || 0;
        const costPerKgAdj = parseFloat(adj.costPerKg as string) || 0;
        const isAdd = adj.type === "ADD";
        let key: string;
        let supplierName: string;
        let supplierId: number | null = null;
        if (adj.supplierId) {
          supplierId = adj.supplierId;
          // Use the same unified supplier key (matches container key generation above)
          key = `supplier-${adj.supplierId}`;
          const anyEntry = supplierMap.get(key);
          if (anyEntry) {
            supplierName = anyEntry.supplierName;
          } else {
            const [sup] = await db
              .select({ name: factorySuppliers.name })
              .from(factorySuppliers)
              .where(and(eq(factorySuppliers.id, adj.supplierId), eq(factorySuppliers.companyId, companyId)))
              .limit(1);
            supplierName = sup?.name || `Supplier #${adj.supplierId}`;
          }
        } else {
          // Standalone manual material (no supplier)
          supplierName = adj.materialLabel || "Manual Stock";
          key = `MANUAL__${supplierName}`;
        }

        if (supplierMap.has(key)) {
          const existing = supplierMap.get(key)!;
          if (isAdd) {
            // ADD is a quantity-only movement — for a REAL supplier its cost is already
            // forced server-side to equal the locked rate (see rawStockAdjRoutes.ts), so
            // it must never shift the displayed rate here; only the received-kg pool
            // grows (feeds freeKg). Value is derived later from freeKg × locked rate for
            // real suppliers. Standalone MANUAL materials (no supplierId) aren't tied to
            // a locked rate, so they keep their own blended-average tracking.
            existing._totalReceived += kg;
            if (!supplierId) {
              const prevCost = (existing._totalReceived - kg) * existing._avgCostPerKg;
              const newCost = kg * costPerKgAdj;
              existing._avgCostPerKg = existing._totalReceived > 0 ? (prevCost + newCost) / existing._totalReceived : 0;
              existing._avgCostPerKgUsd = existing._avgCostPerKg;
              existing._remainingValueLocal += kg * costPerKgAdj;
              existing._remainingValueUsd += kg * costPerKgAdj;
            }
          } else {
            // Manual usage isn't tied to a specific container/source, so it draws down
            // the supplier's remaining stock at that stock's current blended cost/kg —
            // the best available attribution without a specific source reference.
            const remainingKgBefore = existing._totalReceived - existing._totalUsed;
            const avgCostBefore = remainingKgBefore > 0 ? existing._remainingValueUsd / remainingKgBefore : 0;
            const avgCostLocalBefore = remainingKgBefore > 0 ? existing._remainingValueLocal / remainingKgBefore : 0;
            existing._totalUsed += kg;
            existing._remainingValueUsd -= kg * avgCostBefore;
            existing._remainingValueLocal -= kg * avgCostLocalBefore;
          }
        } else {
          const adjCatInfo = supplierId
            ? supplierCategoryMap.get(supplierId) || { categoryId: null, categoryName: null }
            : { categoryId: null, categoryName: null };
          supplierMap.set(key, {
            supplierName,
            supplierId,
            categoryId: adjCatInfo.categoryId,
            categoryName: adjCatInfo.categoryName,
            sourceType: "MANUAL",
            currencyCode: adj.currencyCode || "USD",
            _totalReceived: isAdd ? kg : 0,
            _totalUsed: isAdd ? 0 : kg,
            _avgCostPerKg: costPerKgAdj,
            _avgCostPerKgUsd: costPerKgAdj,
            _remainingValueLocal: isAdd ? kg * costPerKgAdj : 0,
            _remainingValueUsd: isAdd ? kg * costPerKgAdj : 0,
            lastOffloaded: adj.createdAt,
            _adjustmentIds: [adj.id],
          });
        }

        // Track adjustment IDs on existing MANUAL entries too
        if (supplierMap.has(key)) {
          const entry = supplierMap.get(key)!;
          if (entry.sourceType === "MANUAL") {
            entry._adjustmentIds = entry._adjustmentIds || [];
            if (!entry._adjustmentIds.includes(adj.id)) entry._adjustmentIds.push(adj.id);
          }
        }
      }

      const reservedRows = await db
        .select({
          supplierId: factoryMixBatchSources.supplierId,
          reservedKg: sql<string>`SUM(${factoryMixBatchSources.weightKg})`,
        })
        .from(factoryMixBatchSources)
        .innerJoin(factoryMixBatches, eq(factoryMixBatchSources.mixBatchId, factoryMixBatches.id))
        .where(
          and(
            eq(factoryMixBatches.companyId, companyId),
            sql`${factoryMixBatchSources.supplierId} IS NOT NULL`,
            sql`${factoryMixBatches.status} NOT IN ('CLOSED', 'COMPLETED')`,
            isNull(factoryMixBatches.deletedAt)
          )
        )
        .groupBy(factoryMixBatchSources.supplierId);

      // Consumed value per supplier — the sum of what each mix-batch source was ACTUALLY
      // recorded at when it was created/edited (already the supplier's locked rate at
      // that moment, per the fixes above), across every batch regardless of status. This
      // is the only correct "Total Used Value": a single global blended mix-batch rate
      // multiplied by total used kg is unreliable once suppliers/batches have different
      // rates, since it attributes every kg to a rate it may never have actually cost.
      // Exclude soft-deleted/reversed batches — once a batch is deleted its sources no
      // longer contribute to "used" stock, so they must not still count toward Total
      // Used Value (the corresponding usedKg was already restored by the delete route).
      const usedValueRows = await db
        .select({
          supplierId: factoryMixBatchSources.supplierId,
          usedValueUsd: sql<string>`SUM(${factoryMixBatchSources.totalCost})`,
        })
        .from(factoryMixBatchSources)
        .innerJoin(factoryMixBatches, eq(factoryMixBatchSources.mixBatchId, factoryMixBatches.id))
        .where(
          and(
            eq(factoryMixBatches.companyId, companyId),
            sql`${factoryMixBatchSources.supplierId} IS NOT NULL`,
            isNull(factoryMixBatches.deletedAt)
          )
        )
        .groupBy(factoryMixBatchSources.supplierId);
      const usedValueBySupplierId = new Map<number, number>();
      for (const r of usedValueRows) {
        if (r.supplierId) usedValueBySupplierId.set(r.supplierId, parseFloat(r.usedValueUsd as string) || 0);
      }

      const reservedBySupplierId = new Map<number, number>();
      for (const r of reservedRows) {
        if (r.supplierId) reservedBySupplierId.set(r.supplierId, parseFloat(r.reservedKg as string) || 0);
      }

      // Track which supplierIds have actual container raw stock records (those already
      // have usedKg properly maintained on the factoryRawStock rows).
      const supplierIdsWithContainerStock = new Set<number>(
        results.filter((r) => r.supplierId).map((r) => r.supplierId as number)
      );

      // For MANUAL-only suppliers (no factoryRawStock container records), usedKg is never
      // incremented on any DB row when a batch is completed. We must count kg from ALL
      // COMPLETED/CLOSED batch sources for those suppliers.
      // NOTE: do NOT filter by containerId here — a manual-supplier batch source may still
      // store a containerId value even though the supplier has no container stock rows.
      // We rely on supplierIdsWithContainerStock to skip suppliers already tracked.
      const completedBatchRows = await db
        .select({
          supplierId: factoryMixBatchSources.supplierId,
          consumedKg: sql<string>`SUM(${factoryMixBatchSources.weightKg})`,
        })
        .from(factoryMixBatchSources)
        .innerJoin(factoryMixBatches, eq(factoryMixBatchSources.mixBatchId, factoryMixBatches.id))
        .where(
          and(
            eq(factoryMixBatches.companyId, companyId),
            sql`${factoryMixBatchSources.supplierId} IS NOT NULL`,
            sql`${factoryMixBatches.status} IN ('CLOSED', 'COMPLETED')`
          )
        )
        .groupBy(factoryMixBatchSources.supplierId);

      // Apply completed-batch consumption to MANUAL-only suppliers only
      for (const r of completedBatchRows) {
        if (!r.supplierId) continue;
        if (supplierIdsWithContainerStock.has(r.supplierId)) continue; // container stock handles it
        const consumed = parseFloat(r.consumedKg as string) || 0;
        const key = `supplier-${r.supplierId}`;
        if (supplierMap.has(key)) {
          const existing = supplierMap.get(key)!;
          const remainingKgBefore = existing._totalReceived - existing._totalUsed;
          const avgCostBefore = remainingKgBefore > 0 ? existing._remainingValueUsd / remainingKgBefore : 0;
          const avgCostLocalBefore = remainingKgBefore > 0 ? existing._remainingValueLocal / remainingKgBefore : 0;
          existing._totalUsed += consumed;
          existing._remainingValueUsd -= consumed * avgCostBefore;
          existing._remainingValueLocal -= consumed * avgCostLocalBefore;
        }
      }

      // Build aggregated rows (reservedKg / freeKg will be fixed below for multi-row suppliers)
      const aggregated = Array.from(supplierMap.values()).map((s) => {
        const remainingKg = s._totalReceived - s._totalUsed;
        // For a REAL supplier, the displayed rate is ALWAYS the persisted locked rate —
        // never a recomputed receipt-weighted or remaining-value-derived figure. Only
        // an actual offload / opening balance / explicit correction can move it.
        // Standalone MANUAL materials (no supplierId) have no locked rate to read, so
        // they keep their own tracked blended-average cost.
        const lockedRateUsd = s.supplierId ? (supplierLockedRateMap.get(s.supplierId) ?? 0) : null;
        const avgCostPerKg = lockedRateUsd !== null ? lockedRateUsd : s._avgCostPerKg;
        const avgCostPerKgUsd = lockedRateUsd !== null ? lockedRateUsd : s._avgCostPerKgUsd;
        return {
          supplierName: s.supplierName,
          supplierId: s.supplierId,
          categoryId: s.categoryId ?? null,
          categoryName: s.categoryName ?? null,
          sourceType: s.sourceType,
          currencyCode: s.currencyCode,
          receivedKg: s._totalReceived.toFixed(3),
          usedKg: s._totalUsed.toFixed(3),
          remainingKg: remainingKg.toFixed(3),
          reservedKg: "0.000",
          freeKg: "0.000",
          costPerKg: avgCostPerKg.toFixed(6),
          costPerKgUsd: avgCostPerKgUsd.toFixed(6),
          // Value is set below, AFTER freeKg is computed: for real suppliers it's
          // freeKg × locked rate (spec-mandated formula); MANUAL materials keep the
          // tracked remaining cost basis since they have no locked rate.
          valueRemaining: (lockedRateUsd !== null ? 0 : s._remainingValueLocal).toFixed(2),
          valueRemainingUsd: (lockedRateUsd !== null ? 0 : s._remainingValueUsd).toFixed(2),
          _isLockedRateSupplier: lockedRateUsd !== null,
          _lockedRateUsd: lockedRateUsd,
          lastOffloaded: s.lastOffloaded,
          adjustmentIds: s._adjustmentIds || [],
        };
      });

      // Distribute reserved kg across rows for the same supplier proportionally.
      // A supplier may have multiple rows (e.g. OPENING_BALANCE + MANUAL) — the total
      // reserved amount is shared across those rows so free kg remains correct.
      const rowsBySupplierId = new Map<number, typeof aggregated>();
      for (const row of aggregated) {
        if (row.supplierId) {
          if (!rowsBySupplierId.has(row.supplierId)) rowsBySupplierId.set(row.supplierId, []);
          rowsBySupplierId.get(row.supplierId)!.push(row);
        }
      }
      for (const [suppId, rows] of rowsBySupplierId) {
        // Model A: creating/editing/topping-up a mix batch already increments
        // factoryRawStock.usedKg (and factoryMixBatches.usedKg) via FIFO at the moment
        // the batch is created — see factoryMixBatchRoutes.ts. That consumption is
        // therefore already reflected in remainingKg (received - used) above.
        // reservedKg (active, non-CLOSED/COMPLETED batch source weight) is purely
        // informational here — showing how much of the already-deducted usedKg is
        // still "in an open batch" versus fully consumed — and must NOT be subtracted
        // again from freeKg, or the same kilograms are deducted twice.
        const reserved = reservedBySupplierId.get(suppId) || 0;
        const totalRemaining = rows.reduce((sum, r) => sum + parseFloat(r.remainingKg), 0);
        if (rows.length === 1) {
          rows[0].reservedKg = reserved.toFixed(3);
          rows[0].freeKg = totalRemaining.toFixed(3);
        } else {
          // Proportional distribution across multiple rows
          for (const row of rows) {
            const rem = parseFloat(row.remainingKg);
            const proportion = totalRemaining > 0 ? rem / totalRemaining : 0;
            row.reservedKg = (reserved * proportion).toFixed(3);
            row.freeKg = rem.toFixed(3);
          }
        }
      }

      // Spec-mandated formula for suppliers with a locked rate: displayed value is
      // ALWAYS freeKg × lockedRateUsd, computed only now that freeKg is final —
      // never remaining-value-basis or received-weighted derivations. This keeps
      // the Raw Materials table, category totals, KPIs, and the mix-batch dialog
      // (which reads this same endpoint) numerically consistent by construction.
      const responseRows = aggregated.map((row) => {
        const freeKg = parseFloat(row.freeKg) || 0;
        const lockedValue = (freeKg * (row._lockedRateUsd || 0)).toFixed(2);
        // Total consumed value at each source's own recorded (locked-at-creation) rate —
        // NOT a blended-rate × total-used-kg guess. See usedValueRows above.
        const usedValueUsd = (row.supplierId ? usedValueBySupplierId.get(row.supplierId) || 0 : 0).toFixed(2);
        const { _isLockedRateSupplier: _locked, _lockedRateUsd: _rate, ...rest } = row;
        return {
          ...rest,
          valueRemaining: _locked ? lockedValue : row.valueRemaining,
          valueRemainingUsd: _locked ? lockedValue : row.valueRemainingUsd,
          usedValueUsd,
        };
      });

      res.json(responseRows);
    } catch (error: unknown) {
      logger.error("Error fetching factory raw stock:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // POST update cost per kg for a supplier — the explicit, user-authorized landed-cost
  // correction path (selected deliberately via the "Update Cost per KG" adjustment type,
  // never the default ADD/REMOVE quantity adjustments). Because this sets ONE uniform
  // new cost across every one of the supplier's raw-stock rows, the supplier's locked
  // rate afterward is simply that new cost — no historical-received-kg recompute is
  // needed or allowed. The cascade to mix-batch sources/batches/bales is scoped to
  // OPEN batches only (ACTIVE/OPEN/CARRY_FORWARD) — completed/closed batches and their
  // bales already have finalized costing and must not be silently rewritten.
  app.post("/api/factory/raw-stock/update-cost", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { supplierId, newCostPerKg } = req.body;
      if (!supplierId) return res.status(400).json({ message: "supplierId is required" });
      const newCost = parseFloat(newCostPerKg);
      if (isNaN(newCost) || newCost < 0)
        return res.status(400).json({ message: "newCostPerKg must be a non-negative number" });

      await db.transaction(async (tx) => {
        // 1. Update costPerKg on all factory_raw_stock rows for this supplier
        const rawStockRows = await tx
          .select({ id: factoryRawStock.id })
          .from(factoryRawStock)
          .innerJoin(factoryContainers, eq(factoryRawStock.containerId, factoryContainers.id))
          .where(
            and(
              eq(factoryRawStock.companyId, companyId),
              eq(factoryContainers.supplierId, Number(supplierId)),
              sql`${factoryContainers.status} != 'DELETED'`
            )
          );

        for (const row of rawStockRows) {
          await tx
            .update(factoryRawStock)
            .set({ costPerKg: String(newCost), costPerKgUsd: String(newCost) })
            .where(eq(factoryRawStock.id, row.id));
        }

        // 1a. Every raw-stock row for this supplier now shares the same corrected cost,
        // so the locked rate is simply that new cost — an atomic, direct set (not a
        // recompute from all-time received kg, which would reintroduce consumed stock).
        await tx
          .update(factorySuppliers)
          .set({ currentRawMaterialCostPerKgUsd: String(newCost), updatedAt: new Date() })
          .where(and(eq(factorySuppliers.id, Number(supplierId)), eq(factorySuppliers.companyId, companyId)));

        // 1b. Also update ADD adjustments for this supplier so the weighted avg isn't pulled back
        await tx
          .update(factoryRawMaterialAdjustments)
          .set({ costPerKg: String(newCost) })
          .where(
            and(
              eq(factoryRawMaterialAdjustments.companyId, companyId),
              eq(factoryRawMaterialAdjustments.supplierId, Number(supplierId)),
              eq(factoryRawMaterialAdjustments.type, "ADD")
            )
          );

        // 2. Update costPerKg + totalCost on factory_mix_batch_sources for this supplier —
        // ONLY for batches still OPEN. Completed/closed batches keep their finalized
        // historical cost; this correction must not silently rewrite them.
        const batchSources = await tx
          .select({
            id: factoryMixBatchSources.id,
            mixBatchId: factoryMixBatchSources.mixBatchId,
            weightKg: factoryMixBatchSources.weightKg,
          })
          .from(factoryMixBatchSources)
          .innerJoin(factoryMixBatches, eq(factoryMixBatchSources.mixBatchId, factoryMixBatches.id))
          .where(
            and(
              eq(factoryMixBatchSources.supplierId, Number(supplierId)),
              eq(factoryMixBatches.companyId, companyId),
              sql`${factoryMixBatches.status} IN ('ACTIVE', 'OPEN', 'CARRY_FORWARD')`
            )
          );

        const affectedBatchIds = new Set<number>();
        for (const src of batchSources) {
          const wt = parseFloat(src.weightKg as string) || 0;
          await tx
            .update(factoryMixBatchSources)
            .set({
              costPerKg: String(newCost),
              totalCost: String((wt * newCost).toFixed(2)),
            })
            .where(eq(factoryMixBatchSources.id, src.id));
          affectedBatchIds.add(src.mixBatchId);
        }

        // 3. Recalculate blended cost for each affected (still-open) mix batch
        for (const batchId of affectedBatchIds) {
          const allSources = await tx
            .select({
              weightKg: factoryMixBatchSources.weightKg,
              costPerKg: factoryMixBatchSources.costPerKg,
            })
            .from(factoryMixBatchSources)
            .where(eq(factoryMixBatchSources.mixBatchId, batchId));

          const totalWt = allSources.reduce((s, r) => s + (parseFloat(r.weightKg as string) || 0), 0);
          const totalCostSum = allSources.reduce((s, r) => {
            const wt = parseFloat(r.weightKg as string) || 0;
            const c = parseFloat(r.costPerKg as string) || 0;
            return s + wt * c;
          }, 0);
          const blendedCost = totalWt > 0 ? totalCostSum / totalWt : 0;

          await tx
            .update(factoryMixBatches)
            .set({
              costPerKg: String(blendedCost.toFixed(4)),
              totalCost: String(totalCostSum.toFixed(2)),
              updatedAt: new Date(),
            })
            .where(and(eq(factoryMixBatches.id, batchId), eq(factoryMixBatches.companyId, companyId)));

          // 4. Update costPerKg + totalCost on all bales belonging to this batch
          const balesInBatch = await tx
            .select({ id: factoryBales.id, weightKg: factoryBales.weightKg })
            .from(factoryBales)
            .where(
              and(
                eq(factoryBales.mixBatchId, batchId),
                eq(factoryBales.companyId, companyId),
                sql`${factoryBales.status} NOT IN ('DELETED','REMOVED')`
              )
            );

          for (const bale of balesInBatch) {
            const baleWt = parseFloat(bale.weightKg as string) || 0;
            await tx
              .update(factoryBales)
              .set({
                costPerKg: String(blendedCost.toFixed(2)),
                totalCost: String((baleWt * blendedCost).toFixed(2)),
                updatedAt: new Date(),
              })
              .where(eq(factoryBales.id, bale.id));
          }
        }
      });

      res.json({ success: true, message: "Cost updated and cascaded to mix batches and bales" });
    } catch (error: unknown) {
      logger.error("Error updating raw stock cost:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // POST deduct from received_kg directly on factory_raw_stock rows for a supplier
  app.post("/api/factory/raw-stock/deduct-received", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { supplierId, kg, notes, reference, costPerKg, currencyCode, txDate } = req.body;
      if (!supplierId) return res.status(400).json({ message: "supplierId is required" });
      if (!kg || parseFloat(kg) <= 0) return res.status(400).json({ message: "kg must be > 0" });

      const deductKg = parseFloat(kg);
      const costPerKgNum = costPerKg ? parseFloat(costPerKg) : 0;
      const ccy = currencyCode || "USD";
      const today = txDate || getClientDate(req);

      // Find all raw_stock rows for this supplier, ordered newest first
      const rows = await db
        .select({
          id: factoryRawStock.id,
          receivedKg: factoryRawStock.receivedKg,
          usedKg: factoryRawStock.usedKg,
        })
        .from(factoryRawStock)
        .innerJoin(factoryContainers, eq(factoryRawStock.containerId, factoryContainers.id))
        .where(
          and(
            eq(factoryRawStock.companyId, companyId),
            eq(factoryContainers.supplierId, Number(supplierId)),
            sql`${factoryContainers.status} != 'DELETED'`
          )
        )
        .orderBy(desc(factoryRawStock.offloadedAt));

      // Free kg from actual rows
      const totalFreeFromRows = rows.reduce(
        (sum, r) => sum + Math.max(0, parseFloat(r.receivedKg as string) - parseFloat(r.usedKg as string)),
        0
      );

      // Free kg from ADD/REMOVE adjustments for this supplier
      const adjRows = await db
        .select({ type: factoryRawMaterialAdjustments.type, kg: factoryRawMaterialAdjustments.kg })
        .from(factoryRawMaterialAdjustments)
        .where(
          and(
            eq(factoryRawMaterialAdjustments.companyId, companyId),
            eq(factoryRawMaterialAdjustments.supplierId, Number(supplierId))
          )
        );
      const adjFree = adjRows.reduce((sum, a) => {
        if (a.type === "DEDUCT") return sum; // DEDUCT is history-only; receivedKg on rows already reduced
        const k = parseFloat(a.kg as string) || 0;
        return a.type === "ADD" ? sum + k : sum - k;
      }, 0);

      const _totalFree = totalFreeFromRows + Math.max(0, adjFree);

      // Allow over-use: no guard here — deduction can drive remaining stock negative

      // Deduct from rows newest-first; allow received to go below used (negative stock)
      let remaining = deductKg;
      const updates: { id: number; newReceived: number }[] = [];
      for (const row of rows) {
        if (remaining <= 0) break;
        const received = parseFloat(row.receivedKg as string);
        // Allow over-use: deduct from received up to its full amount (may leave usedKg > receivedKg)
        const take = Math.min(remaining, received);
        if (take > 0) {
          updates.push({ id: row.id, newReceived: received - take });
          remaining -= take;
        }
      }

      // Any remaining kg after row deductions → create a REMOVE adjustment
      const adjDeductKg = remaining > 0.001 ? remaining : 0;

      let fxRate = 1;
      if (ccy !== "USD" && costPerKgNum > 0) {
        try {
          fxRate = parseFloat(await getOrFetchFxRateToUsd(companyId, ccy, today));
        } catch {
          fxRate = 1;
        }
      }

      await db.transaction(async (tx) => {
        // 1. Update actual rows
        for (const u of updates) {
          await tx
            .update(factoryRawStock)
            .set({ receivedKg: String(u.newReceived.toFixed(3)) })
            .where(eq(factoryRawStock.id, u.id));
        }

        // 1b. Record a DEDUCT history entry for the amount taken from container rows
        // DEDUCT type is skipped in all balance calculations — it only exists for history visibility.
        const rowDeductKg = deductKg - adjDeductKg;
        if (rowDeductKg > 0.001) {
          await tx.insert(factoryRawMaterialAdjustments).values({
            companyId,
            date: today,
            type: "DEDUCT",
            kg: rowDeductKg.toFixed(3),
            costPerKg: costPerKgNum > 0 ? String(costPerKgNum) : "0",
            currencyCode: ccy,
            supplierId: Number(supplierId),
            notes: notes || null,
            reference: reference || null,
          });
        }

        // 2. REMOVE adjustment for any overflow (from adjustment-sourced free)
        let _insertedAdj = null;
        if (adjDeductKg > 0) {
          [_insertedAdj] = await tx
            .insert(factoryRawMaterialAdjustments)
            .values({
              companyId,
              date: today,
              type: "REMOVE",
              kg: adjDeductKg.toFixed(3),
              costPerKg: costPerKgNum > 0 ? String(costPerKgNum) : "0",
              currencyCode: ccy,
              supplierId: Number(supplierId),
              notes: notes ? `${notes} (auto-adj)` : "Deduct from received (auto-adj)",
              reference: reference || null,
            })
            .returning();
        }

        // 3. Write daybook entry for the balance update (if costPerKg provided)
        if (costPerKgNum > 0) {
          const totalValue = deductKg * costPerKgNum;
          const totalValueUsd = totalValue * fxRate;

          const [sup] = await tx
            .select({ name: factorySuppliers.name })
            .from(factorySuppliers)
            .where(and(eq(factorySuppliers.id, Number(supplierId)), eq(factorySuppliers.companyId, companyId)))
            .limit(1);
          const supplierName = sup?.name || `Supplier #${supplierId}`;

          await writeDaybookEntry(tx, {
            companyId,
            txDate: today,
            txType: "RAW_DEDUCT_RECEIVED",
            referenceId: Number(supplierId),
            description: `Deduct from received: ${deductKg} kg @ ${costPerKgNum} ${ccy} — ${supplierName}${notes ? ` (${notes})` : ""}`,
            currencyCode: ccy,
            amountCurrency: -totalValue,
            fxRateToUsd: fxRate,
            amountUsd: -totalValueUsd,
          });
        }
      });

      res.json({ deducted: deductKg, rowsUpdated: updates.length, adjCreated: adjDeductKg > 0 });
    } catch (error: unknown) {
      logger.error("Error deducting received kg:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
