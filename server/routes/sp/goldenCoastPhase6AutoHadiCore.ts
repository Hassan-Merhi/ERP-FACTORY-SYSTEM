import { and, asc, eq, isNull, sql } from "drizzle-orm";
import Decimal from "decimal.js";
import {
  accountingPostingRequests,
  bankAccounts,
  companies,
  ledgerAccounts,
  voucherEntries,
  vouchers,
} from "@shared/schema";
import { db } from "../../db";
import { releaseDebtEnglish } from "../../i18n/finalCloseoutEnglish";
import { resultRows } from "../../lib/queryResult";
import {
  postBalancedVoucherTx,
  type CentralPostingResult,
  type PostingActor,
} from "../../services/accounting/centralPostingEngine";
import { createDatabasePostingDependencies } from "../../services/accounting/databasePostingDependencies";
import {
  GOLDEN_COAST_PHASE7_SOURCE_TYPE,
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
import { getCompanyRequestRuntimeContext } from "../../services/security/companyRequestRuntimeContext";
import { assertTransactionCompanyScope } from "../../services/security/transactionCompanyScope";
import { getCurrentExchangeRate } from "../helpers/exchangeRateHelpers";

const postingDependencies = createDatabasePostingDependencies();

type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbLike = typeof db | DatabaseTransaction;
type PersistedPostingResult = CentralPostingResult<typeof vouchers.$inferSelect, typeof voucherEntries.$inferSelect>;

export class GoldenCoastPhase6AutoHadiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code = "GC_PHASE6_AUTO_HADI_INVALID", status = 409) {
    super(releaseDebtEnglish(message));
    this.name = "GoldenCoastPhase6AutoHadiError";
    this.code = code;
    this.status = status;
  }
}

export interface GoldenCoastAutomaticHadiPair {
  goldenCoastCompanyId: number;
  goldenCoastCompanyName: string;
  hadiCompanyId: number;
  hadiCompanyName: string;
}

export interface GoldenCoastAutomaticHadiAccount extends GoldenCoastPhase7CashAccount {
  name: string;
}

export interface GoldenCoastAutomaticHadiResult {
  replayed: boolean;
  pair: GoldenCoastAutomaticHadiPair;
  transfer: GoldenCoastPhase7TransferInput;
  hadiCashAccount: GoldenCoastAutomaticHadiAccount;
  plan: ReturnType<typeof planGoldenCoastPhase7Transfer> | null;
  postings: Array<{
    role: GoldenCoastPhase7PostingRole;
    voucher: PersistedPostingResult["voucher"];
    entries: PersistedPostingResult["entries"];
  }>;
}

interface AutomaticCashCandidate extends GoldenCoastAutomaticHadiAccount {
  source: "cash-ledger" | "bank-ledger" | "bank-account";
}

export function selectGoldenCoastAutomaticHadiCashAccount(input: {
  cashLedgers: readonly AutomaticCashCandidate[];
  fallbackAccounts: readonly AutomaticCashCandidate[];
}): GoldenCoastAutomaticHadiAccount {
  if (input.cashLedgers.length === 1) {
    const account = input.cashLedgers[0];
    return { kind: account.kind, id: account.id, name: account.name };
  }
  if (input.cashLedgers.length > 1) {
    throw new GoldenCoastPhase6AutoHadiError(
      "Automatic HADI collection is ambiguous because HADI has more than one active Cash ledger account. Keep one active Cash ledger for automatic Golden Coast receipts or consolidate the cash setup.",
      "GC_PHASE6_AUTO_HADI_CASH_AMBIGUOUS"
    );
  }
  if (input.fallbackAccounts.length === 1) {
    const account = input.fallbackAccounts[0];
    return { kind: account.kind, id: account.id, name: account.name };
  }
  if (input.fallbackAccounts.length === 0) {
    throw new GoldenCoastPhase6AutoHadiError(
      "Automatic HADI collection requires an active HADI Cash ledger or a single active HADI bank account.",
      "GC_PHASE6_AUTO_HADI_CASH_MISSING"
    );
  }
  throw new GoldenCoastPhase6AutoHadiError(
    "Automatic HADI collection is ambiguous because HADI has multiple bank destinations and no unique Cash ledger. Configure one active Cash ledger for automatic Golden Coast receipts.",
    "GC_PHASE6_AUTO_HADI_CASH_AMBIGUOUS"
  );
}

