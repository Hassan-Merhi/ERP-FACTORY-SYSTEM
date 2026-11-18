import type { Express, Request, Response } from "express";
import { and, eq, isNull, sql } from "drizzle-orm";
import { accountingPostingRequests, voucherEntries, vouchers } from "@shared/schema";
import { requireAuth, requireNonPOS } from "../../auth";
import { db } from "../../db";
import { releaseDebtEnglish } from "../../i18n/finalCloseoutEnglish";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { privilegedMutationRateLimit, privilegedReadRateLimit } from "../../middleware/privilegedEndpointSecurity";
import { PostingValidationError, postBalancedVoucherTx } from "../../services/accounting/centralPostingEngine";
import {
  GoldenCoastFreshStartHadiPaymentError,
  buildGoldenCoastFreshStartHadiPaymentPostings,
  goldenCoastFreshStartHadiPaymentDigest,
  goldenCoastFreshStartHadiPaymentIdempotencyKey,
  parseGoldenCoastFreshStartHadiPayment,
  planGoldenCoastFreshStartHadiPayment,
  type GoldenCoastFreshStartHadiPaymentAccounts,
  type GoldenCoastFreshStartHadiPaymentInput,
} from "../../services/accounting/goldenCoastFreshStartHadiPayment";
import { assertTransactionCompanyScope } from "../../services/security/transactionCompanyScope";
import { getCurrentExchangeRate } from "../helpers/exchangeRateHelpers";
import { isGoldenCoastCompany } from "./spGoldenCoastPhase4CutoverFifoRoutes";
import { requireSpCompany } from "./spHelpers";
import {
  FreshStartHadiRouteError,
  assertHadiAuthorized,
  debitBalance,
  listHadiCashAccounts,
  outstandingHadiSalesCash,
  postingDependencies,
  requestBudget,
  resolveAccounts,
  resolvePair,
  validateHadiCashAccount,
  type CompanyPair,
  type DatabaseTransaction,
  type PersistedPostingResult,
} from "./spGoldenCoastFreshStartHadiPaymentRoutesResolvePair";

async function findReplay(
  tx: DatabaseTransaction,
  pair: CompanyPair,
  payment: GoldenCoastFreshStartHadiPaymentInput,
  digest: string
) {
  const roles = [
    { role: "golden_coast" as const, companyId: pair.goldenCoastCompanyId },
    { role: "hadi" as const, companyId: pair.hadiCompanyId },
  ];
  const found: Array<{
    role: "golden_coast" | "hadi";
    companyId: number;
    voucher: typeof vouchers.$inferSelect;
    entries: (typeof voucherEntries.$inferSelect)[];
  }> = [];
  let markersFound = 0;
  for (const item of roles) {
    await assertTransactionCompanyScope(tx, item.companyId);
    const key = goldenCoastFreshStartHadiPaymentIdempotencyKey(
      pair.goldenCoastCompanyId,
      payment.clientRequestId,
      item.role
    );
    const [marker] = await tx
      .select({
        voucherId: accountingPostingRequests.voucherId,
        sourceId: accountingPostingRequests.sourceId,
      })
      .from(accountingPostingRequests)
      .where(
        and(eq(accountingPostingRequests.companyId, item.companyId), eq(accountingPostingRequests.idempotencyKey, key))
      )
      .limit(1);
    if (!marker) continue;
    markersFound += 1;
    if (String(marker.sourceId) !== `payment:${digest}:${item.role}`) {
      throw new FreshStartHadiRouteError(
        "clientRequestId was already used for a different Fresh Start payment",
        "GC_FS_HADI_IDEMPOTENCY_CONFLICT",
        409
      );
    }
    const [voucher] = await tx
      .select()
      .from(vouchers)
      .where(
        and(
          eq(vouchers.id, Number(marker.voucherId)),
          eq(vouchers.companyId, item.companyId),
          isNull(vouchers.deletedAt)
        )
      )
      .limit(1);
    if (!voucher) {
      throw new FreshStartHadiRouteError(
        "Fresh Start payment replay marker points to a missing voucher",
        "GC_FS_HADI_IDEMPOTENCY_INCONSISTENT",
        409
      );
    }
    const entries = await tx.select().from(voucherEntries).where(eq(voucherEntries.voucherId, voucher.id));
    found.push({ ...item, voucher, entries });
  }
  await assertTransactionCompanyScope(tx, pair.goldenCoastCompanyId);
  if (markersFound === 0) return null;
  if (markersFound !== roles.length) {
    throw new FreshStartHadiRouteError(
      "Fresh Start payment has a partial cross-company replay pair",
      "GC_FS_HADI_IDEMPOTENCY_INCONSISTENT",
      409
    );
  }
  return found;
}

