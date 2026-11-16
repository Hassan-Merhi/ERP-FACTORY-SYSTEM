import type { Express, Request, Response } from "express";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  accountingPostingRequests,
  bankAccounts,
  companies,
  ledgerAccounts,
  voucherEntries,
  vouchers,
} from "@shared/schema";
import { requireAuth, requireNonPOS } from "../../auth";
import { db } from "../../db";
import { releaseDebtEnglish } from "../../i18n/finalCloseoutEnglish";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { resultRows } from "../../lib/queryResult";
import {
  privilegedMutationRateLimit,
  privilegedReadRateLimit,
  privilegedRequestBudget,
} from "../../middleware/privilegedEndpointSecurity";
import {
  PostingValidationError,
  postBalancedVoucherTx,
  type CentralPostingResult,
} from "../../services/accounting/centralPostingEngine";
import { createDatabasePostingDependencies } from "../../services/accounting/databasePostingDependencies";
import {
  GOLDEN_COAST_FRESH_START_HADI_PAYMENT_SOURCE_TYPE,
  GoldenCoastFreshStartHadiPaymentError,
  buildGoldenCoastFreshStartHadiPaymentPostings,
  goldenCoastFreshStartHadiPaymentDigest,
  goldenCoastFreshStartHadiPaymentIdempotencyKey,
  parseGoldenCoastFreshStartHadiPayment,
  planGoldenCoastFreshStartHadiPayment,
  type GoldenCoastFreshStartHadiCashAccount,
  type GoldenCoastFreshStartHadiPaymentAccounts,
  type GoldenCoastFreshStartHadiPaymentInput,
} from "../../services/accounting/goldenCoastFreshStartHadiPayment";
import { GOLDEN_COAST_PHASE7_SOURCE_TYPE } from "../../services/accounting/goldenCoastHadiTransfer";
import { getCompanyRequestRuntimeContext } from "../../services/security/companyRequestRuntimeContext";
import { assertTransactionCompanyScope } from "../../services/security/transactionCompanyScope";
import { getCurrentExchangeRate } from "../helpers/exchangeRateHelpers";
import { isGoldenCoastCompany } from "./spGoldenCoastCutoverFifoRoutes";
import { requireSpCompany } from "./spHelpers";

const postingDependencies = createDatabasePostingDependencies();
const requestBudget = privilegedRequestBudget({
  maxBodyBytes: 16 * 1024,
  maxCollectionItems: 10,
});

type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbLike = typeof db | DatabaseTransaction;
type PersistedPostingResult = CentralPostingResult<typeof vouchers.$inferSelect, typeof voucherEntries.$inferSelect>;

class FreshStartHadiRouteError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number
  ) {
    super(message);
    this.name = "FreshStartHadiRouteError";
  }
}

interface CompanyPair {
  goldenCoastCompanyId: number;
  goldenCoastCompanyName: string;
  hadiCompanyId: number;
  hadiCompanyName: string;
}

async function resolvePair(conn: DbLike, companyId: number): Promise<CompanyPair> {
  const [gc] = await conn
    .select({
      id: companies.id,
      name: companies.name,
      parentCompanyId: companies.parentCompanyId,
      active: companies.active,
    })
    .from(companies)
    .where(and(eq(companies.id, companyId), eq(companies.active, true)))
    .limit(1);
  if (!gc)
    throw new FreshStartHadiRouteError(
      "Golden Coast company is missing or inactive",
      "GC_FS_HADI_COMPANY_INVALID",
      409
    );
  const hadiCompanyId = Number(gc.parentCompanyId ?? 0);
  if (!Number.isInteger(hadiCompanyId) || hadiCompanyId <= 0 || hadiCompanyId === companyId) {
    throw new FreshStartHadiRouteError(
      "Golden Coast must have a distinct active HADI parent company",
      "GC_FS_HADI_PARENT_INVALID",
      409
    );
  }
  const [hadi] = await conn
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    .where(and(eq(companies.id, hadiCompanyId), eq(companies.active, true)))
    .limit(1);
  if (!hadi)
    throw new FreshStartHadiRouteError(
      "Configured HADI company is missing or inactive",
      "GC_FS_HADI_PARENT_INVALID",
      409
    );
  return {
    goldenCoastCompanyId: Number(gc.id),
    goldenCoastCompanyName: String(gc.name),
    hadiCompanyId: Number(hadi.id),
    hadiCompanyName: String(hadi.name),
  };
}

