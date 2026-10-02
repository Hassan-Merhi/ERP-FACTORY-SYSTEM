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
  getGoldenCoastAccountDefinition,
  type GoldenCoastAccountRole,
  type GoldenCoastLedgerRow,
} from "../../services/accounting/goldenCoastPhase2Accounts";
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
} from "../../services/accounting/goldenCoastPhase7HadiTransfer";
import { gcSalesCashPayableBalance } from "../../services/accounting/goldenCoastSalesCashPayable";
import { getCompanyRequestRuntimeContext } from "../../services/security/companyRequestRuntimeContext";
import { assertTransactionCompanyScope } from "../../services/security/transactionCompanyScope";
import { getCurrentExchangeRate } from "../helpers/exchangeRateHelpers";
import { isGoldenCoastCompany } from "./spGoldenCoastPhase4CutoverFifoRoutes";
import { loadGoldenCoastAccounts } from "./spGoldenCoastSetupRoutes";
import { requireSpCompany } from "./spHelpers";

const postingDependencies = createDatabasePostingDependencies();
const phase7RequestBudget = privilegedRequestBudget({ maxBodyBytes: 16 * 1024, maxCollectionItems: 10 });

type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbLike = typeof db | DatabaseTransaction;
type PersistedPostingResult = CentralPostingResult<typeof vouchers.$inferSelect, typeof voucherEntries.$inferSelect>;

class GoldenCoastPhase7RouteError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code = "GC_PHASE7_TRANSFER_INVALID", status = 400) {
    super(releaseDebtEnglish(message));
    this.name = "GoldenCoastPhase7RouteError";
    this.code = code;
    this.status = status;
  }
}

interface GoldenCoastPhase7CompanyPair {
  goldenCoastCompanyId: number;
  goldenCoastCompanyName: string;
  hadiCompanyId: number;
  hadiCompanyName: string;
}

interface ResolvedPhase7Accounts extends GoldenCoastPhase7RoleAccounts {
  gcSalesCashAccountName: string;
  goldenCoastHadiIntercompanyAccountName: string;
  hadiGoldenCoastIntercompanyAccountName: string;
}

/**
 * Fail-closed gate for the HADI side of a Phase 7 settlement.
 *
 * The tenant request boundary is the only component allowed to widen a request
 * past its active company: it membership-checks caller-supplied
 * `targetCompanyId` values and records the verified ids on the request runtime
 * context. Phase 7 never widens that scope itself. It only confirms the
 * boundary already authorized the company persisted as Golden Coast's
 * `parent_company_id`, so a caller can neither choose HADI nor reach it without
 * membership. Requests that omit `targetCompanyId`, or that name a different
 * company, are refused instead of being silently promoted.
 */
function assertHadiCompanyAuthorized(pair: GoldenCoastPhase7CompanyPair): void {
  const requestContext = getCompanyRequestRuntimeContext();
  if (!requestContext) {
    throw new GoldenCoastPhase7RouteError(
      "Company request context is unavailable for HADI company authorization",
      "GC_PHASE7_HADI_SCOPE_UNAUTHORIZED",
      403
    );
  }
  if (!requestContext.authorizedCompanyIds?.includes(pair.hadiCompanyId)) {
    throw new GoldenCoastPhase7RouteError(
      `HADI company ${pair.hadiCompanyId} is not authorized for this request; send targetCompanyId=${pair.hadiCompanyId} so the tenant boundary verifies membership first`,
      "GC_PHASE7_HADI_SCOPE_UNAUTHORIZED",
      403
    );
  }
}

async function resolveCompanyPair(conn: DbLike, companyId: number): Promise<GoldenCoastPhase7CompanyPair> {
  const [goldenCoast] = await conn
    .select({
      id: companies.id,
      name: companies.name,
      parentCompanyId: companies.parentCompanyId,
      active: companies.active,
    })
    .from(companies)
    .where(and(eq(companies.id, companyId), eq(companies.active, true)))
    .limit(1);

  if (!goldenCoast) {
    throw new GoldenCoastPhase7RouteError(
      "The selected Golden Coast company is missing or inactive",
      "GC_PHASE7_COMPANY_INVALID",
      409
    );
  }
  const parentCompanyId = Number(goldenCoast.parentCompanyId ?? 0);
  if (!Number.isInteger(parentCompanyId) || parentCompanyId <= 0 || parentCompanyId === companyId) {
    throw new GoldenCoastPhase7RouteError(
      "Golden Coast must have a distinct active parent company configured before HADI routing can be used",
      "GC_PHASE7_PARENT_COMPANY_INVALID",
      409
    );
  }

  const [hadi] = await conn
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    .where(and(eq(companies.id, parentCompanyId), eq(companies.active, true)))
    .limit(1);
  if (!hadi) {
    throw new GoldenCoastPhase7RouteError(
      "The configured Golden Coast parent company is missing or inactive",
      "GC_PHASE7_PARENT_COMPANY_INVALID",
      409
    );
  }

  return {
    goldenCoastCompanyId: Number(goldenCoast.id),
    goldenCoastCompanyName: String(goldenCoast.name),
    hadiCompanyId: Number(hadi.id),
    hadiCompanyName: String(hadi.name),
  };
}

