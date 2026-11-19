import type { Express, Request, Response } from "express";
import { sql } from "drizzle-orm";
import Decimal from "decimal.js";
import { requireAuth, requireNonPOS } from "../../auth";
import { db } from "../../db";
import { releaseDebtEnglish } from "../../i18n/finalCloseoutEnglish";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { privilegedMutationRateLimit, privilegedReadRateLimit } from "../../middleware/privilegedEndpointSecurity";
import { PostingValidationError, postBalancedVoucherTx } from "../../services/accounting/centralPostingEngine";
import {
  GOLDEN_COAST_PHASE10_SOURCE_TYPE,
  GoldenCoastPhase10SettlementError,
  buildGoldenCoastPhase10SettlementPosting,
  goldenCoastPhase10SettlementDigest,
  parseGoldenCoastPhase10SettlementInput,
  planGoldenCoastPhase10Settlement,
} from "../../services/accounting/goldenCoastSalesCashSettlement";
import {
  gcSalesCashPayableBalance,
  gcSalesCashSettleablePayable,
} from "../../services/accounting/goldenCoastSalesCashPayable";
import { isGoldenCoastCompany } from "./spGoldenCoastCutoverFifoRoutes";
import { requireSpCompany } from "./spHelpers";
import {
  GoldenCoastPhase10RouteError,
  actorFromRequest,
  assertPhase10CutoverPosted,
  phase10RequestBudget,
  postingDependencies,
  resolveGcSalesCashAccount,
  resolveSharedChargesAccount,
  validatePaymentAccount,
} from "./spGoldenCoastSalesCashSettlementRoutesValidatePaymentAccount";
import { findReplayedSettlement, gcSalesCashDebitBalance, listPaymentAccounts } from "./findReplayedSettlement";

function respondKnownError(res: Response, error: unknown): boolean {
  if (error instanceof GoldenCoastPhase10RouteError) {
    res.status(error.status).json({ code: error.code, message: error.message });
    return true;
  }
  if (error instanceof GoldenCoastPhase10SettlementError) {
    const status =
      error.code === "GC_PHASE10_SETTLEMENT_EXCEEDS_BALANCE" || error.code === "GC_PHASE10_BALANCE_INVALID" ? 409 : 400;
    res.status(status).json({ code: error.code, message: error.message });
    return true;
  }
  if (error instanceof PostingValidationError) {
    res.status(400).json({ code: error.code, message: releaseDebtEnglish(error.message) });
    return true;
  }
  return false;
}

async function handleReadiness(req: Request, res: Response): Promise<void> {
  try {
    const companyId = await requireSpCompany(req, res);
    if (!companyId) return;
    if (!(await isGoldenCoastCompany(db, companyId))) {
      res.status(409).json({
        code: "GC_PHASE10_NOT_CONFIGURED",
        message: releaseDebtEnglish("Golden Coast account setup is not configured."),
      });
      return;
    }
    await assertPhase10CutoverPosted(db, companyId);
    const gcSalesCashAccount = await resolveGcSalesCashAccount(db, companyId);
    const [balanceUsd, paymentAccounts, sharedChargesAccount] = await Promise.all([
      gcSalesCashDebitBalance(db, companyId, gcSalesCashAccount.id),
      listPaymentAccounts(db, companyId),
      resolveSharedChargesAccount(db, companyId, false),
    ]);
    const rawBalance = new Decimal(balanceUsd).toDecimalPlaces(2);
    // Credit-normal payable: positive is still owed, negative means overpaid.
    // The settleable figure floors that at zero so an overpaid account never
    // invites a further payment.
    const payableBalanceUsd = gcSalesCashPayableBalance(rawBalance.toFixed());
    const payableBalance = gcSalesCashSettleablePayable(payableBalanceUsd);
    res.json({
      ready: paymentAccounts.length > 0 && new Decimal(payableBalance).gt(0),
      companyId,
      gcSalesCashAccount,
      // The panel reads settleableSalesCashUsd / rawSalesCashPayableBalanceUsd /
      // receiptAccounts. The older payableSalesCashUsd, rawSalesCashDebitBalanceUsd
      // and paymentAccounts spellings stay on the payload so already-shipped
      // mobile and desktop builds keep reading the same readiness response.
      settleableSalesCashUsd: payableBalance,
      payableSalesCashUsd: payableBalance,
      rawSalesCashPayableBalanceUsd: payableBalanceUsd,
      rawSalesCashDebitBalanceUsd: rawBalance.toFixed(2),
      // A transfer fee can only be charged when Shared Charges is configured.
      sharedChargesAccount,
      receiptAccounts: paymentAccounts,
      paymentAccounts,
      sourceType: GOLDEN_COAST_PHASE10_SOURCE_TYPE,
    });
  } catch (error: unknown) {
    logger.error("Golden Coast Phase 10 readiness failed", { error });
    if (respondKnownError(res, error)) return;
    res.status(500).json({ message: getErrorMessage(error) });
  }
}

