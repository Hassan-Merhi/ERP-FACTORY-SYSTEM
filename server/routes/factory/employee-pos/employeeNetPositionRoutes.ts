import { FactoryNetPositionDateError } from "@shared/factoryNetPositionAsOf";
import { resolveFactoryNetPositionAsOf } from "../../../services/factory/netPositionAsOf";
import { loadFactoryNetPositionEmployees } from "../../../services/factory/netPositionEmployees";
import { computeHistoricalFactoryAssetLiabilityOperations } from "../../../services/factory/netPositionHistoricalAssets";
import { loadFactoryHistoricalCoverage } from "../../../services/factory/netPositionHistoryCoverage";
import { finishFactoryNetPosition } from "./netPositionHistoricalResponse";
import { projectFactoryNetPositionMonetaryFx } from "./netPositionMonetaryFxProjection";
import { loadNetPositionFxActivity } from "../../../services/accounting/netPositionFxActivity";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import type { Express, Request, Response } from "express";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";

import { companies } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import { computeNetPositionSupplierBalances } from "./netPositionSupplierBalances";
import { loadNetPositionConfigFx, loadNetPositionLedgerBalances } from "./netPositionLedgerBalances";
import { classifyFactoryNetPositionLedger } from "./netPositionLedgerClassification";
import { loadFactoryNetPositionPipeline } from "./netPositionPipeline";
import { computeFactoryNetPositionTotals } from "./netPositionTotals";
import { buildFactoryNetPositionBody } from "./netPositionResponseBody";

