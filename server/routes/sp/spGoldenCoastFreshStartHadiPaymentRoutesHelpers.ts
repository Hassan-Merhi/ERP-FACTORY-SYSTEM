// Extracted from ./spGoldenCoastFreshStartHadiPaymentRoutes.ts
import type { Request, Response } from "express";
import { db } from "../../db";
import { releaseDebtEnglish } from "../../i18n/finalCloseoutEnglish";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { type GoldenCoastFreshStartHadiPaymentAccounts } from "../../services/accounting/goldenCoastFreshStartHadiPayment";
import { assertTransactionCompanyScope } from "../../services/security/transactionCompanyScope";
import { isGoldenCoastCompany } from "./spGoldenCoastPhase4CutoverFifoRoutes";
import { requireSpCompany } from "./spHelpers";
import {
  FreshStartHadiRouteError,
  assertHadiAuthorized,
  debitBalance,
  listHadiCashAccounts,
  outstandingHadiSalesCash,
  resolveAccounts,
  resolvePair,
  type DatabaseTransaction,
} from "./spGoldenCoastFreshStartHadiPaymentRoutesResolvePair";

export async function balancesForPayment(
  tx: DatabaseTransaction,
  companyId: number,
  accounts: GoldenCoastFreshStartHadiPaymentAccounts
) {
  const [gcSalesCashRaw, outstandingHadiSalesCashUsd, hadiIntercompanyAssetRaw] = await Promise.all([
    debitBalance(tx, companyId, accounts.gcSalesCashAccountId),
    outstandingHadiSalesCash(tx, companyId),
    debitBalance(tx, companyId, accounts.goldenCoastHadiIntercompanyAccountId),
  ]);
  return {
    gcSalesCashPayableUsd: Math.max(0, -Number(gcSalesCashRaw)).toFixed(2),
    outstandingHadiSalesCashUsd: Math.max(0, Number(outstandingHadiSalesCashUsd)).toFixed(2),
    hadiIntercompanyAssetUsd: Math.max(0, Number(hadiIntercompanyAssetRaw)).toFixed(2),
  };
}

export async function handleReadiness(req: Request, res: Response): Promise<void> {
  try {
    const companyId = await requireSpCompany(req, res);
    if (!companyId) return;
    if (!(await isGoldenCoastCompany(db, companyId))) {
      res.status(409).json({
        code: "GC_FS_HADI_NOT_CONFIGURED",
        message: releaseDebtEnglish("Golden Coast account setup is not configured"),
      });
      return;
    }
    const result = await db.transaction(async (tx) => {
      const pair = await resolvePair(tx, companyId);
      assertHadiAuthorized(pair);
      const accounts = await resolveAccounts(tx, pair);
      await assertTransactionCompanyScope(tx, pair.goldenCoastCompanyId);
      const balances = await balancesForPayment(tx, companyId, accounts.ids);
      await assertTransactionCompanyScope(tx, pair.hadiCompanyId);
      const hadiCashAccounts = await listHadiCashAccounts(tx, pair.hadiCompanyId);
      await assertTransactionCompanyScope(tx, pair.goldenCoastCompanyId);
      const maximum = Math.min(
        Number(balances.gcSalesCashPayableUsd),
        Number(balances.outstandingHadiSalesCashUsd),
        Number(balances.hadiIntercompanyAssetUsd)
      );
      return {
        pair,
        accounts: { ...accounts.ids, ...accounts.names },
        ...balances,
        maximumPaymentUsd: Math.max(0, maximum).toFixed(2),
        hadiCashAccounts,
        ready: maximum > 0 && hadiCashAccounts.length > 0,
      };
    });
    res.json(result);
  } catch (error) {
    logger.error("Golden Coast Fresh Start HADI payment readiness failed", {
      error,
    });
    if (error instanceof FreshStartHadiRouteError) {
      res.status(error.status).json({ code: error.code, message: error.message });
      return;
    }
    res.status(500).json({ message: getErrorMessage(error) });
  }
}