function activeCanonicalGoldenCoastRole(
  accounts: readonly GoldenCoastLedgerRow[],
  companyId: number,
  role: GoldenCoastAccountRole
): GoldenCoastLedgerRow {
  const definition = getGoldenCoastAccountDefinition(role);
  const matches = accounts.filter(
    (account) =>
      Number(account.companyId) === companyId &&
      account.subType === definition.subType &&
      account.active === true &&
      account.deletedAt == null
  );
  if (matches.length !== 1) {
    throw new GoldenCoastPhase7RouteError(
      matches.length === 0
        ? `Golden Coast role ${role} is missing; run Golden Coast account setup first`
        : `Golden Coast role ${role} is ambiguous (${matches.length} active accounts share ${definition.subType})`,
      "GC_PHASE7_ACCOUNT_INVALID",
      409
    );
  }
  const account = matches[0];
  if (!definition.acceptedAccountTypes.includes(account.accountType)) {
    throw new GoldenCoastPhase7RouteError(
      `Golden Coast role ${role} has invalid account type ${account.accountType}`,
      "GC_PHASE7_ACCOUNT_INVALID",
      409
    );
  }
  return account;
}

async function activeIntercompanyAccount(
  conn: DbLike,
  companyId: number,
  subType: "sp_hadi_intercompany" | "hadi_sp_intercompany",
  label: string
): Promise<{ id: number; name: string }> {
  const rows = await conn
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

  if (rows.length !== 1) {
    throw new GoldenCoastPhase7RouteError(
      rows.length === 0
        ? `${label} is not configured for company ${companyId}`
        : `${label} is ambiguous; repair duplicate active ${subType} accounts first`,
      "GC_PHASE7_INTERCOMPANY_INVALID",
      409
    );
  }
  if (rows[0].accountType !== "Intercompany") {
    throw new GoldenCoastPhase7RouteError(
      `${label} must have account type Intercompany, not ${rows[0].accountType}`,
      "GC_PHASE7_INTERCOMPANY_INVALID",
      409
    );
  }
  return { id: Number(rows[0].id), name: String(rows[0].name) };
}

async function resolvePhase7Accounts(
  tx: DatabaseTransaction,
  pair: GoldenCoastPhase7CompanyPair
): Promise<ResolvedPhase7Accounts> {
  // Each side is read under its own PostgreSQL tenant scope, and the Golden
  // Coast scope is restored before the caller continues. Sequential switching
  // is required: the two sides cannot share one transaction-local scope.
  await assertTransactionCompanyScope(tx, pair.goldenCoastCompanyId);
  const goldenCoastAccounts = await loadGoldenCoastAccounts(tx, pair.goldenCoastCompanyId);
  const gcSalesCash = activeCanonicalGoldenCoastRole(goldenCoastAccounts, pair.goldenCoastCompanyId, "gc_sales_cash");
  const goldenCoastIntercompany = await activeIntercompanyAccount(
    tx,
    pair.goldenCoastCompanyId,
    "sp_hadi_intercompany",
    "Golden Coast HADI intercompany account"
  );

  await assertTransactionCompanyScope(tx, pair.hadiCompanyId);
  const hadiIntercompany = await activeIntercompanyAccount(
    tx,
    pair.hadiCompanyId,
    "hadi_sp_intercompany",
    "HADI Golden Coast intercompany account"
  );
  await assertTransactionCompanyScope(tx, pair.goldenCoastCompanyId);

  return {
    gcSalesCashAccountId: gcSalesCash.id,
    gcSalesCashAccountName: gcSalesCash.name,
    goldenCoastHadiIntercompanyAccountId: goldenCoastIntercompany.id,
    goldenCoastHadiIntercompanyAccountName: goldenCoastIntercompany.name,
    hadiGoldenCoastIntercompanyAccountId: hadiIntercompany.id,
    hadiGoldenCoastIntercompanyAccountName: hadiIntercompany.name,
  };
}