function assertHadiAuthorized(pair: CompanyPair): void {
  const context = getCompanyRequestRuntimeContext();
  if (!context?.authorizedCompanyIds?.includes(pair.hadiCompanyId)) {
    throw new FreshStartHadiRouteError(
      `HADI company ${pair.hadiCompanyId} is not authorized for this request; send targetCompanyId=${pair.hadiCompanyId}`,
      "GC_FS_HADI_SCOPE_UNAUTHORIZED",
      403
    );
  }
}

async function singleLedgerAccount(
  tx: DatabaseTransaction,
  companyId: number,
  subType: string,
  accountType: string,
  label: string
): Promise<{ id: number; name: string }> {
  await assertTransactionCompanyScope(tx, companyId);
  const rows = await tx
    .select({
      id: ledgerAccounts.id,
      name: ledgerAccounts.name,
      accountType: ledgerAccounts.accountType,
    })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.companyId, companyId),
        eq(ledgerAccounts.subType, subType),
        eq(ledgerAccounts.active, true),
        isNull(ledgerAccounts.deletedAt)
      )
    )
    .orderBy(asc(ledgerAccounts.id))
    .limit(2);
  if (rows.length !== 1 || rows[0].accountType !== accountType) {
    throw new FreshStartHadiRouteError(
      `${label} is missing, ambiguous, or has the wrong account type`,
      "GC_FS_HADI_ACCOUNT_INVALID",
      409
    );
  }
  return { id: Number(rows[0].id), name: String(rows[0].name) };
}

async function resolveAccounts(tx: DatabaseTransaction, pair: CompanyPair) {
  const gcSalesCash = await singleLedgerAccount(
    tx,
    pair.goldenCoastCompanyId,
    "sp_payable",
    "Liability",
    "GC Sales Cash"
  );
  const gcHadi = await singleLedgerAccount(
    tx,
    pair.goldenCoastCompanyId,
    "sp_hadi_intercompany",
    "Intercompany",
    "Golden Coast HADI intercompany"
  );
  const hadiGc = await singleLedgerAccount(
    tx,
    pair.hadiCompanyId,
    "hadi_sp_intercompany",
    "Intercompany",
    "HADI Golden Coast intercompany"
  );
  await assertTransactionCompanyScope(tx, pair.goldenCoastCompanyId);
  return {
    ids: {
      gcSalesCashAccountId: gcSalesCash.id,
      goldenCoastHadiIntercompanyAccountId: gcHadi.id,
      hadiGoldenCoastIntercompanyAccountId: hadiGc.id,
    } satisfies GoldenCoastFreshStartHadiPaymentAccounts,
    names: {
      gcSalesCash: gcSalesCash.name,
      goldenCoastHadiIntercompany: gcHadi.name,
      hadiGoldenCoastIntercompany: hadiGc.name,
    },
  };
}

async function listHadiCashAccounts(tx: DatabaseTransaction, hadiCompanyId: number) {
  await assertTransactionCompanyScope(tx, hadiCompanyId);
  const [ledgerRows, bankRows] = await Promise.all([
    tx
      .select({
        id: ledgerAccounts.id,
        name: ledgerAccounts.name,
        accountType: ledgerAccounts.accountType,
      })
      .from(ledgerAccounts)
      .where(
        and(
          eq(ledgerAccounts.companyId, hadiCompanyId),
          inArray(ledgerAccounts.accountType, ["Cash", "Bank"]),
          eq(ledgerAccounts.active, true),
          isNull(ledgerAccounts.deletedAt)
        )
      )
      .orderBy(asc(ledgerAccounts.name)),
    tx
      .select({ id: bankAccounts.id, name: bankAccounts.name })
      .from(bankAccounts)
      .where(
        and(eq(bankAccounts.companyId, hadiCompanyId), eq(bankAccounts.active, true), isNull(bankAccounts.deletedAt))
      )
      .orderBy(asc(bankAccounts.name)),
  ]);
  return [
    ...ledgerRows.map((row) => ({
      kind: "ledger" as const,
      id: Number(row.id),
      name: String(row.name),
      type: row.accountType,
    })),
    ...bankRows.map((row) => ({
      kind: "bank" as const,
      id: Number(row.id),
      name: String(row.name),
      type: "Bank Account",
    })),
  ];
}

