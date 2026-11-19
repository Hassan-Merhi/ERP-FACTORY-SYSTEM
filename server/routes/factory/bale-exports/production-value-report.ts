/**
 * factoryBaleExportRoutes: FactoryProductionValueReport endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { requireAuth } from "../../../auth";
import { toMoney } from "../../../lib/money";
import { productionValueReportStep } from "./productionValueReportStep";
import { productionValueReportStep2 } from "./productionValueReportStep2";
import { productionValueReportStep3 } from "./productionValueReportStep3";

export function registerFactoryProductionValueReportRoutes(app: Express) {
  // ───────────────────────────────────────────────
  // 8. Daily Production Value Report
  // ───────────────────────────────────────────────
  app.get("/api/factory/production-value-report", requireAuth, async (req: Request, res: Response) => {
    try {
      const pvr1 = await productionValueReportStep({ req, res });
      if (pvr1.done) return pvr1.value;
      const { from, to, hideReportCosts, valuationMode, linkedBatchRows } = pvr1;
      const pvr2 = await productionValueReportStep2({ pvr1 });
      const {
        totalBales,
        totalBaleWeightKg,
        totalProductionValue,
        totalWipersQty,
        totalWipersKg,
        totalGarbageQty,
        totalGarbageKg,
        totalWgWeightKg,
        totalWgValue,
        correctedBatchRows,
        totalMixWeightKg,
        periodOnTableKg,
        totalMixCost,
        blendedCostPerKg,
        balanceWeightKg,
        balanceCostPerKg,
        balanceValue,
        missingSelectedPriceBales,
        missingCostPriceBales,
        missingSellingPriceBales,
      } = pvr2;
      const pvr3 = await productionValueReportStep3({ pvr1, pvr2 });
      const {
        safeProductRows,
        safeCategoryRows,
        safeWgRows,
        safeWgProductRows,
        safeBatchRows,
        filteredTable,
        weightCost,
        statusValue,
        profitValue,
        profitMarginPct,
        kgDiff,
        safeSupplierMixBreakdown,
      } = pvr3;

      res.json({
        from: from || null,
        to: to || null,
        costsHidden: hideReportCosts,
        valuationMode: valuationMode,
        // Wave 11: the report's bale values are catalogue prices per bale — the
        // production (selling) value of what was produced — never the bales'
        // cost, which is factory_bales.total_cost (USD material cost).
        valueBasis: "selling-value-catalogue-price-per-bale",
        production: {
          totalBales: totalBales,
          totalWeightKg: totalBaleWeightKg,
          totalValue: hideReportCosts ? 0 : totalProductionValue,
          byProduct: safeProductRows,
          byCategory: safeCategoryRows,
          linkedBatches: linkedBatchRows.map((row) => ({
            id: row.id,
            totalWeightKg: toMoney(row.totalWeightKg).toNumber(),
          })),
        },
        wipersGarbage: {
          totalWipersQty: totalWipersQty,
          totalWipersKg: totalWipersKg,
          totalGarbageQty: totalGarbageQty,
          totalGarbageKg: totalGarbageKg,
          totalWeightKg: totalWgWeightKg,
          totalValue: hideReportCosts ? 0 : totalWgValue,
          rows: safeWgRows,
          products: safeWgProductRows,
        },
        rawMaterial: {
          totalBatches: correctedBatchRows.length,
          totalWeightKg: totalMixWeightKg,
          onTableKg: periodOnTableKg,
          totalCost: hideReportCosts ? 0 : totalMixCost,
          blendedCostPerKg: hideReportCosts ? 0 : blendedCostPerKg,
          batches: safeBatchRows,
        },
        // Original overall as-of balance: unchanged and independent of the start filter.
        balanceOnTable: {
          weightKg: balanceWeightKg,
          costPerKg: hideReportCosts ? 0 : balanceCostPerKg,
          value: hideReportCosts ? 0 : balanceValue,
        },
        // Selected period's net physical movement, not today's ACTIVE-only
        // original batches. A drawdown is identified explicitly on the card.
        filteredBalanceOnTable: {
          weightKg: filteredTable.weightKg,
          netChangeKg: filteredTable.netChangeKg,
          direction: filteredTable.direction,
          costPerKg: hideReportCosts ? 0 : filteredTable.costPerKg,
          value: hideReportCosts ? 0 : filteredTable.value,
        },
        summary: {
          // Keep batchCost as a compatibility alias for older clients. It now carries the
          // same value as Weight Cost; new clients should read weightCost.
          batchCost: hideReportCosts ? 0 : weightCost,
          weightCost: hideReportCosts ? 0 : weightCost,
          productionValue: hideReportCosts ? 0 : totalProductionValue,
          statusValue: hideReportCosts ? 0 : statusValue,
          costValue: hideReportCosts ? 0 : pvr1.totalProductionCostValue,
          sellingValue: hideReportCosts ? 0 : pvr1.totalSellingValue,
          remainingMaterialValue: hideReportCosts ? 0 : balanceValue,
          consumedMaterialCost: hideReportCosts ? 0 : weightCost,
          profitValue: hideReportCosts ? 0 : profitValue,
          profitMarginPct: hideReportCosts ? 0 : profitMarginPct,
          missingSelectedPriceBales: hideReportCosts ? 0 : missingSelectedPriceBales,
          missingCostPriceBales: hideReportCosts ? 0 : missingCostPriceBales,
          missingSellingPriceBales: hideReportCosts ? 0 : missingSellingPriceBales,
        },
        kgComparison: {
          producedKg: totalBaleWeightKg,
          mixedKg: totalMixWeightKg,
          diffKg: kgDiff,
          diffLabel: kgDiff >= 0 ? "more produced than mixed" : "less produced than mixed",
        },
        supplierMixBreakdown: safeSupplierMixBreakdown,
      });
    } catch (error: unknown) {
      logger.error("Error fetching production value report:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
