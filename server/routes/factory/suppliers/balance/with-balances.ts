/**
 * supplierBalanceRoutes: SupplierWithBalances endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../../lib/httpHandlers";
import { logger } from "../../../../lib/logger";
import { requireAuth } from "../../../../auth";
import { handleGetFactorySuppliersWithBalancesStep1 } from "./handleGetFactorySuppliersWithBalancesStep1";
import { handleGetFactorySuppliersWithBalancesStep2 } from "./handleGetFactorySuppliersWithBalancesStep2";
import { handleGetFactorySuppliersWithBalancesStep3 } from "./handleGetFactorySuppliersWithBalancesStep3";
import { handleGetFactorySuppliersWithBalancesStep4 } from "./with-balances-helpers";

export function registerSupplierWithBalancesRoutes(app: Express) {
  app.get("/api/factory/suppliers/with-balances", requireAuth, async (req: Request, res: Response) => {
    try {
      const step1Result = await handleGetFactorySuppliersWithBalancesStep1(req, res);
      if (step1Result.done) return step1Result.value;
      const {
        allFxTransfers,
        allOffloadAdditionalCharges,
        allPayments,
        companyId,
        configuredFxRates,
        containers,
        includeOtw,
        ledgerExposure,
        ledgerFields,
        settlementBalances,
        suppliersList,
        voucherFxUnresolvedSuppliers,
        voucherPaidBySupplierCurrency,
        voucherPaidBySupplierCurrencyUsd,
      } = step1Result;
      const { computeStats } = handleGetFactorySuppliersWithBalancesStep2({
        allFxTransfers,
        allOffloadAdditionalCharges,
        allPayments,
        configuredFxRates,
        containers,
        voucherFxUnresolvedSuppliers,
        voucherPaidBySupplierCurrency,
        voucherPaidBySupplierCurrencyUsd,
      });
      const { brokerParentIds, brokerStmtMap, statsById } = await handleGetFactorySuppliersWithBalancesStep3({
        companyId,
        computeStats,
        includeOtw,
        suppliersList,
      });
      const { suppliersWithBalances } = handleGetFactorySuppliersWithBalancesStep4({
        brokerParentIds,
        brokerStmtMap,
        configuredFxRates,
        ledgerExposure,
        ledgerFields,
        settlementBalances,
        statsById,
        suppliersList,
      });
      handleGetFactorySuppliersWithBalancesStep5({ suppliersWithBalances }, res);
    } catch (error: unknown) {
      logger.error("Error fetching factory suppliers with balances:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}

function handleGetFactorySuppliersWithBalancesStep5(
  {
    suppliersWithBalances,
  }: Pick<Awaited<ReturnType<typeof handleGetFactorySuppliersWithBalancesStep4>>, "suppliersWithBalances">,
  res: Response
) {
  res.json(suppliersWithBalances.sort((a, b) => a.name.localeCompare(b.name)));
  return {};
}