async function validateHadiCashAccount(
  tx: DatabaseTransaction,
  hadiCompanyId: number,
  account: GoldenCoastFreshStartHadiCashAccount
): Promise<void> {
  await assertTransactionCompanyScope(tx, hadiCompanyId);
  if (account.kind === "bank") {
    const [row] = await tx
      .select({ id: bankAccounts.id })
      .from(bankAccounts)
      .where(
        and(
          eq(bankAccounts.id, account.id),
          eq(bankAccounts.companyId, hadiCompanyId),
          eq(bankAccounts.active, true),
          isNull(bankAccounts.deletedAt)
        )
      )
      .limit(1);
    if (!row)
      throw new FreshStartHadiRouteError("Selected HADI bank account is unavailable", "GC_FS_HADI_CASH_INVALID", 400);
    return;
  }
  const [row] = await tx
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.id, account.id),
        eq(ledgerAccounts.companyId, hadiCompanyId),
        inArray(ledgerAccounts.accountType, ["Cash", "Bank"]),
        eq(ledgerAccounts.active, true),
        isNull(ledgerAccounts.deletedAt)
      )
    )
    .limit(1);
  if (!row)
    throw new FreshStartHadiRouteError("Selected HADI cash account is unavailable", "GC_FS_HADI_CASH_INVALID", 400);
}

async function debitBalance(tx: DatabaseTransaction, companyId: number, accountId: number): Promise<string> {
  await assertTransactionCompanyScope(tx, companyId);
  const result = await tx.execute(sql`
    SELECT (
      CASE WHEN la.opening_balance_side = 'Cr'
        THEN -COALESCE(la.opening_balance, 0)::numeric
        ELSE COALESCE(la.opening_balance, 0)::numeric
      END
      + COALESCE((
        SELECT SUM(CAST(ve.debit_amount AS numeric) - CAST(ve.credit_amount AS numeric))
        FROM voucher_entries ve
        JOIN vouchers v ON v.id = ve.voucher_id
        WHERE ve.ledger_account_id = ${accountId}
          AND v.company_id = ${companyId}
          AND v.deleted_at IS NULL
          AND COALESCE(v.optional, false) = false
      ), 0)
    )::text AS balance
    FROM ledger_accounts la
    WHERE la.id = ${accountId}
      AND la.company_id = ${companyId}
      AND la.active = true
      AND la.deleted_at IS NULL
    LIMIT 1
  `);
  return String(resultRows(result)[0]?.balance ?? "0");
}

async function outstandingHadiSalesCash(tx: DatabaseTransaction, companyId: number): Promise<string> {
  await assertTransactionCompanyScope(tx, companyId);
  const result = await tx.execute(sql`
    SELECT GREATEST(
      COALESCE(SUM(CASE
        WHEN apr.source_type = ${GOLDEN_COAST_PHASE7_SOURCE_TYPE}
         AND split_part(apr.source_id, ':', 1) = 'collect_via_hadi'
         AND split_part(apr.source_id, ':', 3) = 'golden_coast'
        THEN CAST(v.total_amount AS numeric) ELSE 0 END), 0)
      - COALESCE(SUM(CASE
        WHEN apr.source_type = ${GOLDEN_COAST_PHASE7_SOURCE_TYPE}
         AND split_part(apr.source_id, ':', 1) = 'remit_from_hadi'
         AND split_part(apr.source_id, ':', 3) = 'golden_coast'
        THEN CAST(v.total_amount AS numeric) ELSE 0 END), 0)
      - COALESCE(SUM(CASE
        WHEN apr.source_type = ${GOLDEN_COAST_FRESH_START_HADI_PAYMENT_SOURCE_TYPE}
         AND split_part(apr.source_id, ':', 1) = 'payment'
         AND split_part(apr.source_id, ':', 3) = 'golden_coast'
        THEN CAST(v.total_amount AS numeric) ELSE 0 END), 0),
      0
    )::text AS outstanding
    FROM accounting_posting_requests apr
    JOIN vouchers v ON v.id = apr.voucher_id
    WHERE apr.company_id = ${companyId}
      AND v.company_id = ${companyId}
      AND v.deleted_at IS NULL
      AND apr.source_type IN (${GOLDEN_COAST_PHASE7_SOURCE_TYPE}, ${GOLDEN_COAST_FRESH_START_HADI_PAYMENT_SOURCE_TYPE})
  `);
  return String(resultRows(result)[0]?.outstanding ?? "0");
}

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
