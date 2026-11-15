import type { Express, Request, Response } from "express";
import { sql } from "drizzle-orm";
import { requireAuth, requireNonPOS } from "../../auth";
import { db } from "../../db";
import { releaseDebtEnglish } from "../../i18n/finalCloseoutEnglish";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { privilegedMutationRateLimit, privilegedReadRateLimit } from "../../middleware/privilegedEndpointSecurity";
import { PostingValidationError, postBalancedVoucherTx } from "../../services/accounting/centralPostingEngine";
import {
  GoldenCoastPhase7TransferError,
  buildGoldenCoastPhase7TransferPostings,
  goldenCoastPhase7TransferDigest,
  parseGoldenCoastPhase7TransferInput,
  planGoldenCoastPhase7Transfer,
  type GoldenCoastPhase7PostingRole,
} from "../../services/accounting/goldenCoastPhase7HadiTransfer";
import { gcSalesCashPayableBalance } from "../../services/accounting/goldenCoastSalesCashPayable";
import { assertTransactionCompanyScope } from "../../services/security/transactionCompanyScope";
import { getCurrentExchangeRate } from "../helpers/exchangeRateHelpers";
import { isGoldenCoastCompany } from "./spGoldenCoastPhase4CutoverFifoRoutes";
import { requireSpCompany } from "./spHelpers";
import {
  GoldenCoastPhase7RouteError,
  assertHadiCompanyAuthorized,
  phase7RequestBudget,
  postingDependencies,
  resolveCompanyPair,
  resolvePhase7Accounts,
  type GoldenCoastPhase7CompanyPair,
  type PersistedPostingResult,
  type ResolvedPhase7Accounts,
} from "./spGoldenCoastPhase7HadiTransferRoutesResolveCompanyPair";
import {
  findReplayedTransfer,
  gcSalesCashSignedBalance,
  listCashAccounts,
  outstandingPhase7HadiCollections,
  validateCashAccount,
} from "./findReplayedTransfer";

