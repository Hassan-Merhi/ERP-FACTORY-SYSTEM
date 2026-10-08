import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { withFactoryValuationEventTx } from "../../../services/factory/factoryStockValueEvents";
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
import type Decimal from "decimal.js";
import { MoneyDecimal, parseMoneyInput, sumMoney, toMoney } from "../../../lib/money";

const ZERO = new MoneyDecimal(0);
/** A stored amount, or zero when it is missing or not a number. */
const amountOrZero = (value: unknown) => toMoney(value as string | null);

type SupplierStock = {
  supplierName: string;
  supplierId: number | null;
  categoryId: number | null;
  categoryName: string | null;
  sourceType: string;
  currencyCode: string;
  _totalReceived: Decimal;
  _totalUsed: Decimal;
  _avgCostPerKg: Decimal;
  _avgCostPerKgUsd: Decimal;
  _remainingValueLocal: Decimal;
  _remainingValueUsd: Decimal;
  lastOffloaded: unknown;
  _adjustmentIds?: number[];
};

/**
 * Usage not tied to a specific container draws the supplier's remaining stock
 * down at that stock's current blended cost/kg.
 */
function drawDown(stock: SupplierStock, kg: Decimal) {
  const remainingKgBefore = stock._totalReceived.minus(stock._totalUsed);
  const avgCostBefore = remainingKgBefore.gt(0) ? stock._remainingValueUsd.div(remainingKgBefore) : ZERO;
  const avgCostLocalBefore = remainingKgBefore.gt(0) ? stock._remainingValueLocal.div(remainingKgBefore) : ZERO;
  stock._totalUsed = stock._totalUsed.plus(kg);
  stock._remainingValueUsd = stock._remainingValueUsd.minus(kg.times(avgCostBefore));
  stock._remainingValueLocal = stock._remainingValueLocal.minus(kg.times(avgCostLocalBefore));
}

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
      const supplierLockedRateMap = new Map<number, Decimal>();
      for (const s of supplierRows) {
        supplierCategoryMap.set(s.id, {
          categoryId: s.supplierCategoryId ?? null,
          categoryName: s.categoryName ?? null,
        });
        const persisted = s.currentRawMaterialCostPerKgUsd;
        if (persisted !== null && persisted !== undefined) {
          supplierLockedRateMap.set(s.id, amountOrZero(persisted));
        } else {
          try {
            supplierLockedRateMap.set(s.id, toMoney(await getLockedSupplierRate(db, companyId, s.id)));
          } catch (rateErr: unknown) {
            logger.error(`[raw-stock] getLockedSupplierRate failed for supplier ${s.id}:`, {
              error: getErrorMessage(rateErr),
            });
            supplierLockedRateMap.set(s.id, ZERO);
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

      const supplierMap = new Map<string, SupplierStock>();
      for (const r of results) {
        const isOB = r.containerStatus === "OPENING_BALANCE";
        // Always merge by supplier — one row per supplier regardless of OB vs Container
        const key = r.supplierId ? `supplier-${r.supplierId}` : r.supplierName || `unknown-${r.containerId}`;
        const received = amountOrZero(r.receivedKg);
        const used = amountOrZero(r.usedKg);
        const costPerKg = amountOrZero(r.costPerKg);

        const storedCostPerKgUsd = amountOrZero(r.costPerKgUsd);
        const costPerKgUsd = storedCostPerKgUsd.isZero() ? costPerKg : storedCostPerKgUsd;
        // Each raw-stock row is one specific container/source with its own cost/kg and its
        // own usedKg (usage is already attributed to the exact container it was drawn from
        // via factoryMixBatchSources). The remaining VALUE of this row is therefore
        // (received - used) * this row's own cost/kg — never a blended average of every
        // container's received cost re-applied across the supplier's total remaining kg.
        // Averaging received cost first and multiplying by remaining kg afterwards silently
        // misattributes the cost of whatever was actually used to every other container in
        // the blend, inflating (or deflating) the remaining stock value.
        const rowRemainingKg = received.minus(used);
        const rowRemainingValueLocal = rowRemainingKg.times(costPerKg);
        const rowRemainingValueUsd = rowRemainingKg.times(costPerKgUsd);
        // The displayed "rate" (cost/kg) is a separate concept from remaining value: it's
        // the going purchase rate for this supplier's material, weighted by everything ever
        // RECEIVED. It should only move when a new container/receipt is added, never when
        // existing stock is consumed in a mix batch — so it's tracked independently of usage.
        if (supplierMap.has(key)) {
          const existing = supplierMap.get(key)!;
          const prevTotalCost = existing._totalReceived.times(existing._avgCostPerKg);
          const newTotalCost = received.times(costPerKg);
          const prevTotalCostUsd = existing._totalReceived.times(existing._avgCostPerKgUsd);
          const newTotalCostUsd = received.times(costPerKgUsd);
          existing._totalReceived = existing._totalReceived.plus(received);
          existing._totalUsed = existing._totalUsed.plus(used);
          existing._avgCostPerKg = existing._totalReceived.gt(0)
            ? prevTotalCost.plus(newTotalCost).div(existing._totalReceived)
            : ZERO;
          existing._avgCostPerKgUsd = existing._totalReceived.gt(0)
            ? prevTotalCostUsd.plus(newTotalCostUsd).div(existing._totalReceived)
            : ZERO;
          existing._remainingValueLocal = existing._remainingValueLocal.plus(rowRemainingValueLocal);
          existing._remainingValueUsd = existing._remainingValueUsd.plus(rowRemainingValueUsd);
          if (new Date(r.offloadedAt) > new Date(existing.lastOffloaded as string)) {
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
        const kg = amountOrZero(adj.kg);
        const costPerKgAdj = amountOrZero(adj.costPerKg);
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
            existing._totalReceived = existing._totalReceived.plus(kg);
            if (!supplierId) {
              const prevCost = existing._totalReceived.minus(kg).times(existing._avgCostPerKg);
              const newCost = kg.times(costPerKgAdj);
              existing._avgCostPerKg = existing._totalReceived.gt(0)
                ? prevCost.plus(newCost).div(existing._totalReceived)
                : ZERO;
              existing._avgCostPerKgUsd = existing._avgCostPerKg;
              existing._remainingValueLocal = existing._remainingValueLocal.plus(newCost);
              existing._remainingValueUsd = existing._remainingValueUsd.plus(newCost);
            }
          } else {
            // Manual usage isn't tied to a specific container/source, so it draws down
            // the supplier's remaining stock at that stock's current blended cost/kg —
            // the best available attribution without a specific source reference.
            drawDown(existing, kg);
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
            _totalReceived: isAdd ? kg : ZERO,
            _totalUsed: isAdd ? ZERO : kg,
            _avgCostPerKg: costPerKgAdj,
            _avgCostPerKgUsd: costPerKgAdj,
            _remainingValueLocal: isAdd ? kg.times(costPerKgAdj) : ZERO,
            _remainingValueUsd: isAdd ? kg.times(costPerKgAdj) : ZERO,
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
      const usedValueBySupplierId = new Map<number, Decimal>();
      for (const r of usedValueRows) {
        if (r.supplierId) usedValueBySupplierId.set(r.supplierId, amountOrZero(r.usedValueUsd));
      }

      const reservedBySupplierId = new Map<number, Decimal>();
      for (const r of reservedRows) {
        if (r.supplierId) reservedBySupplierId.set(r.supplierId, amountOrZero(r.reservedKg));
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
        const consumed = amountOrZero(r.consumedKg);
        const key = `supplier-${r.supplierId}`;
        if (supplierMap.has(key)) {
          drawDown(supplierMap.get(key)!, consumed);
        }
      }

      // Build aggregated rows (reservedKg / freeKg will be fixed below for multi-row suppliers)
      const aggregated = Array.from(supplierMap.values()).map((s) => {
        const remainingKg = s._totalReceived.minus(s._totalUsed);
        // For a REAL supplier, the displayed rate is ALWAYS the persisted locked rate —
        // never a recomputed receipt-weighted or remaining-value-derived figure. Only
        // an actual offload / opening balance / explicit correction can move it.
        // Standalone MANUAL materials (no supplierId) have no locked rate to read, so
        // they keep their own tracked blended-average cost.
        const lockedRateUsd = s.supplierId ? (supplierLockedRateMap.get(s.supplierId) ?? ZERO) : null;
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
          valueRemaining: (lockedRateUsd !== null ? ZERO : s._remainingValueLocal).toFixed(2),
          valueRemainingUsd: (lockedRateUsd !== null ? ZERO : s._remainingValueUsd).toFixed(2),
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
        const reserved = reservedBySupplierId.get(suppId) ?? ZERO;
        const totalRemaining = sumMoney(rows.map((r) => r.remainingKg));
        if (rows.length === 1) {
          rows[0].reservedKg = reserved.toFixed(3);
          rows[0].freeKg = totalRemaining.toFixed(3);
        } else {
          // Proportional distribution across multiple rows
          for (const row of rows) {
            const rem = toMoney(row.remainingKg);
            const proportion = totalRemaining.gt(0) ? rem.div(totalRemaining) : ZERO;
            row.reservedKg = reserved.times(proportion).toFixed(3);
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
        const freeKg = toMoney(row.freeKg);
        const lockedValue = freeKg.times(row._lockedRateUsd ?? ZERO).toFixed(2);
        // Total consumed value at each source's own recorded (locked-at-creation) rate —
        // NOT a blended-rate × total-used-kg guess. See usedValueRows above.
        const usedValueUsd = ((row.supplierId ? usedValueBySupplierId.get(row.supplierId) : undefined) ?? ZERO).toFixed(
          2
        );
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
      const newCostInput = parseMoneyInput(newCostPerKg);
      if (newCostInput === null || newCostInput.lt(0))
        return res.status(400).json({ message: "newCostPerKg must be a non-negative number" });

      // Stored in the same text form as before: the input read as a plain number.
      const newCost = newCostInput.toNumber();
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
          const wt = amountOrZero(src.weightKg);
          await tx
            .update(factoryMixBatchSources)
            .set({
              costPerKg: String(newCost),
              totalCost: wt.times(newCostInput).toFixed(2),
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

          const totalWt = sumMoney(allSources.map((r) => r.weightKg));
          const totalCostSum = sumMoney(
            allSources.map((r) => amountOrZero(r.weightKg).times(amountOrZero(r.costPerKg)))
          );
          const blendedCost = totalWt.gt(0) ? totalCostSum.div(totalWt) : ZERO;

          await tx
            .update(factoryMixBatches)
            .set({
              costPerKg: blendedCost.toFixed(4),
              totalCost: totalCostSum.toFixed(2),
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
            const baleWt = amountOrZero(bale.weightKg);
            await tx
              .update(factoryBales)
              .set({
                costPerKg: blendedCost.toFixed(2),
                totalCost: baleWt.times(blendedCost).toFixed(2),
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
      const deductKgInput = kg ? parseMoneyInput(kg) : null;
      if (deductKgInput === null || deductKgInput.lte(0)) return res.status(400).json({ message: "kg must be > 0" });

      const deductKgExact = deductKgInput;
      // A cost that does not parse leaves no daybook entry, as NaN > 0 did.
      const costPerKgExact = (costPerKg ? parseMoneyInput(costPerKg) : null) ?? ZERO;
      // Plain numbers for stored text and descriptions, as before.
      const deductKg = deductKgExact.toNumber();
      const costPerKgNum = costPerKgExact.toNumber();
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
      const totalFreeFromRows = sumMoney(
        rows.map((r) => MoneyDecimal.max(0, toMoney(r.receivedKg).minus(toMoney(r.usedKg))))
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
      const adjFree = adjRows.reduce((sum: Decimal, a) => {
        if (a.type === "DEDUCT") return sum; // DEDUCT is history-only; receivedKg on rows already reduced
        const k = amountOrZero(a.kg);
        return a.type === "ADD" ? sum.plus(k) : sum.minus(k);
      }, ZERO);

      const _totalFree = totalFreeFromRows.plus(MoneyDecimal.max(0, adjFree));

      // Allow over-use: no guard here — deduction can drive remaining stock negative

      // Deduct from rows newest-first; allow received to go below used (negative stock)
      let remaining: Decimal = deductKgExact;
      const updates: { id: number; newReceived: Decimal }[] = [];
      for (const row of rows) {
        if (remaining.lte(0)) break;
        const received = toMoney(row.receivedKg);
        // Allow over-use: deduct from received up to its full amount (may leave usedKg > receivedKg)
        const take = MoneyDecimal.min(remaining, received);
        if (take.gt(0)) {
          updates.push({ id: row.id, newReceived: received.minus(take) });
          remaining = remaining.minus(take);
        }
      }

      // Any remaining kg after row deductions → create a REMOVE adjustment
      const adjDeductKg = remaining.gt("0.001") ? remaining : ZERO;

      let fxRate = 1;
      if (ccy !== "USD" && costPerKgExact.gt(0)) {
        try {
          fxRate = toMoney(await getOrFetchFxRateToUsd(companyId, ccy, today)).toNumber();
        } catch {
          fxRate = 1;
        }
      }

      // Wave 11: the kg taken off received stock leave the factory raw-material
      // valuation; the daily factory stock journal posts that change as a
      // write-off (WASTE), not as production variance.
      await db.transaction((tx) =>
        withFactoryValuationEventTx(
          tx,
          companyId,
          "WASTE",
          { sourceType: "factory-raw-deduct-received", sourceId: Number(supplierId) },
          async () => {
            // 1. Update actual rows
            for (const u of updates) {
              await tx
                .update(factoryRawStock)
                .set({ receivedKg: u.newReceived.toFixed(3) })
                .where(eq(factoryRawStock.id, u.id));
            }

            // 1b. Record a DEDUCT history entry for the amount taken from container rows
            // DEDUCT type is skipped in all balance calculations — it only exists for history visibility.
            const rowDeductKg = deductKgExact.minus(adjDeductKg);
            if (rowDeductKg.gt("0.001")) {
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
            if (adjDeductKg.gt(0)) {
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
            if (costPerKgExact.gt(0)) {
              const totalValue = deductKgExact.times(costPerKgExact);
              const totalValueUsd = totalValue.times(fxRate);

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
                amountCurrency: totalValue.negated().toNumber(),
                fxRateToUsd: fxRate,
                amountUsd: totalValueUsd.negated().toNumber(),
              });
            }
          }
        )
      );

      res.json({ deducted: deductKg, rowsUpdated: updates.length, adjCreated: adjDeductKg.gt(0) });
    } catch (error: unknown) {
      logger.error("Error deducting received kg:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