export async function resolveGoldenCoastAutomaticHadiPair(
  conn: DbLike,
  companyId: number
): Promise<GoldenCoastAutomaticHadiPair> {
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
    throw new GoldenCoastPhase6AutoHadiError(
      "The selected Golden Coast company is missing or inactive.",
      "GC_PHASE6_AUTO_HADI_COMPANY_INVALID"
    );
  }

  const hadiCompanyId = Number(goldenCoast.parentCompanyId ?? 0);
  if (!Number.isInteger(hadiCompanyId) || hadiCompanyId <= 0 || hadiCompanyId === companyId) {
    throw new GoldenCoastPhase6AutoHadiError(
      "Golden Coast must have a distinct active HADI parent company before POS cash can route automatically.",
      "GC_PHASE6_AUTO_HADI_PARENT_INVALID"
    );
  }

  const [hadi] = await conn
    .select({ id: companies.id, name: companies.name, active: companies.active })
    .from(companies)
    .where(and(eq(companies.id, hadiCompanyId), eq(companies.active, true)))
    .limit(1);
  if (!hadi) {
    throw new GoldenCoastPhase6AutoHadiError(
      "The configured HADI parent company is missing or inactive.",
      "GC_PHASE6_AUTO_HADI_PARENT_INVALID"
    );
  }

  return {
    goldenCoastCompanyId: Number(goldenCoast.id),
    goldenCoastCompanyName: String(goldenCoast.name),
    hadiCompanyId: Number(hadi.id),
    hadiCompanyName: String(hadi.name),
  };
}

function assertHadiAuthorized(pair: GoldenCoastAutomaticHadiPair): void {
  const requestContext = getCompanyRequestRuntimeContext();
  if (!requestContext?.authorizedCompanyIds?.includes(pair.hadiCompanyId)) {
    throw new GoldenCoastPhase6AutoHadiError(
      `HADI company ${pair.hadiCompanyId} is not authorized for this POS request; submit targetCompanyId=${pair.hadiCompanyId} so the tenant boundary verifies access before the sale posts.`,
      "GC_PHASE6_AUTO_HADI_SCOPE_UNAUTHORIZED",
      403
    );
  }
}

async function activeIntercompanyAccount(
  tx: DatabaseTransaction,
  companyId: number,
  subType: "sp_hadi_intercompany" | "hadi_sp_intercompany",
  label: string
): Promise<{ id: number; name: string }> {
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

  if (rows.length !== 1) {
    throw new GoldenCoastPhase6AutoHadiError(
      rows.length === 0
        ? `${label} is not configured for company ${companyId}; run Golden Coast setup first.`
        : `${label} is ambiguous; repair duplicate active ${subType} accounts first.`,
      "GC_PHASE6_AUTO_HADI_INTERCOMPANY_INVALID"
    );
  }
  if (rows[0].accountType !== "Intercompany") {
    throw new GoldenCoastPhase6AutoHadiError(
      `${label} must have account type Intercompany, not ${rows[0].accountType}.`,
      "GC_PHASE6_AUTO_HADI_INTERCOMPANY_INVALID"
    );
  }
  return { id: Number(rows[0].id), name: String(rows[0].name) };
}

async function resolveAutomaticRoleAccounts(
  tx: DatabaseTransaction,
  pair: GoldenCoastAutomaticHadiPair,
  gcSalesCashAccountId: number
): Promise<GoldenCoastPhase7RoleAccounts> {
  await assertTransactionCompanyScope(tx, pair.goldenCoastCompanyId);
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
    gcSalesCashAccountId,
    goldenCoastHadiIntercompanyAccountId: goldenCoastIntercompany.id,
    hadiGoldenCoastIntercompanyAccountId: hadiIntercompany.id,
  };
}

