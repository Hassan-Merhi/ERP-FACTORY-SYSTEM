import type { Express, NextFunction, Request, Response } from "express";
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import { requireAuth, requireNonPOS } from "../../auth";
import { db } from "../../db";
import { releaseDebtEnglish } from "../../i18n/finalCloseoutEnglish";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { privilegedMutationRateLimit } from "../../middleware/privilegedEndpointSecurity";
import { PostingValidationError, postBalancedVoucherTx } from "../../services/accounting/centralPostingEngine";
import {
  GoldenCoastPhase7TransferError,
  buildGoldenCoastPhase7TransferPostings,
  goldenCoastPhase7TransferDigest,
  parseGoldenCoastPhase7TransferInput,
  planGoldenCoastPhase7Transfer,
  type GoldenCoastPhase7PostingRole,
} from "../../services/accounting/goldenCoastPhase7HadiTransfer";
import { assertTransactionCompanyScope } from "../../services/security/transactionCompanyScope";
import { getCurrentExchangeRate } from "../helpers/exchangeRateHelpers";
import { isGoldenCoastCompany } from "./spGoldenCoastPhase4CutoverFifoRoutes";
import { requireSpCompany } from "./spHelpers";
import {
  GOLDEN_COAST_PHASE16_LEGACY_HADI_PATH,
  GOLDEN_COAST_PHASE16_LEGACY_HADI_RETIRED_CODE,
  GoldenCoastPhase16HadiError,
  assertHadiAuthorized,
  debitBalance,
  goldenCoastPhase16LegacyHadiRetiredPayload,
  phase16RequestBudget,
  postingDependencies,
  resolveAccounts,
  resolvePair,
  validateCashAccount,
  type PersistedPostingResult,
} from "./goldenCoastPhase16LegacyHadiRetiredPayload";
import { findReplay, trackedHadiSalesCash } from "./spGoldenCoastPhase16HadiTransferGuardFindReplay";
export {
  GOLDEN_COAST_PHASE16_LEGACY_HADI_PATH,
  GOLDEN_COAST_PHASE16_LEGACY_HADI_RETIRED_CODE,
  goldenCoastPhase16LegacyHadiRetiredPayload,
} from "./goldenCoastPhase16LegacyHadiRetiredPayload";

function respondKnownError(res: Response, error: unknown): boolean {
  if (error instanceof GoldenCoastPhase16HadiError) {
    res.status(error.status).json({ code: error.code, message: error.message });
    return true;
  }
  if (error instanceof GoldenCoastPhase7TransferError) {
    const conflict =
      error.code === "GC_PHASE7_REMITTANCE_EXCEEDS_COLLECTIONS" || error.code === "GC_PHASE7_SCOPE_INVALID";
    res.status(conflict ? 409 : 400).json({ code: error.code, message: error.message });
    return true;
  }
  if (error instanceof PostingValidationError) {
    res
      .status(error.code === "POSTING_IDEMPOTENCY_CORRUPT" ? 409 : 400)
      .json({ code: error.code, message: error.message });
    return true;
  }
  return false;
}