async function balancesForPayment(
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

async function handleReadiness(req: Request, res: Response): Promise<void> {
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

async function handlePayment(req: Request, res: Response): Promise<void> {
  const startedAt = Date.now();
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

    const outcome = await db.transaction(async (tx) => {
      const pair = await resolvePair(tx, companyId);
      assertHadiAuthorized(pair);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`golden-coast-phase7:${companyId}`}))`);
      const rawRequestId = typeof req.body?.clientRequestId === "string" ? req.body.clientRequestId : "";
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`golden-coast-fresh-start-hadi:${companyId}:${rawRequestId}`}))`
      );
      const payment = parseGoldenCoastFreshStartHadiPayment({
        companyId,
        hadiCompanyId: pair.hadiCompanyId,
        body: req.body,
      });
      const accounts = await resolveAccounts(tx, pair);
      const digest = goldenCoastFreshStartHadiPaymentDigest({
        payment,
        accounts: accounts.ids,
      });
      const replayed = await findReplay(tx, pair, payment, digest);
      if (replayed)
        return {
          replayed: true as const,
          pair,
          payment,
          plan: null,
          postings: replayed,
        };

      await validateHadiCashAccount(tx, pair.hadiCompanyId, payment.hadiCashAccount);
      await assertTransactionCompanyScope(tx, pair.goldenCoastCompanyId);
      const balances = await balancesForPayment(tx, companyId, accounts.ids);
      const plan = planGoldenCoastFreshStartHadiPayment({
        payment,
        ...balances,
      });
      const [goldenCoastExchangeRate, hadiExchangeRate] = await Promise.all([
        getCurrentExchangeRate(pair.goldenCoastCompanyId),
        getCurrentExchangeRate(pair.hadiCompanyId),
      ]);
      const batch = buildGoldenCoastFreshStartHadiPaymentPostings({
        plan,
        accounts: accounts.ids,
        digest,
        goldenCoastExchangeRate: goldenCoastExchangeRate == null ? null : String(goldenCoastExchangeRate),
        hadiExchangeRate: hadiExchangeRate == null ? null : String(hadiExchangeRate),
        actor: {
          userId: req.session.userId ?? null,
          username: req.session.username || "unknown",
          reason: "HADI payment to Fresh Start on behalf of Golden Coast",
        },
      });
      const postings: Array<{
        role: "golden_coast" | "hadi";
        voucher: PersistedPostingResult["voucher"];
        entries: PersistedPostingResult["entries"];
      }> = [];
      for (const item of batch) {
        const markerCompanyId = item.role === "golden_coast" ? pair.goldenCoastCompanyId : pair.hadiCompanyId;
        await assertTransactionCompanyScope(tx, markerCompanyId);
        const posted = (await postBalancedVoucherTx(tx, item.request, postingDependencies)) as PersistedPostingResult;
        if (posted.replayed) {
          throw new FreshStartHadiRouteError(
            "Fresh Start payment replayed unexpectedly during a new transaction",
            "GC_FS_HADI_IDEMPOTENCY_INCONSISTENT",
            409
          );
        }
        postings.push({
          role: item.role,
          voucher: posted.voucher,
          entries: posted.entries,
        });
      }
      await assertTransactionCompanyScope(tx, pair.goldenCoastCompanyId);
      return { replayed: false as const, pair, payment, plan, postings };
    });

    logger.info("Golden Coast Fresh Start payment from HADI posted", {
      companyId,
      hadiCompanyId: outcome.pair.hadiCompanyId,
      clientRequestId: outcome.payment.clientRequestId,
      amountUsd: outcome.payment.amountUsd,
      replayed: outcome.replayed,
      durationMs: Date.now() - startedAt,
    });
    res.status(outcome.replayed ? 200 : 201).json({
      ok: true,
      replayed: outcome.replayed,
      amountUsd: outcome.payment.amountUsd,
      paymentDate: outcome.payment.paymentDate,
      balances: outcome.plan
        ? {
            gcSalesCashPayableAfterUsd: outcome.plan.gcSalesCashPayableAfterUsd,
            outstandingHadiSalesCashAfterUsd: outcome.plan.outstandingHadiSalesCashAfterUsd,
            hadiIntercompanyAssetAfterUsd: outcome.plan.hadiIntercompanyAssetAfterUsd,
          }
        : null,
      postings: outcome.postings.map((item) => ({
        role: item.role,
        voucher: item.voucher,
        entries: item.entries,
      })),
    });
  } catch (error) {
    logger.error("Golden Coast Fresh Start payment from HADI failed", {
      error,
    });
    if (error instanceof FreshStartHadiRouteError) {
      res.status(error.status).json({ code: error.code, message: error.message });
      return;
    }
    if (error instanceof GoldenCoastFreshStartHadiPaymentError) {
      res.status(error.code === "GC_FRESH_START_HADI_PAYMENT_EXCEEDS_AVAILABLE" ? 409 : 400).json({
        code: error.code,
        message: error.message,
      });
      return;
    }
    if (error instanceof PostingValidationError) {
      res
        .status(error.code === "POSTING_IDEMPOTENCY_CORRUPT" ? 409 : 400)
        .json({ code: error.code, message: error.message });
      return;
    }
    res.status(500).json({ message: getErrorMessage(error) });
  }
}

export function registerSpGoldenCoastFreshStartHadiPaymentRoutes(app: Express): void {
  app.get(
    "/api/sp/golden-coast/phase7/sales-cash-pay-fresh-start/readiness",
    privilegedReadRateLimit,
    requireAuth,
    requireNonPOS,
    (req, res) => void handleReadiness(req, res)
  );
  app.post(
    "/api/sp/golden-coast/phase7/sales-cash-pay-fresh-start",
    privilegedMutationRateLimit,
    requestBudget,
    requireAuth,
    requireNonPOS,
    (req, res) => void handlePayment(req, res)
  );
}
