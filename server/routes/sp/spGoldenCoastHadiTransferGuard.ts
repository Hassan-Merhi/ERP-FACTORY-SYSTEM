import type { Express, NextFunction, Request, Response } from "express";
import Decimal from "decimal.js";
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
import { privilegedMutationRateLimit, privilegedRequestBudget } from "../../middleware/privilegedEndpointSecurity";
import {
  PostingValidationError,
  postBalancedVoucherTx,
  type CentralPostingResult,
} from "../../services/accounting/centralPostingEngine";
import { createDatabasePostingDependencies } from "../../services/accounting/databasePostingDependencies";
import { GOLDEN_COAST_FRESH_START_HADI_PAYMENT_SOURCE_TYPE } from "../../services/accounting/goldenCoastFreshStartHadiPayment";
import { getGoldenCoastAccountDefinition } from "../../services/accounting/goldenCoastAccounts";
import {
  GOLDEN_COAST_PHASE7_SOURCE_TYPE,
  GoldenCoastPhase7TransferError,
  buildGoldenCoastPhase7TransferPostings,
  goldenCoastPhase7IdempotencyKey,
  goldenCoastPhase7SourceId,
  goldenCoastPhase7TransferDigest,
  parseGoldenCoastPhase7TransferInput,
  planGoldenCoastPhase7Transfer,
  type GoldenCoastPhase7CashAccount,
  type GoldenCoastPhase7PostingRole,
  type GoldenCoastPhase7RoleAccounts,
  type GoldenCoastPhase7TransferInput,
} from "../../services/accounting/goldenCoastHadiTransfer";
import { getCompanyRequestRuntimeContext } from "../../services/security/companyRequestRuntimeContext";
import { assertTransactionCompanyScope } from "../../services/security/transactionCompanyScope";
import { getCurrentExchangeRate } from "../helpers/exchangeRateHelpers";
import { isGoldenCoastCompany } from "./spGoldenCoastCutoverFifoRoutes";
import { requireSpCompany } from "./spHelpers";

export const GOLDEN_COAST_PHASE16_LEGACY_HADI_PATH = "/api/sp/golden-coast/phase7/sales-cash-transfer";
export const GOLDEN_COAST_PHASE16_LEGACY_HADI_RETIRED_CODE = "GC_PHASE16_LEGACY_HADI_TRANSFER_RETIRED";

const postingDependencies = createDatabasePostingDependencies();
const phase16RequestBudget = privilegedRequestBudget({ maxBodyBytes: 16 * 1024, maxCollectionItems: 10 });
type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type PersistedPostingResult = CentralPostingResult<typeof vouchers.$inferSelect, typeof voucherEntries.$inferSelect>;

type CompanyPair = {
  goldenCoastCompanyId: number;
  goldenCoastCompanyName: string;
  hadiCompanyId: number;
  hadiCompanyName: string;
};

class GoldenCoastPhase16HadiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number
  ) {
    super(releaseDebtEnglish(message));
    this.name = "GoldenCoastPhase16HadiError";
  }
}

export function goldenCoastPhase16LegacyHadiRetiredPayload() {
  return {
    code: GOLDEN_COAST_PHASE16_LEGACY_HADI_RETIRED_CODE,
    message: releaseDebtEnglish(
      "Manual HADI collection is retired because Golden Coast sales already route to HADI automatically. Use Pay Fresh Start from HADI to settle the GC Sales Cash payable. HADI remittance back to Golden Coast remains available for proceeds that HADI still holds."
    ),
  };
}

async function resolvePair(tx: DatabaseTransaction, companyId: number): Promise<CompanyPair> {
  await assertTransactionCompanyScope(tx, companyId);
  const [gc] = await tx
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
    throw new GoldenCoastPhase16HadiError(
      "Golden Coast company is missing or inactive",
      "GC_PHASE16_COMPANY_INVALID",
      409
    );
  const hadiCompanyId = Number(gc.parentCompanyId ?? 0);
  if (!Number.isInteger(hadiCompanyId) || hadiCompanyId <= 0 || hadiCompanyId === companyId) {
    throw new GoldenCoastPhase16HadiError(
      "Golden Coast must have a distinct active HADI parent company",
      "GC_PHASE16_PARENT_INVALID",
      409
    );
  }
  await assertTransactionCompanyScope(tx, hadiCompanyId);
  const [hadi] = await tx
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    .where(and(eq(companies.id, hadiCompanyId), eq(companies.active, true)))
    .limit(1);
  await assertTransactionCompanyScope(tx, companyId);
  if (!hadi)
    throw new GoldenCoastPhase16HadiError(
      "Configured HADI company is missing or inactive",
      "GC_PHASE16_PARENT_INVALID",
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
    throw new GoldenCoastPhase16HadiError(
      `HADI company ${pair.hadiCompanyId} is not authorized for this request; send targetCompanyId=${pair.hadiCompanyId}`,
      "GC_PHASE16_HADI_SCOPE_UNAUTHORIZED",
      403
    );
  }
}