async function resolveAutomaticHadiCashAccount(
  tx: DatabaseTransaction,
  hadiCompanyId: number
): Promise<GoldenCoastAutomaticHadiAccount> {
  await assertTransactionCompanyScope(tx, hadiCompanyId);

  const cashLedgers = await tx
    .select({ id: ledgerAccounts.id, name: ledgerAccounts.name })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.companyId, hadiCompanyId),
        eq(ledgerAccounts.accountType, "Cash"),
        eq(ledgerAccounts.active, true),
        isNull(ledgerAccounts.deletedAt)
      )
    )
    .orderBy(asc(ledgerAccounts.id));

  const bankLedgers = await tx
    .select({ id: ledgerAccounts.id, name: ledgerAccounts.name })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.companyId, hadiCompanyId),
        eq(ledgerAccounts.accountType, "Bank"),
        eq(ledgerAccounts.active, true),
        isNull(ledgerAccounts.deletedAt)
      )
    )
    .orderBy(asc(ledgerAccounts.id));

  const banks = await tx
    .select({ id: bankAccounts.id, name: bankAccounts.name })
    .from(bankAccounts)
    .where(
      and(eq(bankAccounts.companyId, hadiCompanyId), eq(bankAccounts.active, true), isNull(bankAccounts.deletedAt))
    )
    .orderBy(asc(bankAccounts.id));

  return selectGoldenCoastAutomaticHadiCashAccount({
    cashLedgers: cashLedgers.map((row) => ({
      kind: "ledger" as const,
      id: Number(row.id),
      name: String(row.name),
      source: "cash-ledger" as const,
    })),
    fallbackAccounts: [
      ...bankLedgers.map((row) => ({
        kind: "ledger" as const,
        id: Number(row.id),
        name: String(row.name),
        source: "bank-ledger" as const,
      })),
      ...banks.map((row) => ({
        kind: "bank" as const,
        id: Number(row.id),
        name: String(row.name),
        source: "bank-account" as const,
      })),
    ],
  });
}

