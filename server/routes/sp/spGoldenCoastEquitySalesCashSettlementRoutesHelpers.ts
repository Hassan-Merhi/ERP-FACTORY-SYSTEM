// Extracted from ./spGoldenCoastEquitySalesCashSettlementRoutes.ts
import type { Request, Response } from "express";
import Decimal from "decimal.js";
import { db } from "../../db";
import { closedPeriodErrorResponse } from "../../lib/closedPeriodError";
import { releaseDebtEnglish } from "../../i18n/finalCloseoutEnglish";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { PostingValidationError } from "../../services/accounting/centralPostingEngine";
import {
  GOLDEN_COAST_EQUITY_SALES_CASH_SOURCE_TYPE,
  GoldenCoastEquitySalesCashError,
} from "../../services/accounting/goldenCoastEquitySalesCashSettlement";
import { isGoldenCoastCompany } from "./spGoldenCoastPhase4CutoverFifoRoutes";
import { requireSpCompany } from "./spHelpers";
import {
  GoldenCoastEquitySalesCashRouteError,
  conservativePayable,
  creditBalance,
  resolveAccounts,
} from "./spGoldenCoastEquitySalesCashSettlementRoutesCreditBalance";

export function respondKnownError(res: Response, error: unknown): boolean {
  if (error instanceof GoldenCoastEquitySalesCashRouteError) {
    res.status(error.status).json({ code: error.code, message: error.message });
    return true;
  }
  if (error instanceof GoldenCoastEquitySalesCashError) {
    const status =
      error.code === "GC_EQUITY_SALES_CASH_EXCEEDS_PAYABLE" ||
      error.code === "GC_EQUITY_SALES_CASH_EXCEEDS_EQUITY" ||
      error.code === "GC_EQUITY_SALES_CASH_BALANCE_INVALID"
        ? 409
        : 400;
    res.status(status).json({ code: error.code, message: error.message });
    return true;
  }
  if (error instanceof PostingValidationError) {
    res.status(400).json({ code: error.code, message: releaseDebtEnglish(error.message) });
    return true;
  }
  const closed = closedPeriodErrorResponse(error);
  if (closed) {
    res.status(closed.status).json(closed.body);
    return true;
  }
  return false;
}

export async function handleReadiness(req: Request, res: Response): Promise<void> {
  try {
    const companyId = await requireSpCompany(req, res);
    if (!companyId) return;
    if (!(await isGoldenCoastCompany(db, companyId))) {
      res.status(409).json({
        code: "GC_EQUITY_SALES_CASH_NOT_CONFIGURED",
        message: releaseDebtEnglish("Golden Coast account setup is not configured."),
      });
      return;
    }
    const accounts = await resolveAccounts(db, companyId);
    const [payableUsd, hassanEquityUsd, freshStartEquityUsd] = await Promise.all([
      conservativePayable(db, companyId, accounts.gcSalesCash.id),
      creditBalance(db, companyId, accounts.hassanEquity.id, accounts.hassanEquity.name),
      creditBalance(db, companyId, accounts.freshStartEquity.id, accounts.freshStartEquity.name),
    ]);
    const hassanEquity = new Decimal(hassanEquityUsd).toDecimalPlaces(2);
    // One input drives both debits, so the settleable amount is whichever of
    // the two credit-normal balances runs out first.
    const maxSettlementUsd = Decimal.max(Decimal.min(new Decimal(payableUsd), hassanEquity), 0).toFixed(2);

    res.json({
      ready: new Decimal(maxSettlementUsd).gt(0),
      companyId,
      gcSalesCashAccount: accounts.gcSalesCash,
      hassanEquityAccount: accounts.hassanEquity,
      freshStartEquityAccount: accounts.freshStartEquity,
      payableSalesCashUsd: payableUsd,
      availableHassanEquityUsd: hassanEquity.toFixed(2),
      freshStartEquityUsd: new Decimal(freshStartEquityUsd).toDecimalPlaces(2).toFixed(2),
      maxSettlementUsd,
      sourceType: GOLDEN_COAST_EQUITY_SALES_CASH_SOURCE_TYPE,
    });
  } catch (error: unknown) {
    logger.error("Golden Coast equity sales-cash readiness failed", { error });
    if (respondKnownError(res, error)) return;
    res.status(500).json({ message: getErrorMessage(error) });
  }
}