async function singleLedgerAccount(
  tx: DatabaseTransaction,
  companyId: number,
  subType: string,
  label: string,
  acceptedAccountTypes: readonly string[]
): Promise<{ id: number; name: string }> {
  await assertTransactionCompanyScope(tx, companyId);
  const rows = await tx
    .select({ id: ledgerAccounts.id, name: ledgerAccounts.name, accountType: ledgerAccounts.accountType })
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
  if (rows.length !== 1 || !acceptedAccountTypes.includes(rows[0].accountType)) {
    throw new GoldenCoastPhase16HadiError(
      `${label} is missing, ambiguous, or has the wrong account type`,
      "GC_PHASE16_ACCOUNT_INVALID",
      409
    );
  }
  return { id: Number(rows[0].id), name: String(rows[0].name) };
}

async function resolveAccounts(tx: DatabaseTransaction, pair: CompanyPair): Promise<GoldenCoastPhase7RoleAccounts> {
  const gcSalesDefinition = getGoldenCoastAccountDefinition("gc_sales_cash");
  const gcSalesCash = await singleLedgerAccount(
    tx,
    pair.goldenCoastCompanyId,
    gcSalesDefinition.subType,
    "GC Sales Cash",
    gcSalesDefinition.acceptedAccountTypes
  );
  const gcHadi = await singleLedgerAccount(
    tx,
    pair.goldenCoastCompanyId,
    "sp_hadi_intercompany",
    "Golden Coast HADI intercompany",
    ["Intercompany"]
  );
  const hadiGc = await singleLedgerAccount(
    tx,
    pair.hadiCompanyId,
    "hadi_sp_intercompany",
    "HADI Golden Coast intercompany",
    ["Intercompany"]
  );
  await assertTransactionCompanyScope(tx, pair.goldenCoastCompanyId);
  return {
    gcSalesCashAccountId: gcSalesCash.id,
    goldenCoastHadiIntercompanyAccountId: gcHadi.id,
    hadiGoldenCoastIntercompanyAccountId: hadiGc.id,
  };
}

async function validateCashAccount(
  tx: DatabaseTransaction,
  companyId: number,
  account: GoldenCoastPhase7CashAccount,
  label: string
): Promise<void> {
  await assertTransactionCompanyScope(tx, companyId);
  if (account.kind === "bank") {
    const [row] = await tx
      .select({ id: bankAccounts.id })
      .from(bankAccounts)
      .where(
        and(
          eq(bankAccounts.id, account.id),
          eq(bankAccounts.companyId, companyId),
          eq(bankAccounts.active, true),
          isNull(bankAccounts.deletedAt)
        )
      )
      .limit(1);
    if (!row) throw new GoldenCoastPhase16HadiError(`${label} is unavailable`, "GC_PHASE16_CASH_INVALID", 400);
    return;
  }
  const [row] = await tx
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.id, account.id),
        eq(ledgerAccounts.companyId, companyId),
        inArray(ledgerAccounts.accountType, ["Cash", "Bank"]),
        eq(ledgerAccounts.active, true),
        isNull(ledgerAccounts.deletedAt)
      )
    )
    .limit(1);
  if (!row) throw new GoldenCoastPhase16HadiError(`${label} is unavailable`, "GC_PHASE16_CASH_INVALID", 400);
}

async function debitBalance(tx: DatabaseTransaction, companyId: number, accountId: number): Promise<Decimal> {
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
  const raw = String(resultRows(result)[0]?.balance ?? "0");
  const parsed = new Decimal(raw);
  if (!parsed.isFinite())
    throw new GoldenCoastPhase16HadiError("HADI intercompany balance is invalid", "GC_PHASE16_BALANCE_INVALID", 409);
  return parsed;
}

/**
 * Sale-time HADI collections use the Phase 7 source type. Phase 16 remittance
 * must subtract both earlier remittances and any direct HADI→Fresh Start
 * payments, because both consume the same pool of HADI-held Golden Coast sale
 * proceeds. Phase 10 direct GC payment intentionally does not reduce this pool.
 */
async function trackedHadiSalesCash(tx: DatabaseTransaction, companyId: number): Promise<Decimal> {
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
  const parsed = new Decimal(String(resultRows(result)[0]?.outstanding ?? "0"));
  if (!parsed.isFinite() || parsed.lt(0)) {
    throw new GoldenCoastPhase16HadiError("Tracked HADI sales cash is invalid", "GC_PHASE16_BALANCE_INVALID", 409);
  }
  return parsed;
}

function amountEquals(left: unknown, right: unknown): boolean {
  try {
    return new Decimal(String(left ?? "0")).eq(new Decimal(String(right ?? "0")));
  } catch {
    return false;
  }
}

function entryMatchesCashTarget(
  entry: typeof voucherEntries.$inferSelect,
  account: GoldenCoastPhase7CashAccount
): boolean {
  return account.kind === "bank"
    ? Number(entry.bankAccountId ?? 0) === account.id
    : Number(entry.ledgerAccountId ?? 0) === account.id;
}