async function handleSettlement(req: Request, res: Response): Promise<void> {
  try {
    const companyId = await requireSpCompany(req, res);
    if (!companyId) return;
    if (!(await isGoldenCoastCompany(db, companyId))) {
      res.status(409).json({
        code: "GC_PHASE10_NOT_CONFIGURED",
        message: releaseDebtEnglish("Golden Coast account setup is not configured."),
      });
      return;
    }
    const settlement = parseGoldenCoastPhase10SettlementInput({
      companyId,
      body: req.body,
    });
    const actor = actorFromRequest(req);

    const outcome = await db.transaction(async (tx) => {
      // Phase 7 HADI payments and Phase 10 direct payments can both reduce the
      // GC Sales Cash tracker. Serialize them against the same company lock.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`golden-coast-phase7:${companyId}`}))`);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`golden-coast-phase10:${companyId}`}))`);
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`golden-coast-phase10:${companyId}:${settlement.clientRequestId}`}))`
      );
      if (!(await isGoldenCoastCompany(tx, companyId))) {
        throw new GoldenCoastPhase10RouteError(
          "Golden Coast account setup is not configured",
          "GC_PHASE10_NOT_CONFIGURED",
          409
        );
      }

      await assertPhase10CutoverPosted(tx, companyId);
      const gcSalesCashAccount = await resolveGcSalesCashAccount(tx, companyId);
      await validatePaymentAccount(tx, companyId, settlement.paymentAccount);

      // Shared Charges is only resolved — and only required — when the payment
      // actually carries a transfer fee.
      const sharedChargesAccount = new Decimal(settlement.transferFeeUsd).greaterThan(0)
        ? await resolveSharedChargesAccount(tx, companyId, true)
        : null;
      const settlementDigest = goldenCoastPhase10SettlementDigest({
        settlement,
        gcSalesCashAccountId: gcSalesCashAccount.id,
        sharedChargesAccountId: sharedChargesAccount?.id ?? null,
      });
      const replayed = await findReplayedSettlement(tx, companyId, settlement, gcSalesCashAccount.id, settlementDigest);
      if (replayed) {
        const currentBalance = await gcSalesCashDebitBalance(tx, companyId, gcSalesCashAccount.id);
        const payable = gcSalesCashSettleablePayable(gcSalesCashPayableBalance(currentBalance));
        return {
          replayed: true as const,
          settlement,
          gcSalesCashAccount,
          gcSalesCashDebitBalanceAfterUsd: new Decimal(currentBalance).toDecimalPlaces(2).toFixed(2),
          gcSalesCashPayableAfterUsd: payable,
          cashOutflowUsd: new Decimal(settlement.amountUsd).plus(settlement.transferFeeUsd).toFixed(2),
          voucher: replayed.voucher,
          entries: replayed.entries,
        };
      }

      // Prevent any concurrent voucher writer from changing the capped payable
      // between the balance read and the Phase 10 posting commit.
      await tx.execute(sql`LOCK TABLE voucher_entries IN SHARE ROW EXCLUSIVE MODE`);

      const datedBalanceUsd = await gcSalesCashDebitBalance(
        tx,
        companyId,
        gcSalesCashAccount.id,
        settlement.settlementDate
      );
      const allPostedBalanceUsd = await gcSalesCashDebitBalance(tx, companyId, gcSalesCashAccount.id);
      // Both values are signed Dr-minus-Cr. For a credit payable, the larger
      // (less negative) balance is the smaller safe amount payable now: a
      // future-dated sale cannot be paid early, and an already-posted later
      // payment can never be ignored.
      const gcSalesCashDebitBalanceUsd = Decimal.max(
        new Decimal(datedBalanceUsd),
        new Decimal(allPostedBalanceUsd)
      ).toString();
      const plan = planGoldenCoastPhase10Settlement({
        settlement,
        gcSalesCashDebitBalanceUsd,
      });
      const request = buildGoldenCoastPhase10SettlementPosting({
        plan,
        gcSalesCashAccountId: gcSalesCashAccount.id,
        sharedChargesAccountId: sharedChargesAccount?.id ?? null,
        settlementDigest,
        actor,
      });
      const posted = await postBalancedVoucherTx(tx, request, postingDependencies);
      return {
        replayed: posted.replayed,
        settlement,
        plan,
        gcSalesCashAccount,
        gcSalesCashDebitBalanceAfterUsd: plan.gcSalesCashDebitBalanceAfterUsd,
        gcSalesCashPayableAfterUsd: plan.gcSalesCashPayableAfterUsd,
        cashOutflowUsd: plan.cashOutflowUsd,
        voucher: posted.voucher,
        entries: posted.entries,
      };
    });

    res.status(outcome.replayed ? 200 : 201).json({
      ok: true,
      replayed: outcome.replayed,
      companyId,
      clientRequestId: outcome.settlement.clientRequestId,
      amountUsd: outcome.settlement.amountUsd,
      transferFeeUsd: outcome.settlement.transferFeeUsd,
      cashOutflowUsd: outcome.cashOutflowUsd,
      gcSalesCashDebitBalanceAfterUsd: outcome.gcSalesCashDebitBalanceAfterUsd,
      gcSalesCashPayableAfterUsd: outcome.gcSalesCashPayableAfterUsd,
      gcSalesCashAccountId: outcome.gcSalesCashAccount.id,
      voucher: outcome.voucher,
      entries: outcome.entries,
    });
  } catch (error: unknown) {
    logger.error("Golden Coast Phase 10 Fresh Start payment failed", { error });
    if (respondKnownError(res, error)) return;
    res.status(500).json({ message: getErrorMessage(error) });
  }
}

export function registerSpGoldenCoastPhase10SalesCashSettlementRoutes(app: Express): void {
  app.get(
    "/api/sp/golden-coast/phase10/sales-cash-settlement/readiness",
    privilegedReadRateLimit,
    requireAuth,
    requireNonPOS,
    (req, res) => void handleReadiness(req, res)
  );

  app.post(
    "/api/sp/golden-coast/phase10/sales-cash-settlement",
    privilegedMutationRateLimit,
    phase10RequestBudget,
    requireAuth,
    requireNonPOS,
    (req, res) => void handleSettlement(req, res)
  );
}