async function handleRemittance(req: Request, res: Response): Promise<void> {
  const startedAt = Date.now();
  let companyId: number | null = null;
  try {
    companyId = await requireSpCompany(req, res);
    if (!companyId) return;
    if (!(await isGoldenCoastCompany(db, companyId))) {
      res.status(409).json({
        code: "GC_PHASE16_NOT_CONFIGURED",
        message: releaseDebtEnglish("Golden Coast account setup is not configured"),
      });
      return;
    }

    const outcome = await db.transaction(async (tx) => {
      const pair = await resolvePair(tx, companyId!);
      assertHadiAuthorized(pair);
      const transfer = parseGoldenCoastPhase7TransferInput({
        companyId: pair.goldenCoastCompanyId,
        parentCompanyId: pair.hadiCompanyId,
        body: req.body,
      });
      if (transfer.operation !== "remit_from_hadi" || !transfer.goldenCoastCashAccount) {
        throw new GoldenCoastPhase16HadiError(
          goldenCoastPhase16LegacyHadiRetiredPayload().message,
          GOLDEN_COAST_PHASE16_LEGACY_HADI_RETIRED_CODE,
          409
        );
      }

      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`golden-coast-phase7:${pair.goldenCoastCompanyId}`}))`
      );
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`golden-coast-phase7:${pair.goldenCoastCompanyId}:${transfer.clientRequestId}`}))`
      );
      const accounts = await resolveAccounts(tx, pair);
      await validateCashAccount(tx, pair.hadiCompanyId, transfer.hadiCashAccount, "HADI cash account");
      await validateCashAccount(
        tx,
        pair.goldenCoastCompanyId,
        transfer.goldenCoastCashAccount,
        "Golden Coast receiving account"
      );
      const digest = goldenCoastPhase7TransferDigest({ transfer, accounts });
      const replayed = await findReplay(tx, pair, transfer, accounts, digest);
      if (replayed) return { replayed: true as const, pair, transfer, plan: null, postings: replayed };

      // Lock voucher writers while reading the two independent caps. A Phase 16
      // remittance is limited by both provenance-tracked HADI sale proceeds and
      // the live GC-side HADI asset, so it cannot strand or overdraw proceeds.
      await tx.execute(sql`LOCK TABLE voucher_entries IN SHARE ROW EXCLUSIVE MODE`);
      const [tracked, rawAsset] = await Promise.all([
        trackedHadiSalesCash(tx, pair.goldenCoastCompanyId),
        debitBalance(tx, pair.goldenCoastCompanyId, accounts.goldenCoastHadiIntercompanyAccountId),
      ]);
      const safeOutstanding = Decimal.min(tracked, Decimal.max(rawAsset, 0)).toDecimalPlaces(2);
      const plan = planGoldenCoastPhase7Transfer({
        transfer,
        balances: { gcSalesCashDebitBalanceUsd: "0.00", outstandingHadiCollectionsUsd: safeOutstanding.toFixed(2) },
      });
      const [goldenCoastExchangeRate, hadiExchangeRate] = await Promise.all([
        getCurrentExchangeRate(pair.goldenCoastCompanyId),
        getCurrentExchangeRate(pair.hadiCompanyId),
      ]);
      const batch = buildGoldenCoastPhase7TransferPostings({
        plan,
        accounts,
        transferDigest: digest,
        goldenCoastExchangeRate: goldenCoastExchangeRate == null ? null : String(goldenCoastExchangeRate),
        hadiExchangeRate: hadiExchangeRate == null ? null : String(hadiExchangeRate),
        actor: {
          userId: req.session.userId ?? null,
          username: req.session.username || "unknown",
          reason: "Golden Coast Phase 16 HADI proceeds remittance",
        },
      });
      const postings: Array<{
        role: GoldenCoastPhase7PostingRole;
        voucher: PersistedPostingResult["voucher"];
        entries: PersistedPostingResult["entries"];
      }> = [];
      for (const item of batch.postings) {
        const markerCompanyId = item.role === "golden_coast" ? pair.goldenCoastCompanyId : pair.hadiCompanyId;
        await assertTransactionCompanyScope(tx, markerCompanyId);
        const posted = (await postBalancedVoucherTx(tx, item.request, postingDependencies)) as PersistedPostingResult;
        if (posted.replayed) {
          throw new GoldenCoastPhase16HadiError(
            "HADI remittance replayed unexpectedly during a new transaction",
            "GC_PHASE16_IDEMPOTENCY_INCONSISTENT",
            409
          );
        }
        postings.push({ role: item.role, voucher: posted.voucher, entries: posted.entries });
      }
      await assertTransactionCompanyScope(tx, pair.goldenCoastCompanyId);
      return { replayed: false as const, pair, transfer, plan, postings };
    });

    logger.info("Golden Coast Phase 16 HADI remittance posted", {
      companyId,
      hadiCompanyId: outcome.pair.hadiCompanyId,
      clientRequestId: outcome.transfer.clientRequestId,
      amountUsd: outcome.transfer.amountUsd,
      replayed: outcome.replayed,
      durationMs: Date.now() - startedAt,
    });
    res.status(outcome.replayed ? 200 : 201).json({
      ok: true,
      replayed: outcome.replayed,
      operation: outcome.transfer.operation,
      amountUsd: outcome.transfer.amountUsd,
      transferDate: outcome.transfer.transferDate,
      outstandingHadiSalesCashAfterUsd: outcome.plan?.outstandingHadiCollectionsAfterUsd ?? null,
      postings: outcome.postings.map((item) => ({ role: item.role, voucher: item.voucher, entries: item.entries })),
    });
  } catch (error) {
    logger.error("Golden Coast Phase 16 HADI remittance failed", { companyId, error });
    if (respondKnownError(res, error)) return;
    res.status(500).json({ message: getErrorMessage(error) });
  }
}

/**
 * Phase 16 preserves the old GET readiness probe because existing POS/HADI
 * discovery depends on it. For POSTs, automatic collection is retired, while
 * `remit_from_hadi` remains supported through this Phase 16-safe handler.
 */
export function registerSpGoldenCoastPhase16HadiTransferGuard(app: Express): void {
  app.use(
    GOLDEN_COAST_PHASE16_LEGACY_HADI_PATH,
    requireAuth,
    requireNonPOS,
    (req: Request, res: Response, next: NextFunction) => {
      if (req.method !== "POST") {
        next();
        return;
      }
      privilegedMutationRateLimit(req, res, (rateError?: unknown) => {
        if (rateError) {
          next(rateError);
          return;
        }
        phase16RequestBudget(req, res, (budgetError?: unknown) => {
          if (budgetError) {
            next(budgetError);
            return;
          }
          if (req.body?.operation !== "remit_from_hadi") {
            res.status(409).json(goldenCoastPhase16LegacyHadiRetiredPayload());
            return;
          }
          void handleRemittance(req, res);
        });
      });
    }
  );
}