async function findReplay(
  tx: DatabaseTransaction,
  pair: CompanyPair,
  transfer: GoldenCoastPhase7TransferInput,
  accounts: GoldenCoastPhase7RoleAccounts,
  digest: string
): Promise<Array<{
  role: GoldenCoastPhase7PostingRole;
  voucher: typeof vouchers.$inferSelect;
  entries: (typeof voucherEntries.$inferSelect)[];
}> | null> {
  const roles: Array<{ role: GoldenCoastPhase7PostingRole; companyId: number }> = [
    { role: "golden_coast", companyId: pair.goldenCoastCompanyId },
    { role: "hadi", companyId: pair.hadiCompanyId },
  ];
  const found: Array<{
    role: GoldenCoastPhase7PostingRole;
    companyId: number;
    voucher: typeof vouchers.$inferSelect;
    entries: (typeof voucherEntries.$inferSelect)[];
  }> = [];
  let markers = 0;

  for (const item of roles) {
    await assertTransactionCompanyScope(tx, item.companyId);
    const key = goldenCoastPhase7IdempotencyKey(pair.goldenCoastCompanyId, transfer.clientRequestId, item.role);
    const [marker] = await tx
      .select({ voucherId: accountingPostingRequests.voucherId, sourceId: accountingPostingRequests.sourceId })
      .from(accountingPostingRequests)
      .where(
        and(eq(accountingPostingRequests.companyId, item.companyId), eq(accountingPostingRequests.idempotencyKey, key))
      )
      .limit(1);
    if (!marker) continue;
    markers += 1;
    if (String(marker.sourceId) !== goldenCoastPhase7SourceId("remit_from_hadi", digest, item.role)) {
      throw new GoldenCoastPhase16HadiError(
        "clientRequestId was already used for different HADI remittance routing",
        "GC_PHASE16_IDEMPOTENCY_CONFLICT",
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
    if (!voucher || !amountEquals(voucher.totalAmount, transfer.amountUsd)) {
      throw new GoldenCoastPhase16HadiError(
        "HADI remittance replay marker points to a missing or altered voucher",
        "GC_PHASE16_IDEMPOTENCY_INCONSISTENT",
        409
      );
    }
    const entries = await tx.select().from(voucherEntries).where(eq(voucherEntries.voucherId, voucher.id));
    if (entries.length !== 2) {
      throw new GoldenCoastPhase16HadiError(
        "HADI remittance replay voucher entries were altered",
        "GC_PHASE16_IDEMPOTENCY_INCONSISTENT",
        409
      );
    }
    const amount = transfer.amountUsd;
    if (item.role === "golden_coast") {
      const cashDebit = entries.find(
        (entry) =>
          transfer.goldenCoastCashAccount != null &&
          entryMatchesCashTarget(entry, transfer.goldenCoastCashAccount) &&
          amountEquals(entry.debitAmount, amount) &&
          amountEquals(entry.creditAmount, "0")
      );
      const icCredit = entries.find(
        (entry) =>
          Number(entry.ledgerAccountId ?? 0) === accounts.goldenCoastHadiIntercompanyAccountId &&
          amountEquals(entry.debitAmount, "0") &&
          amountEquals(entry.creditAmount, amount)
      );
      if (!cashDebit || !icCredit) {
        throw new GoldenCoastPhase16HadiError(
          "Golden Coast remittance replay entries were altered",
          "GC_PHASE16_IDEMPOTENCY_INCONSISTENT",
          409
        );
      }
    } else {
      const icDebit = entries.find(
        (entry) =>
          Number(entry.ledgerAccountId ?? 0) === accounts.hadiGoldenCoastIntercompanyAccountId &&
          amountEquals(entry.debitAmount, amount) &&
          amountEquals(entry.creditAmount, "0")
      );
      const cashCredit = entries.find(
        (entry) =>
          entryMatchesCashTarget(entry, transfer.hadiCashAccount) &&
          amountEquals(entry.debitAmount, "0") &&
          amountEquals(entry.creditAmount, amount)
      );
      if (!icDebit || !cashCredit) {
        throw new GoldenCoastPhase16HadiError(
          "HADI remittance replay entries were altered",
          "GC_PHASE16_IDEMPOTENCY_INCONSISTENT",
          409
        );
      }
    }
    found.push({ role: item.role, companyId: item.companyId, voucher, entries });
  }

  await assertTransactionCompanyScope(tx, pair.goldenCoastCompanyId);
  if (markers === 0) return null;
  if (markers !== roles.length) {
    throw new GoldenCoastPhase16HadiError(
      "HADI remittance has a partial cross-company replay pair",
      "GC_PHASE16_IDEMPOTENCY_INCONSISTENT",
      409
    );
  }
  return found.map(({ role, voucher, entries }) => ({ role, voucher, entries }));
}

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