async function gcSalesCashDebitBalance(tx: DatabaseTransaction, companyId: number, accountId: number): Promise<string> {
  await assertTransactionCompanyScope(tx, companyId);
  const query = await tx.execute(sql`
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
    throw new GoldenCoastPhase6AutoHadiError(
      "GC Sales Cash disappeared while automatic HADI collection was being prepared.",
      "GC_PHASE6_AUTO_HADI_ACCOUNT_INVALID"
    );
  }
  return String(row.debit_minus_credit ?? "0");
}

async function outstandingPhase7HadiCollections(tx: DatabaseTransaction, companyId: number): Promise<string> {
  await assertTransactionCompanyScope(tx, companyId);
  const query = await tx.execute(sql`
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
  companyId: number,
  idempotencyKey: string
): Promise<{ voucher: typeof vouchers.$inferSelect; sourceId: string } | null> {
  const [marker] = await tx
    .select({ voucherId: accountingPostingRequests.voucherId, sourceId: accountingPostingRequests.sourceId })
    .from(accountingPostingRequests)
    .where(
      and(
        eq(accountingPostingRequests.companyId, companyId),
        eq(accountingPostingRequests.idempotencyKey, idempotencyKey)
      )
    )
    .limit(1);
  if (!marker) return null;

  const [voucher] = await tx
    .select()
    .from(vouchers)
    .where(and(eq(vouchers.id, Number(marker.voucherId)), eq(vouchers.companyId, companyId)))
    .limit(1);
  if (!voucher || voucher.deletedAt != null) {
    throw new GoldenCoastPhase6AutoHadiError(
      `Automatic HADI idempotency marker ${idempotencyKey} references a missing or deleted voucher.`,
      "GC_PHASE6_AUTO_HADI_IDEMPOTENCY_INCONSISTENT"
    );
  }
  return { voucher, sourceId: String(marker.sourceId ?? "") };
}

async function loadVoucherEntries(tx: DatabaseTransaction, voucherId: number) {
  return tx.select().from(voucherEntries).where(eq(voucherEntries.voucherId, voucherId));
}

async function findReplayedAutomaticTransfer(
  tx: DatabaseTransaction,
  pair: GoldenCoastAutomaticHadiPair,
  transfer: GoldenCoastPhase7TransferInput,
  transferDigest: string
) {
  const roles: Array<{ role: GoldenCoastPhase7PostingRole; companyId: number }> = [
    { role: "golden_coast", companyId: pair.goldenCoastCompanyId },
    { role: "hadi", companyId: pair.hadiCompanyId },
  ];
  const found: Array<{
    role: GoldenCoastPhase7PostingRole;
    companyId: number;
    marker: Awaited<ReturnType<typeof findPostedVoucher>>;
  }> = [];

  for (const item of roles) {
    await assertTransactionCompanyScope(tx, item.companyId);
    found.push({
      ...item,
      marker: await findPostedVoucher(
        tx,
        item.companyId,
        goldenCoastPhase7IdempotencyKey(pair.goldenCoastCompanyId, transfer.clientRequestId, item.role)
      ),
    });
  }
  await assertTransactionCompanyScope(tx, pair.goldenCoastCompanyId);

  const posted = found.filter((item) => item.marker != null);
  if (posted.length === 0) return null;
  if (posted.length !== roles.length) {
    throw new GoldenCoastPhase6AutoHadiError(
      `Automatic HADI collection ${transfer.clientRequestId} has a partially recorded cross-company posting pair.`,
      "GC_PHASE6_AUTO_HADI_IDEMPOTENCY_INCONSISTENT"
    );
  }

  for (const item of found) {
    const expectedSourceId = goldenCoastPhase7SourceId(transfer.operation, transferDigest, item.role);
    if (item.marker?.sourceId !== expectedSourceId) {
      throw new GoldenCoastPhase6AutoHadiError(
        `Automatic HADI collection ${transfer.clientRequestId} was already posted with different routing data.`,
        "GC_PHASE6_AUTO_HADI_IDEMPOTENCY_CONFLICT"
      );
    }
  }

  return Promise.all(
    found.map(async (item) => {
      const voucher = item.marker!.voucher;
      return { role: item.role, voucher, entries: await loadVoucherEntries(tx, voucher.id) };
    })
  );
}

export async function postGoldenCoastAutomaticHadiCollectionTx(input: {
  tx: DatabaseTransaction;
  companyId: number;
  gcSalesCashAccountId: number;
  saleDate: string;
  amountUsd: string;
  clientRequestId: string;
  actor?: PostingActor;
}): Promise<GoldenCoastAutomaticHadiResult> {
  const amount = new Decimal(input.amountUsd);
  if (!amount.isFinite() || !amount.greaterThan(0)) {
    throw new GoldenCoastPhase6AutoHadiError(
      "Automatic HADI collection amount must be greater than zero.",
      "GC_PHASE6_AUTO_HADI_AMOUNT_INVALID",
      400
    );
  }

  const pair = await resolveGoldenCoastAutomaticHadiPair(input.tx, input.companyId);
  assertHadiAuthorized(pair);

  await input.tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`golden-coast-phase7:${input.companyId}`}))`);
  await input.tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`golden-coast-phase7:${input.companyId}:${input.clientRequestId}`}))`
  );

  const accounts = await resolveAutomaticRoleAccounts(input.tx, pair, input.gcSalesCashAccountId);
  const hadiCashAccount = await resolveAutomaticHadiCashAccount(input.tx, pair.hadiCompanyId);
  await assertTransactionCompanyScope(input.tx, pair.goldenCoastCompanyId);

  const transfer = parseGoldenCoastPhase7TransferInput({
    companyId: pair.goldenCoastCompanyId,
    parentCompanyId: pair.hadiCompanyId,
    body: {
      operation: "collect_via_hadi",
      transferDate: input.saleDate,
      amountUsd: amount.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
      clientRequestId: input.clientRequestId,
      reference: `Automatic HADI collection for Golden Coast POS sale ${input.clientRequestId}`,
      hadiCashAccount: { kind: hadiCashAccount.kind, id: hadiCashAccount.id },
    },
  });

  const transferDigest = goldenCoastPhase7TransferDigest({ transfer, accounts });
  const replayed = await findReplayedAutomaticTransfer(input.tx, pair, transfer, transferDigest);
  if (replayed) {
    return {
      replayed: true,
      pair,
      transfer,
      hadiCashAccount,
      plan: null,
      postings: replayed,
    };
  }

  const [gcSalesCashDebitBalanceUsd, outstandingHadiCollectionsUsd] = await Promise.all([
    gcSalesCashDebitBalance(input.tx, pair.goldenCoastCompanyId, accounts.gcSalesCashAccountId),
    outstandingPhase7HadiCollections(input.tx, pair.goldenCoastCompanyId),
  ]);
  const plan = planGoldenCoastPhase7Transfer({
    transfer,
    balances: { gcSalesCashDebitBalanceUsd, outstandingHadiCollectionsUsd },
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
    actor: input.actor,
  });

  const postings: GoldenCoastAutomaticHadiResult["postings"] = [];
  for (const item of batch.postings) {
    const posted = (await postBalancedVoucherTx(input.tx, item.request, postingDependencies)) as PersistedPostingResult;
    if (posted.replayed) {
      throw new GoldenCoastPhase6AutoHadiError(
        `Automatic HADI collection ${input.clientRequestId} ${item.role} voucher replayed unexpectedly.`,
        "GC_PHASE6_AUTO_HADI_IDEMPOTENCY_INCONSISTENT"
      );
    }
    postings.push({ role: item.role, voucher: posted.voucher, entries: posted.entries });
  }
  await assertTransactionCompanyScope(input.tx, pair.goldenCoastCompanyId);

  return {
    replayed: false,
    pair,
    transfer,
    hadiCashAccount,
    plan,
    postings,
  };
}