export function registerEmployeeNetPositionRoutes(app: Express) {
  // The Net Position evidence drill-down shares the parent page's Factory
  // permission boundary. It reads vouchers and rate changes but creates none.
  app.get("/api/factory/net-position/fx-activity", requireAuth, async (req: Request, res: Response) => {
    const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
    if (!companyId) return res.status(400).json({ message: "No company selected" });
    res.setHeader("Cache-Control", "private, no-store");
    try {
      return res.json(
        await loadNetPositionFxActivity({
          companyId,
          factory: true,
          from: req.query.from,
          to: req.query.to,
        })
      );
    } catch (error) {
      if (error instanceof Error && /Invalid history date|History start date/.test(error.message)) {
        return res.status(400).json({ message: error.message });
      }
      logger.error("Factory FX evidence history failed", { companyId, error });
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/factory/net-position", requireAuth, async (req: Request, res: Response) => {
    // Set once the date resolves: any later failure of a past date is a
    // structured 503, never a partial or current-day figure.
    let historicalRequest = false;
    try {
      // Resolve factory company ID the same way my-access does:
      // 1. pinned factoryCompanyId (if it's a factory-type company)
      // 2. currentCompanyId (if it's factory-type)
      // 3. first active factory-type company in DB
      // 4. fall back to currentCompanyId
      let companyId: number | null = req.session.factoryCompanyId || null;

      if (!companyId) {
        const currentId = req.session.currentCompanyId;
        if (currentId) {
          const [cur] = await db
            .select({ id: companies.id, companyType: companies.companyType })
            .from(companies)
            .where(eq(companies.id, currentId));
          if (cur?.companyType === "factory") companyId = cur.id;
        }
      }

      if (!companyId) {
        const [fc] = await db
          .select({ id: companies.id })
          .from(companies)
          .where(and(eq(companies.companyType, "factory"), eq(companies.active, true)))
          .limit(1);
        if (fc) companyId = fc.id;
      }

      if (!companyId) companyId = (req.session as { currentCompanyId: number | null }).currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      // Pin it for subsequent requests this session
      req.session.factoryCompanyId = companyId;

      // Resolve one company-local cutoff for ALL downstream components.
      // Each category will adopt the effective+recorded predicate in Phases 3–6.
      const asOfContext = await resolveFactoryNetPositionAsOf(companyId, req.query.asOf);
      const asOf = asOfContext.asOf;
      historicalRequest = asOfContext.isHistorical;
      // Perform a read-only prerequisite and evidence check BEFORE invoking
      // any reconstruction query that refers to trigger-added scan timestamps.
      const historyCoverage = asOfContext.isHistorical
        ? await loadFactoryHistoricalCoverage(companyId, asOfContext)
        : null;
      const employeeBalances = await loadFactoryNetPositionEmployees(companyId, asOfContext);
      const historicalAssets = asOfContext.isHistorical
        ? await computeHistoricalFactoryAssetLiabilityOperations(companyId, asOfContext)
        : null;

      const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
      const { configFxRates, getConfigFx } = await loadNetPositionConfigFx({ companyId, asOf, asOfContext });

      // ── 1. Factory supplier balances (What We Owe) ──────────────────────
      // Computed in ./netPositionSupplierBalances. suppliersList,
      // supplierLockedRateMapNp and allContainersF come back with the balances
      // because the inventory valuations below are built from the same loads.
      const {
        supplierLockedRateMapNp,
        allContainersF,
        supplierItems,
        totalSupplierLiabilities,
        totalSupplierOverpayments,
      } = await computeNetPositionSupplierBalances({
        companyId,
        asOf,
        knownAt: asOfContext.isHistorical ? asOfContext : undefined,
        round2,
        getConfigFx,
      });

      // Reclassify verified unpaid foreign-currency supplier payables from their
      // current-rate balance into historic-rate suppliers + actual FX display rows.
      // Both sides receive the same offset: the real Net Position is unchanged.
      const supplierFxGainUsd = round2(
        supplierItems.reduce((sum, item) => sum + Math.max(0, item.fxBasisAdjustmentUsd ?? 0), 0)
      );
      const supplierFxLossUsd = round2(
        supplierItems.reduce((sum, item) => sum + Math.max(0, -(item.fxBasisAdjustmentUsd ?? 0)), 0)
      );
      const supplierLiabilitiesAtHistoricBasis = round2(
        totalSupplierLiabilities + supplierFxGainUsd - supplierFxLossUsd
      );
      const {
        factoryAccounts,
        factoryExcludedCodes,
        ledgerStock,
        allCustomersForNP,
        projectedAccountBalances,
        fxAgentWallets,
        fxAgentWalletWarnings,
        walletFxDifferences,
      } = await loadNetPositionLedgerBalances({
        companyId,
        asOfContext,
        employeeBalances,
        asOf,
        historyCoverage,
        configFxRates,
        round2,
      });
      const { ledgerForUs, ledgerOnUs, ledgerOnUsTotal, customerItems } = await classifyFactoryNetPositionLedger({
        factoryAccounts,
        companyId,
        projectedAccountBalances,
        ledgerStock,
        factoryExcludedCodes,
        allCustomersForNP,
        round2,
        asOf,
        asOfContext,
      });
      const {
        valuationMode,
        inventorySellingValue,
        historicalPipeline,
        stockOtwValue,
        inventorySellValue,
        rawMaterialStockValue,
        balanceOnTableValue,
        pendingOrders,
        verifiedOrders,
        loadingOrders,
        pendingTotal,
        verifiedTotal,
        loadingTotal,
      } = await loadFactoryNetPositionPipeline({
        req,
        companyId,
        asOf,
        getConfigFx,
        configFxRates,
        supplierLockedRateMapNp,
        allContainersF,
        asOfContext,
        round2,
      });
      const {
        baleInventoryValue,
        selectedBalanceOnTableValue,
        cleanLedgerForUs,
        cleanLedgerForUsTotal,
        walletFxGainUsd,
        walletFxLossUsd,
        fxGainUsd,
        fxLossUsd,
        fxGainBreakdown,
        fxLossBreakdown,
        workerAdvancesValue,
        customerDrItems,
        customerCrItems,
        totalCustomerCr,
        prepaidRent,
        rentPayable,
        employeeReceivableItems,
        employeeSalariesPayable,
        forUsTotal,
        onUsTotal,
        netPosition,
      } = await computeFactoryNetPositionTotals({
        round2,
        valuationMode,
        inventorySellingValue,
        inventorySellValue,
        balanceOnTableValue,
        ledgerForUs,
        ledgerOnUs,
        walletFxDifferences,
        supplierFxGainUsd,
        supplierFxLossUsd,
        supplierItems,
        historicalAssets,
        companyId,
        customerItems,
        asOf,
        employeeBalances,
        totalSupplierOverpayments,
        rawMaterialStockValue,
        stockOtwValue,
        verifiedTotal,
        loadingTotal,
        ledgerOnUsTotal,
        supplierLiabilitiesAtHistoricBasis,
      });
      const { responseBody } = buildFactoryNetPositionBody({
        baleInventoryValue,
        rawMaterialStockValue,
        selectedBalanceOnTableValue,
        stockOtwValue,
        verifiedTotal,
        loadingTotal,
        verifiedOrders,
        loadingOrders,
        fxGainUsd,
        fxGainBreakdown,
        cleanLedgerForUs,
        round2,
        customerDrItems,
        supplierItems,
        prepaidRent,
        employeeReceivableItems,
        workerAdvancesValue,
        ledgerOnUs,
        fxLossUsd,
        fxLossBreakdown,
        employeeSalariesPayable,
        customerCrItems,
        rentPayable,
        supplierLiabilitiesAtHistoricBasis,
        totalCustomerCr,
        asOf,
        fxAgentWallets,
        fxAgentWalletWarnings,
        forUsTotal,
        onUsTotal,
        netPosition,
        totalSupplierLiabilities,
        supplierFxGainUsd,
        supplierFxLossUsd,
        walletFxGainUsd,
        walletFxLossUsd,
        totalSupplierOverpayments,
        valuationMode,
        cleanLedgerForUsTotal,
        pendingOrders,
        pendingTotal,
        ledgerOnUsTotal,
      });

      const finished = await finishFactoryNetPosition({
        companyId,
        scope: asOfContext,
        body: responseBody,
        valuationMode,
        historyCoverage,
        pipelineWarnings: historicalPipeline?.warnings ?? [],
        assetWarnings: historicalAssets?.warnings ?? [],
      });

      // Today's verified monetary ledger/customer rows at the current company
      // rate (netPositionMonetaryFxProjection.ts); historical reports and
      // pinned secondary companies keep the booked USD.
      return res.json(
        await projectFactoryNetPositionMonetaryFx(finished, {
          companyId,
          isHistorical: asOfContext.isHistorical,
          sessionCompanyId: req.session?.currentCompanyId,
        })
      );
    } catch (error: unknown) {
      if (error instanceof FactoryNetPositionDateError) {
        return res.status(error.status).json({ code: error.code, message: error.message });
      }
      logger.error("Factory net-position error:", { error: error });
      if (historicalRequest || (error instanceof Error && error.message.startsWith("HISTORICAL_"))) {
        const fxMissing = error instanceof Error && error.message.startsWith("Missing confirmed USD exchange rate");
        return res.status(503).json({
          code: "HISTORICAL_NET_POSITION_UNAVAILABLE",
          message:
            "The historical snapshot could not be constructed. No current-day balance was substituted." +
            (fxMissing ? ` ${(error as Error).message} known by the selected date.` : ""),
        });
      }
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ─── Payroll Payable Breakdown (view-only, for Net Position page) ────────────
  // GET /api/factory/net-position/payroll-breakdown
  // Returns one row per active employee whose currentBalance > 0.
  // This endpoint is purely informational and does NOT affect any Net Position
  // calculation, account, or balance — it is read-only.
}