async function validateCashAccount(
  conn: DbLike,
  companyId: number,
  account: GoldenCoastPhase7CashAccount,
  label: string
): Promise<void> {
  if (account.kind === "bank") {
    const [row] = await conn
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
    if (!row) {
      throw new GoldenCoastPhase7RouteError(
        `${label} must reference an active bank account in company ${companyId}`,
        "GC_PHASE7_CASH_ACCOUNT_INVALID",
        400
      );
    }
    return;
  }

  const [row] = await conn
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.id, account.id),
        eq(ledgerAccounts.companyId, companyId),
        eq(ledgerAccounts.active, true),
        isNull(ledgerAccounts.deletedAt),
        inArray(ledgerAccounts.accountType, ["Cash", "Bank"])
      )
    )
    .limit(1);
  if (!row) {
    throw new GoldenCoastPhase7RouteError(
      `${label} must reference an active Cash/Bank ledger account in company ${companyId}`,
      "GC_PHASE7_CASH_ACCOUNT_INVALID",
      400
    );
  }
}

async function listCashAccounts(conn: DbLike, companyId: number) {
  const [ledgerRows, bankRows] = await Promise.all([
    conn
      .select({ id: ledgerAccounts.id, name: ledgerAccounts.name, accountType: ledgerAccounts.accountType })
      .from(ledgerAccounts)
      .where(
        and(
          eq(ledgerAccounts.companyId, companyId),
          eq(ledgerAccounts.active, true),
          isNull(ledgerAccounts.deletedAt),
          inArray(ledgerAccounts.accountType, ["Cash", "Bank"])
        )
      )
      .orderBy(asc(ledgerAccounts.name)),
    conn
      .select({ id: bankAccounts.id, name: bankAccounts.name })
      .from(bankAccounts)
      .where(and(eq(bankAccounts.companyId, companyId), eq(bankAccounts.active, true), isNull(bankAccounts.deletedAt)))
      .orderBy(asc(bankAccounts.name)),
  ]);
  return [
    ...ledgerRows.map((row) => ({
      kind: "ledger" as const,
      id: Number(row.id),
      name: row.name,
      type: row.accountType,
    })),
    ...bankRows.map((row) => ({ kind: "bank" as const, id: Number(row.id), name: row.name, type: "Bank Account" })),
  ];
}

/**
 * Raw signed debit-minus-credit on GC Sales Cash. The account is credit-normal,
 * so callers convert this through `gcSalesCashPayableBalance` before reporting
 * or planning against what is still owed.
 */
async function gcSalesCashSignedBalance(conn: DbLike, companyId: number, accountId: number): Promise<string> {
  const query = await conn.execute(sql`
    SELECT (
      CASE
        WHEN la.opening_balance_side = 'Cr' THEN -COALESCE(la.opening_balance, 0)::numeric
        ELSE COALESCE(la.opening_balance, 0)::numeric
      END
      + COALESCE((
        SELECT SUM(CAST(ve.debit_amount AS numeric) - CAST(ve.credit_amount AS numeric))
        FROM voucher_entries ve
        JOIN vouchers v ON v.id = ve.voucher_id
        WHERE ve.ledger_account_id = ${accountId}
          AND v.company_id = ${companyId}
          AND v.deleted_at IS NULL
          AND v.optional = false
      ), 0)
    )::text AS debit_minus_credit
    FROM ledger_accounts la
    WHERE la.id = ${accountId}
      AND la.company_id = ${companyId}
      AND la.active = true
      AND la.deleted_at IS NULL
    LIMIT 1
  `);
  const row = resultRows(query)[0];
  if (!row) {
    throw new GoldenCoastPhase7RouteError(
      "GC Sales Cash disappeared while Phase 7 balances were being read",
      "GC_PHASE7_ACCOUNT_INVALID",
      409
    );
  }
  return String(row.debit_minus_credit ?? "0");
}

/**
 * Only Phase 7 collection/remittance vouchers participate in this outstanding
 * amount. The shared intercompany accounts also carry unrelated HADI agent
 * activity, which must never become remittable sales cash by accident.
 */
