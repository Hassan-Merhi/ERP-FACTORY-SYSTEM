// Extracted from ./spGoldenCoastPhase7HadiTransferRoutes.ts
import type { Request, Response } from "express";
import { db } from "../../db";
import { releaseDebtEnglish } from "../../i18n/finalCloseoutEnglish";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { gcSalesCashPayableBalance } from "../../services/accounting/goldenCoastSalesCashPayable";
import { assertTransactionCompanyScope } from "../../services/security/transactionCompanyScope";
import { isGoldenCoastCompany } from "./spGoldenCoastPhase4CutoverFifoRoutes";
import { requireSpCompany } from "./spHelpers";
import {
  assertHadiCompanyAuthorized,
  resolveCompanyPair,
  resolvePhase7Accounts,
  type GoldenCoastPhase7CompanyPair,
  type ResolvedPhase7Accounts,
} from "./spGoldenCoastPhase7HadiTransferRoutesResolveCompanyPair";
import { gcSalesCashSignedBalance, listCashAccounts, outstandingPhase7HadiCollections } from "./findReplayedTransfer";

export async function handleReadiness(req: Request, res: Response): Promise<void> {
  try {
    const companyId = await requireSpCompany(req, res);
    if (!companyId) return;
    if (!(await isGoldenCoastCompany(db, companyId))) {
      res.status(409).json({
        code: "GC_PHASE7_NOT_CONFIGURED",
        message: releaseDebtEnglish("Golden Coast account setup is not configured."),
      });
      return;
    }

    const result = await db.transaction(async (tx) => {
      const blockers: string[] = [];
      let pair: GoldenCoastPhase7CompanyPair | null = null;
      let accounts: ResolvedPhase7Accounts | null = null;
      let balances: { gcSalesCashPayableBalanceUsd: string; outstandingHadiCollectionsUsd: string } | null = null;
      let hadiCashAccounts: Awaited<ReturnType<typeof listCashAccounts>> = [];
      let goldenCoastCashAccounts: Awaited<ReturnType<typeof listCashAccounts>> = [];

      try {
        pair = await resolveCompanyPair(tx, companyId);
        assertHadiCompanyAuthorized(pair);
        accounts = await resolvePhase7Accounts(tx, pair);

        await assertTransactionCompanyScope(tx, pair.goldenCoastCompanyId);
        balances = {
          gcSalesCashPayableBalanceUsd: gcSalesCashPayableBalance(
            await gcSalesCashSignedBalance(tx, companyId, accounts.gcSalesCashAccountId)
          ),
          outstandingHadiCollectionsUsd: await outstandingPhase7HadiCollections(tx, companyId),
        };
        goldenCoastCashAccounts = await listCashAccounts(tx, pair.goldenCoastCompanyId);

        await assertTransactionCompanyScope(tx, pair.hadiCompanyId);
        hadiCashAccounts = await listCashAccounts(tx, pair.hadiCompanyId);
        await assertTransactionCompanyScope(tx, pair.goldenCoastCompanyId);
        if (hadiCashAccounts.length === 0)
          blockers.push("HADI has no active cash or bank account available for Phase 7.");
        if (goldenCoastCashAccounts.length === 0) {
          blockers.push("Golden Coast has no active cash or bank account available for HADI remittance.");
        }
      } catch (error) {
        blockers.push(error instanceof Error ? error.message : String(error));
      }

      return {
        pair,
        accounts,
        balances,
        hadiCashAccounts,
        goldenCoastCashAccounts,
        blockers,
        canTransfer: blockers.length === 0,
      };
    });

    res.json(result);
  } catch (error) {
    logger.error("Golden Coast Phase 7 readiness failed", { error });
    res.status(500).json({ message: getErrorMessage(error) });
  }
}
