/**
 * factoryBaleExportRoutes: FactoryProductionValueReport endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db, pool } from "../../../db";
import { requireAuth } from "../../../auth";
import Decimal from "decimal.js";
import { getLockedSupplierRateReadOnly } from "../../../services/factory/rawStockLockedRate";
import {
  factoryCategories,
  factoryBaleProducts,
  factoryMixBatches,
  factoryMixBatchSources,
  factoryBales,
  factoryWorkers,
} from "@shared/schema";
import { eq, and, sql, inArray, isNull } from "drizzle-orm";
import { resultRows } from "../../../lib/queryResult";

export function registerFactoryProductionValueReportRoutes(app: Express) {
  // ───────────────────────────────────────────────
  // 8. Daily Production Value Report
  // ───────────────────────────────────────────────
  app.get("/api/factory/production-value-report", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const from = req.query.from as string | undefined;
      const to = req.query.to as string | undefined;
      // Worker filter — accepts a single `workerId` (legacy) or a comma-separated
      // `workerIds` list (multi-select filter on the Production Comparison page).
      const workerIdParam = req.query.workerId as string | undefined;
      const workerIdsParam = req.query.workerIds as string | undefined;
      const workerIdFilter = [
        ...new Set(
          [...(workerIdsParam ? workerIdsParam.split(",") : []), ...(workerIdParam ? [workerIdParam] : [])]
            .map((v) => parseInt(String(v).trim(), 10))
            .filter((n) => Number.isFinite(n))
        ),
      ];

      // ── Build date range conditions ──
      // Use COALESCE(stock_entry_date, DATE(created_at)) so bales without a stock_entry_date
      // (e.g. wipers/garbage entered via stock import) are still included using their creation date.
      const baleConditions = [
        eq(factoryBales.companyId, companyId),
        // Exclude deleted/removed bales and REPACKED originals.
        // REPACKED: when a bale is repacked a new IN_STOCK bale is created with the same
        // weight; the original bale stays in the DB with status REPACKED.  Counting both
        // would double-count that weight in Productions.
        sql`${factoryBales.status} NOT IN ('DELETED', 'REMOVED', 'REPACKED')`,
      ];
      if (from)
        baleConditions.push(
          sql`COALESCE(DATE(${factoryBales.stockEntryDate}), DATE(${factoryBales.createdAt})) >= ${from}`
        );
      if (to)
        baleConditions.push(
          sql`COALESCE(DATE(${factoryBales.stockEntryDate}), DATE(${factoryBales.createdAt})) <= ${to}`
        );
      if (workerIdFilter.length === 1) baleConditions.push(eq(factoryBales.finalizedBy, workerIdFilter[0]));
      else if (workerIdFilter.length > 1) baleConditions.push(inArray(factoryBales.finalizedBy, workerIdFilter));

      // Exclude CARRY_FORWARD batches from the "Original Batches" total.
      // CARRY_FORWARD batches represent leftover material from a parent batch whose weight is
      // already counted in the parent's totalWeightKg.  Including them would double-count
      // that leftover and inflate the raw-material total.
      // Also exclude soft-deleted batches (deletedAt IS NOT NULL): their bales are deleted
      // and excluded from Productions, so counting them here would widen the gap unfairly.
      const mixBatchConditions = [
        eq(factoryMixBatches.companyId, companyId),
        sql`${factoryMixBatches.carryForwardFromId} IS NULL`,
        isNull(factoryMixBatches.deletedAt),
      ];
      if (from)
        mixBatchConditions.push(
          sql`COALESCE(${factoryMixBatches.batchDate}, DATE(${factoryMixBatches.createdAt})) >= ${from}`
        );
      if (to)
        mixBatchConditions.push(
          sql`COALESCE(${factoryMixBatches.batchDate}, DATE(${factoryMixBatches.createdAt})) <= ${to}`
        );

      // ── Fetch bales with product cost price and category ──
      const baleRows = await db
        .select({
          id: factoryBales.id,
          articleCode: factoryBales.articleCode,
          productName: factoryBales.productName,
          weightKg: factoryBales.weightKg,
          stockEntryDate: factoryBales.stockEntryDate,
          productionPrice: factoryBaleProducts.productionPrice,
          productId: factoryBales.productId,
          categoryId: factoryBaleProducts.categoryId,
          categoryName: factoryCategories.name,
          finalizedBy: factoryBales.finalizedBy,
          baleWorkerName: factoryBales.workerName,
          workerFullName: factoryWorkers.fullName,
        })
        .from(factoryBales)
        .leftJoin(factoryBaleProducts, eq(factoryBales.productId, factoryBaleProducts.id))
        .leftJoin(factoryCategories, eq(factoryBaleProducts.categoryId, factoryCategories.id))
        .leftJoin(factoryWorkers, eq(factoryBales.finalizedBy, factoryWorkers.id))
        .where(and(...baleConditions));

      // ── Helper: detect wipers/garbage by category name ──
      function isWiperOrGarbage(catName: string): boolean {
        const lower = (catName || "").toLowerCase();
        return lower.includes("wiper") || lower.includes("garbage") || lower.includes("rag");
      }

      // ── Aggregate by article code (regular bales only) ──
      const productMap = new Map<
        string,
        {
          articleCode: string;
          productName: string;
          categoryName: string;
          qty: number;
          totalWeightKg: number;
          costPricePerBale: number;
          totalValue: number;
          // Distinct workers who finalized bales of this product in the period.
          workers: Map<string, { id: number | null; name: string; qty: number }>;
        }
      >();

      // ── Aggregate by category (regular bales only) ──
      const categoryMap = new Map<
        string,
        {
          categoryName: string;
          qty: number;
          totalWeightKg: number;
          totalValue: number;
        }
      >();

      // ── Wipers & Garbage aggregation (separate) ──
      const wgMap = new Map<
        string,
        {
          subType: "wiper" | "garbage" | "other";
          qty: number;
          totalWeightKg: number;
          totalValue: number;
        }
      >();

      for (const bale of baleRows) {
        const code = bale.articleCode || "UNKNOWN";
        const name = bale.productName || code;
        const catName = bale.categoryName || "Uncategorized";
        const wt = parseFloat(bale.weightKg || "0");
        const price = parseFloat(bale.productionPrice || "0");
        const value = price; // price is per bale (not per kg)
        // Prefer the live worker record; fall back to the name snapshotted on the bale.
        const workerName = (bale.workerFullName || bale.baleWorkerName || "").trim();
        const workerId = bale.finalizedBy ?? null;

        if (isWiperOrGarbage(catName)) {
          // Route to wipers/garbage bucket
          const lower = catName.toLowerCase();
          const subType: "wiper" | "garbage" | "other" = lower.includes("wiper")
            ? "wiper"
            : lower.includes("garbage")
              ? "garbage"
              : "other";
          const existing = wgMap.get(catName);
          if (existing) {
            existing.qty += 1;
            existing.totalWeightKg += wt;
            existing.totalValue += value;
          } else {
            wgMap.set(catName, { subType, qty: 1, totalWeightKg: wt, totalValue: value });
          }
        } else {
          // Regular bale
          const existing = productMap.get(code);
          if (existing) {
            existing.qty += 1;
            existing.totalWeightKg += wt;
            existing.totalValue += value;
          } else {
            productMap.set(code, {
              articleCode: code,
              productName: name,
              categoryName: catName,
              qty: 1,
              totalWeightKg: wt,
              costPricePerBale: price,
              totalValue: value,
              workers: new Map(),
            });
          }

          if (workerName || workerId != null) {
            const wMap = productMap.get(code)!.workers;
            const wKey = workerId != null ? `id:${workerId}` : `name:${workerName.toLowerCase()}`;
            const wEx = wMap.get(wKey);
            if (wEx) wEx.qty += 1;
            else wMap.set(wKey, { id: workerId, name: workerName || `Worker #${workerId}`, qty: 1 });
          }

          const catExisting = categoryMap.get(catName);
          if (catExisting) {
            catExisting.qty += 1;
            catExisting.totalWeightKg += wt;
            catExisting.totalValue += value;
          } else {
            categoryMap.set(catName, { categoryName: catName, qty: 1, totalWeightKg: wt, totalValue: value });
          }
        }
      }

      const productRows = [...productMap.values()]
        .sort((a, b) => a.articleCode.localeCompare(b.articleCode))
        .map(({ workers, ...rest }) => ({
          ...rest,
          workers: [...workers.values()].sort((a, b) => b.qty - a.qty || a.name.localeCompare(b.name)),
        }));
      const categoryRows = [...categoryMap.values()].sort((a, b) => a.categoryName.localeCompare(b.categoryName));

      const totalBales = productRows.reduce((s, r) => s + r.qty, 0);
      const totalBaleWeightKg = productRows.reduce((s, r) => s + r.totalWeightKg, 0);
      const totalProductionValue = productRows.reduce((s, r) => s + r.totalValue, 0);

      // ── Wipers/garbage totals ──
      const wgRows = [...wgMap.entries()].map(([catName, v]) => ({ categoryName: catName, ...v }));
      const totalWipersQty = wgRows.filter((r) => r.subType === "wiper").reduce((s, r) => s + r.qty, 0);
      const totalWipersKg = wgRows.filter((r) => r.subType === "wiper").reduce((s, r) => s + r.totalWeightKg, 0);
      const totalGarbageQty = wgRows
        .filter((r) => r.subType === "garbage" || r.subType === "other")
        .reduce((s, r) => s + r.qty, 0);
      const totalGarbageKg = wgRows
        .filter((r) => r.subType === "garbage" || r.subType === "other")
        .reduce((s, r) => s + r.totalWeightKg, 0);
      const totalWgValue = wgRows.reduce((s, r) => s + r.totalValue, 0);
      const totalWgWeightKg = wgRows.reduce((s, r) => s + r.totalWeightKg, 0);

      // ── Fetch mix batches ──
      const mixBatchRows = await db
        .select({
          id: factoryMixBatches.id,
          batchCode: factoryMixBatches.batchCode,
          name: factoryMixBatches.name,
          totalWeightKg: factoryMixBatches.totalWeightKg,
          usedKg: factoryMixBatches.usedKg,
          status: factoryMixBatches.status,
          costPerKg: factoryMixBatches.costPerKg,
          totalCost: factoryMixBatches.totalCost,
          batchDate: factoryMixBatches.batchDate,
          createdAt: factoryMixBatches.createdAt,
        })
        .from(factoryMixBatches)
        .where(and(...mixBatchConditions))
        .orderBy(sql`COALESCE(${factoryMixBatches.batchDate}, DATE(${factoryMixBatches.createdAt}))`);

      // ── Recompute each batch's display cost using current supplier locked rates ──
      // Mirrors GET /api/factory/mix-batches and EditMixBatchDialog: never uses the stored
      // batch cost fields directly; supplier-source rows always use the current locked USD rate.
      const reportBatchIds = mixBatchRows.map((r) => r.id);
      let mixSourceRows: (typeof factoryMixBatchSources.$inferSelect)[] = [];
      if (reportBatchIds.length > 0) {
        mixSourceRows = await db
          .select()
          .from(factoryMixBatchSources)
          .where(inArray(factoryMixBatchSources.mixBatchId, reportBatchIds));
      }

      // Resolve current locked USD rate for every unique supplier referenced by sources
      const reportSupplierIds = [
        ...new Set(mixSourceRows.filter((s) => s.supplierId != null).map((s) => s.supplierId as number)),
      ];
      const reportSupplierRateMap = new Map<number, number>();
      for (const sid of reportSupplierIds) {
        const { rate } = await getLockedSupplierRateReadOnly(db, companyId, sid);
        reportSupplierRateMap.set(sid, rate);
      }

      // Group sources by batch
      const reportSourcesByBatch = new Map();
      for (const src of mixSourceRows) {
        if (!reportSourcesByBatch.has(src.mixBatchId)) reportSourcesByBatch.set(src.mixBatchId, []);
        reportSourcesByBatch.get(src.mixBatchId)!.push(src);
      }

      // Build corrected batch objects for the report (read-only; no DB writes)
      const correctedBatchRows = mixBatchRows.map((b) => {
        const sources = reportSourcesByBatch.get(b.id) || [];
        let displayWeightKg = new Decimal(0);
        let displayCost = new Decimal(0);

        for (const src of sources) {
          const w = new Decimal(src.weightKg || 0);
          let effectiveCpk: Decimal;
          if (src.sourceBatchId != null) {
            // A. Existing-batch source — use stored costPerKg from source row
            effectiveCpk = new Decimal(src.costPerKg || 0);
          } else if (src.supplierId != null) {
            // B. Supplier source (with or without containerId) — use current locked rate
            effectiveCpk = new Decimal(reportSupplierRateMap.get(src.supplierId) || 0);
          } else {
            // C. Safe fallback
            effectiveCpk = new Decimal(src.costPerKg || 0);
          }
          displayWeightKg = displayWeightKg.plus(w);
          displayCost = displayCost.plus(w.times(effectiveCpk));
        }

        let displayCostPerKg: Decimal;
        if (displayWeightKg.gt(0)) {
          displayCostPerKg = displayCost.dividedBy(displayWeightKg);
        } else {
          // No source rows — fall back to stored batch values. Only cost and
          // cost/kg are read past this branch; the weight is not projected out.
          displayCost = new Decimal(b.totalCost || 0);
          displayCostPerKg = new Decimal(b.costPerKg || 0);
        }

        return {
          ...b,
          costPerKg: displayCostPerKg.toDecimalPlaces(6).toString(),
          totalCost: displayCost.toDecimalPlaces(6).toString(),
        };
      });

      const totalMixWeightKg = correctedBatchRows.reduce(
        (s: number, r) => s + parseFloat(r.totalWeightKg || "0"),
        0
      );
      const totalMixCost = correctedBatchRows.reduce((s: number, r) => s + parseFloat(r.totalCost || "0"), 0);

      // Material from period batches that is still on the pressing table (not yet turned into bales).
      // Only ACTIVE batches have meaningful on-table material; COMPLETED batches set usedKg = totalWeightKg
      // when closed, so their contribution is already 0 by definition.
      const periodOnTableKg = mixBatchRows.reduce((s: number, r) => {
        if ((r.status || "ACTIVE") !== "ACTIVE") return s;
        const remaining = Math.max(0, parseFloat(r.totalWeightKg || "0") - parseFloat(r.usedKg || "0"));
        return s + remaining;
      }, 0);

      // ── Balance on table ──
      // "Balance on Table" is a CURRENT STATE metric: how much raw material has been mixed into
      // batches but not yet turned into finished bales.  We use the same formula as the Net
      // Position page: allTimeMixKg − allTimeBaleKg.  This is more robust than tracking
      // usedKg per-batch, which breaks when batches are marked COMPLETED prematurely.
      const mixAllTimeResult = await db.execute(sql`
        SELECT
          COALESCE(SUM(total_weight_kg::numeric), 0) AS mix_kg,
          COALESCE(SUM(total_cost::numeric),      0) AS mix_cost
        FROM factory_mix_batches
        WHERE company_id        = ${companyId}
          AND carry_forward_from_id IS NULL
          AND deleted_at        IS NULL
      `);
      const mixAllTimeRow = resultRows(mixAllTimeResult)[0] ?? {};
      const allTimeMixKg = parseFloat(String(mixAllTimeRow.mix_kg ?? "0")) || 0;
      const allTimeMixCost = parseFloat(String(mixAllTimeRow.mix_cost ?? "0")) || 0;

      const baleAllTimeResult = await db.execute(sql`
        SELECT COALESCE(SUM(b.weight_kg::numeric), 0) AS bale_kg
        FROM   factory_bales        b
        LEFT   JOIN factory_bale_products p ON p.id = b.product_id
        LEFT   JOIN factory_categories    c ON c.id = p.category_id
        WHERE  b.company_id = ${companyId}
          AND  b.status NOT IN ('DELETED', 'REMOVED')
      `);
      const baleAllTimeRow = resultRows(baleAllTimeResult)[0] ?? {};
      const allTimeBaleKg = parseFloat(String(baleAllTimeRow.bale_kg ?? "0")) || 0;

      const allTimeBlendedCpk = allTimeMixKg > 0 ? allTimeMixCost / allTimeMixKg : 0;
      const blendedCostPerKg = totalMixWeightKg > 0 ? totalMixCost / totalMixWeightKg : 0;
      const balanceWeightKg = Math.max(0, allTimeMixKg - allTimeBaleKg);
      const balanceValue = Math.round(balanceWeightKg * allTimeBlendedCpk * 100) / 100;

      // ── PRODUCTION PROFIT = Bales value − (Produced kg × balance-on-table blended rate) ──
      const statusValue = totalProductionValue - totalBaleWeightKg * allTimeBlendedCpk;

      // ── Kg comparison ──
      const kgDiff = totalBaleWeightKg - totalMixWeightKg;

      // ── Supplier mix breakdown (per day, per supplier) ──
      // Use inventorySupplierId — the canonical ownership field set on ALL source types,
      // including batch-to-batch sources. This traces back to the ultimate raw-material supplier
      // even when the immediate source is another mix batch.
      const inventorySupplierIds = [
        ...new Set(
          mixSourceRows.filter((s) => s.inventorySupplierId != null).map((s) => s.inventorySupplierId as number)
        ),
      ];

      // Also collect direct supplierId / container supplierId as fallback
      const allSupplierIdsForNames = [...new Set([...inventorySupplierIds, ...reportSupplierIds])];

      const supplierNameById = new Map<number, string>();
      if (allSupplierIdsForNames.length > 0) {
        const sRows = await pool.query(`SELECT id, name FROM factory_suppliers WHERE id = ANY($1)`, [
          allSupplierIdsForNames,
        ]);
        for (const r of sRows.rows) {
          supplierNameById.set(r.id as number, r.name as string);
        }
      }

      // Fallback: container → supplier name for sources without inventorySupplierId
      const containerIds = [
        ...new Set(
          mixSourceRows
            .filter((s) => s.inventorySupplierId == null && s.containerId != null)
            .map((s) => s.containerId as number)
        ),
      ];
      const containerSupplierIdMap = new Map<number, number | null>();
      if (containerIds.length > 0) {
        const cRows = await pool.query(`SELECT id, supplier_id FROM factory_containers WHERE id = ANY($1)`, [
          containerIds,
        ]);
        for (const r of cRows.rows) {
          containerSupplierIdMap.set(r.id as number, r.supplier_id as number | null);
          // Fetch supplier name if not already loaded
          if (r.supplier_id && !supplierNameById.has(r.supplier_id as number)) {
            const snRow = await pool.query(`SELECT name FROM factory_suppliers WHERE id = $1`, [r.supplier_id]);
            if (snRow.rows[0]) supplierNameById.set(r.supplier_id as number, snRow.rows[0].name as string);
          }
        }
      }

      // Resolve supplier name for one source row
      function resolveSupplierName(src: {
        inventorySupplierId?: number | null;
        supplierId?: number | null;
        containerId?: number | null;
      }): string {
        // 1. inventorySupplierId — most authoritative
        if (src.inventorySupplierId != null) {
          return supplierNameById.get(src.inventorySupplierId) ?? `Supplier #${src.inventorySupplierId}`;
        }
        // 2. Direct supplierId on the source row
        if (src.supplierId != null) {
          return supplierNameById.get(src.supplierId) ?? `Supplier #${src.supplierId}`;
        }
        // 3. Container → supplier
        if (src.containerId != null) {
          const csid = containerSupplierIdMap.get(src.containerId);
          if (csid) return supplierNameById.get(csid) ?? `Supplier #${csid}`;
        }
        return "Unknown";
      }

      // Group ALL sources (including batch-to-batch) by (date, supplierName)
      type SupDay = { date: string; supplierName: string; totalKg: number; totalCost: number };
      const supDayMap = new Map<string, SupDay>();

      for (const batch of (mixBatchRows)) {
        const batchDate: string = batch.batchDate
          ? String(batch.batchDate).slice(0, 10)
          : String(batch.createdAt).slice(0, 10);
        const sources = reportSourcesByBatch.get(batch.id) || [];

        for (const src of sources) {
          const supplierName = resolveSupplierName(src);
          if (
            supplierName === "Unknown" &&
            src.inventorySupplierId == null &&
            src.supplierId == null &&
            src.containerId == null
          ) {
            continue; // truly unresolvable — skip
          }

          const w = parseFloat(src.weightKg || "0");
          // Use effective cost: locked rate for direct-supplier sources, stored costPerKg otherwise
          let cpk: number;
          if (src.supplierId != null) {
            cpk = reportSupplierRateMap.get(src.supplierId) ?? parseFloat(src.costPerKg || "0");
          } else {
            cpk = parseFloat(src.costPerKg || "0");
          }

          const key = `${batchDate}::${supplierName}`;
          const ex = supDayMap.get(key);
          if (ex) {
            ex.totalKg += w;
            ex.totalCost += w * cpk;
          } else {
            supDayMap.set(key, { date: batchDate, supplierName, totalKg: w, totalCost: w * cpk });
          }
        }
      }

      const supplierMixBreakdown = [...supDayMap.values()].sort((a, b) =>
        a.date !== b.date ? a.date.localeCompare(b.date) : a.supplierName.localeCompare(b.supplierName)
      );

      res.json({
        from: from || null,
        to: to || null,
        production: {
          totalBales,
          totalWeightKg: totalBaleWeightKg,
          totalValue: totalProductionValue,
          byProduct: productRows,
          byCategory: categoryRows,
        },
        wipersGarbage: {
          totalWipersQty,
          totalWipersKg,
          totalGarbageQty,
          totalGarbageKg,
          totalWeightKg: totalWgWeightKg,
          totalValue: totalWgValue,
          rows: wgRows,
        },
        rawMaterial: {
          totalBatches: correctedBatchRows.length,
          totalWeightKg: totalMixWeightKg,
          onTableKg: periodOnTableKg,
          totalCost: totalMixCost,
          blendedCostPerKg,
          batches: correctedBatchRows,
        },
        balanceOnTable: {
          weightKg: balanceWeightKg,
          // Use all-time blended cost so the card is never affected by the date filter.
          costPerKg: allTimeBlendedCpk,
          value: balanceValue,
        },
        summary: {
          batchCost: totalMixCost,
          productionValue: totalProductionValue,
          statusValue,
        },
        kgComparison: {
          producedKg: totalBaleWeightKg,
          mixedKg: totalMixWeightKg,
          diffKg: kgDiff,
          diffLabel: kgDiff >= 0 ? "more produced than mixed" : "less produced than mixed",
        },
        supplierMixBreakdown,
      });
    } catch (error: unknown) {
      logger.error("Error fetching production value report:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