async function outstandingPhase7HadiCollections(conn: DbLike, companyId: number): Promise<string> {
  const query = await conn.execute(sql`
    SELECT (
      COALESCE(SUM(CASE
        WHEN split_part(apr.source_id, ':', 1) = 'collect_via_hadi'
         AND split_part(apr.source_id, ':', 3) = 'golden_coast'
        THEN CAST(v.total_amount AS numeric) ELSE 0 END), 0)
      -
      COALESCE(SUM(CASE
        WHEN split_part(apr.source_id, ':', 1) = 'remit_from_hadi'
         AND split_part(apr.source_id, ':', 3) = 'golden_coast'
        THEN CAST(v.total_amount AS numeric) ELSE 0 END), 0)
    )::text AS outstanding
    FROM accounting_posting_requests apr
    JOIN vouchers v ON v.id = apr.voucher_id
    WHERE apr.company_id = ${companyId}
      AND apr.source_type = ${GOLDEN_COAST_PHASE7_SOURCE_TYPE}
      AND v.company_id = ${companyId}
      AND v.deleted_at IS NULL
  `);
  return String(resultRows(query)[0]?.outstanding ?? "0");
}

async function findPostedVoucher(
  tx: DatabaseTransaction,
  markerCompanyId: number,
  idempotencyKey: string
): Promise<{ voucher: typeof vouchers.$inferSelect; sourceId: string } | null> {
  const [marker] = await tx
    .select({ voucherId: accountingPostingRequests.voucherId, sourceId: accountingPostingRequests.sourceId })
    .from(accountingPostingRequests)
    .where(
      and(
        eq(accountingPostingRequests.companyId, markerCompanyId),
        eq(accountingPostingRequests.idempotencyKey, idempotencyKey)
      )
    )
    .limit(1);
  if (!marker) return null;

  const [voucher] = await tx
    .select()
    .from(vouchers)
    .where(and(eq(vouchers.id, Number(marker.voucherId)), eq(vouchers.companyId, markerCompanyId)))
    .limit(1);
  if (!voucher || voucher.deletedAt != null) {
    throw new GoldenCoastPhase7RouteError(
      `Phase 7 idempotency marker ${idempotencyKey} references a missing or deleted voucher`,
      "GC_PHASE7_IDEMPOTENCY_INCONSISTENT",
      409
    );
  }
  return { voucher, sourceId: String(marker.sourceId ?? "") };
}

async function loadVoucherEntries(tx: DatabaseTransaction, voucherId: number) {
  return tx.select().from(voucherEntries).where(eq(voucherEntries.voucherId, voucherId));
}

async function findReplayedTransfer(
  tx: DatabaseTransaction,
  pair: GoldenCoastPhase7CompanyPair,
  transfer: GoldenCoastPhase7TransferInput,
  transferDigest: string
) {
  const roles: Array<{ role: GoldenCoastPhase7PostingRole; markerCompanyId: number }> = [
    { role: "golden_coast", markerCompanyId: pair.goldenCoastCompanyId },
    { role: "hadi", markerCompanyId: pair.hadiCompanyId },
  ];
  const found: Array<{
    role: GoldenCoastPhase7PostingRole;
    markerCompanyId: number;
    marker: Awaited<ReturnType<typeof findPostedVoucher>>;
  }> = [];
  for (const { role, markerCompanyId } of roles) {
    await assertTransactionCompanyScope(tx, markerCompanyId);
    found.push({
      role,
      markerCompanyId,
      marker: await findPostedVoucher(
        tx,
        markerCompanyId,
        goldenCoastPhase7IdempotencyKey(pair.goldenCoastCompanyId, transfer.clientRequestId, role)
      ),
    });
  }
  await assertTransactionCompanyScope(tx, pair.goldenCoastCompanyId);
  const posted = found.filter((item) => item.marker != null);
  if (posted.length === 0) return null;
  if (posted.length !== roles.length) {
    throw new GoldenCoastPhase7RouteError(
      `Phase 7 transfer ${transfer.clientRequestId} has a partially recorded cross-company posting pair`,
      "GC_PHASE7_IDEMPOTENCY_INCONSISTENT",
      409
    );
  }

  for (const item of found) {
    const expectedSourceId = goldenCoastPhase7SourceId(transfer.operation, transferDigest, item.role);
    if (item.marker?.sourceId !== expectedSourceId) {
      throw new GoldenCoastPhase7RouteError(
        `Phase 7 transfer ${transfer.clientRequestId} was already posted with different economic data; use a new clientRequestId`,
        "GC_PHASE7_IDEMPOTENCY_CONFLICT",
        409
      );
    }
  }

  return Promise.all(
    found.map(async (item) => {
      const voucher = (item.marker as { voucher: typeof vouchers.$inferSelect }).voucher;
      return { role: item.role, voucher, entries: await loadVoucherEntries(tx, voucher.id) };
    })
  );
}

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