function respondKnownError(res: Response, error: unknown): boolean {
  if (error instanceof GoldenCoastPhase7RouteError) {
    res.status(error.status).json({ code: error.code, message: error.message });
    return true;
  }
  if (error instanceof GoldenCoastPhase7TransferError) {
    const conflictCodes = new Set(["GC_PHASE7_REMITTANCE_EXCEEDS_COLLECTIONS", "GC_PHASE7_SCOPE_INVALID"]);
    res.status(conflictCodes.has(error.code) ? 409 : 400).json({ code: error.code, message: error.message });
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

async function handleReadiness(req: Request, res: Response): Promise<void> {
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

async function handlePostTransfer(req: Request, res: Response): Promise<void> {
  const startedAt = Date.now();
  let companyId: number | null = null;
  const userId = req.session.userId;

  try {
    companyId = await requireSpCompany(req, res);
    if (!companyId) return;
    const selectedCompany = companyId;
    if (!(await isGoldenCoastCompany(db, selectedCompany))) {
      res.status(409).json({
        code: "GC_PHASE7_NOT_CONFIGURED",
        message: releaseDebtEnglish("Golden Coast account setup is not configured."),
      });
      return;
    }

    const result = await db.transaction(async (tx) => {
      const pair = await resolveCompanyPair(tx, selectedCompany);
      assertHadiCompanyAuthorized(pair);
      await assertTransactionCompanyScope(tx, selectedCompany);
      const transfer = parseGoldenCoastPhase7TransferInput({
        companyId: selectedCompany,
        parentCompanyId: pair.hadiCompanyId,
        body: req.body,
      });

      // Serialize every Phase 7 settlement for the Golden Coast company, then
      // serialize this client request specifically. Different request IDs cannot
      // race the same collectible/outstanding balances.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`golden-coast-phase7:${selectedCompany}`}))`);
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`golden-coast-phase7:${selectedCompany}:${transfer.clientRequestId}`}))`
      );

      if (!(await isGoldenCoastCompany(tx, selectedCompany))) {
        throw new GoldenCoastPhase7RouteError(
          "Golden Coast account setup is not configured",
          "GC_PHASE7_NOT_CONFIGURED",
          409
        );
      }

      const accounts = await resolvePhase7Accounts(tx, pair);
      await assertTransactionCompanyScope(tx, pair.hadiCompanyId);
      await validateCashAccount(tx, pair.hadiCompanyId, transfer.hadiCashAccount, "hadiCashAccount");
      await assertTransactionCompanyScope(tx, pair.goldenCoastCompanyId);
      if (transfer.operation === "remit_from_hadi" && transfer.goldenCoastCashAccount) {
        await validateCashAccount(
          tx,
          pair.goldenCoastCompanyId,
          transfer.goldenCoastCashAccount,
          "goldenCoastCashAccount"
        );
      }

      const transferDigest = goldenCoastPhase7TransferDigest({ transfer, accounts });
      const replayed = await findReplayedTransfer(tx, pair, transfer, transferDigest);
      if (replayed) {
        return { replayed: true as const, transfer, plan: null, postings: replayed };
      }

      const [gcSalesCashSignedUsd, outstandingHadiCollectionsUsd] = await Promise.all([
        gcSalesCashSignedBalance(tx, selectedCompany, accounts.gcSalesCashAccountId),
        outstandingPhase7HadiCollections(tx, selectedCompany),
      ]);
      const plan = planGoldenCoastPhase7Transfer({
        transfer,
        balances: {
          gcSalesCashDebitBalanceUsd: gcSalesCashSignedUsd,
          outstandingHadiCollectionsUsd,
        },
      });

      const [goldenCoastExchangeRate, hadiExchangeRate] = await Promise.all([
        getCurrentExchangeRate(pair.goldenCoastCompanyId),
        getCurrentExchangeRate(pair.hadiCompanyId),
      ]);
      const batch = buildGoldenCoastPhase7TransferPostings({
        plan,
        accounts,
        transferDigest,
        goldenCoastExchangeRate: goldenCoastExchangeRate == null ? null : String(goldenCoastExchangeRate),
        hadiExchangeRate: hadiExchangeRate == null ? null : String(hadiExchangeRate),
        actor: {
          userId: userId ?? null,
          username: req.session.username || "unknown",
          reason: `Golden Coast Phase 7 ${transfer.operation}`,
        },
      });

      const postings: Array<{
        role: GoldenCoastPhase7PostingRole;
        voucher: PersistedPostingResult["voucher"];
        entries: PersistedPostingResult["entries"];
      }> = [];
      for (const item of batch.postings) {
        const posted = (await postBalancedVoucherTx(tx, item.request, postingDependencies)) as PersistedPostingResult;
        if (posted.replayed) {
          throw new GoldenCoastPhase7RouteError(
            `Phase 7 transfer ${transfer.clientRequestId} ${item.role} voucher was already posted unexpectedly`,
            "GC_PHASE7_IDEMPOTENCY_INCONSISTENT",
            409
          );
        }
        postings.push({ role: item.role, voucher: posted.voucher, entries: posted.entries });
      }
      // postBalancedVoucherTx leaves the transaction scoped to the company it
      // just posted for; restore Golden Coast before leaving the boundary.
      await assertTransactionCompanyScope(tx, pair.goldenCoastCompanyId);

      return { replayed: false as const, transfer, plan, postings };
    });

    logger.info("Golden Coast Phase 7 HADI transfer posted", {
      module: "golden-coast-phase7",
      companyId: selectedCompany,
      parentCompanyId: result.transfer.parentCompanyId,
      userId,
      clientRequestId: result.transfer.clientRequestId,
      operation: result.transfer.operation,
      amountUsd: result.transfer.amountUsd,
      replayed: result.replayed,
      voucherIds: result.postings.map((item) => item.voucher.id),
      durationMs: Date.now() - startedAt,
    });

    res.json({
      clientRequestId: result.transfer.clientRequestId,
      operation: result.transfer.operation,
      amountUsd: result.transfer.amountUsd,
      transferDate: result.transfer.transferDate,
      parentCompanyId: result.transfer.parentCompanyId,
      replayed: result.replayed,
      balances: result.plan
        ? {
            gcSalesCashPayableBeforeUsd: result.plan.gcSalesCashPayableBeforeUsd,
            gcSalesCashPayableAfterUsd: result.plan.gcSalesCashPayableAfterUsd,
            outstandingHadiCollectionsBeforeUsd: result.plan.outstandingHadiCollectionsBeforeUsd,
            outstandingHadiCollectionsAfterUsd: result.plan.outstandingHadiCollectionsAfterUsd,
          }
        : null,
      postings: result.postings.map((item) => ({ role: item.role, voucher: item.voucher, entries: item.entries })),
    });
  } catch (error: unknown) {
    logger.error("Golden Coast Phase 7 HADI transfer failed", {
      module: "golden-coast-phase7",
      companyId,
      userId,
      durationMs: Date.now() - startedAt,
      error,
    });
    if (respondKnownError(res, error)) return;
    res.status(500).json({ message: getErrorMessage(error) });
  }
}

export function registerSpGoldenCoastPhase7HadiTransferRoutes(app: Express): void {
  app.get(
    "/api/sp/golden-coast/phase7/sales-cash-transfer/readiness",
    privilegedReadRateLimit,
    requireAuth,
    requireNonPOS,
    (req, res) => void handleReadiness(req, res)
  );
  // The path contains `sales`, so SP access control maps this POST to the
  // existing `sp_sales_create` permission. The explicit requireNonPOS gate keeps
  // cross-company cash movement out of POS-role sessions.
  app.post(
    "/api/sp/golden-coast/phase7/sales-cash-transfer",
    privilegedMutationRateLimit,
    phase7RequestBudget,
    requireAuth,
    requireNonPOS,
    (req, res) => void handlePostTransfer(req, res)
  );
}
