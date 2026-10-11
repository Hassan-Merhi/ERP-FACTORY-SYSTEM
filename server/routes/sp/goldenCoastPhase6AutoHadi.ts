import { createHash } from "node:crypto";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import Decimal from "decimal.js";
import { accountingPostingRequests, bankAccounts, ledgerAccounts, voucherEntries, vouchers } from "@shared/schema";
import { db } from "../../db";
import { resultRows } from "../../lib/queryResult";
import {
  postBalancedVoucherTx,
  type CentralPostingResult,
  type PostingActor,
} from "../../services/accounting/centralPostingEngine";
import { createDatabasePostingDependencies } from "../../services/accounting/databasePostingDependencies";
import {
  buildGoldenCoastPhase15SalesPayablePosting,
  goldenCoastPhase15SalesPayableDigest,
} from "../../services/accounting/goldenCoastPhase15SalesPayable";
import { gcSalesCashPayableBalance } from "../../services/accounting/goldenCoastSalesCashPayable";
import {
  GOLDEN_COAST_PHASE7_SOURCE_TYPE,
  buildGoldenCoastPhase7TransferPostings,
  goldenCoastPhase7IdempotencyKey,
  goldenCoastPhase7SourceId,
  goldenCoastPhase7TransferDigest,
  parseGoldenCoastPhase7TransferInput,
  type GoldenCoastPhase7PostingRole,
  type GoldenCoastPhase7RoleAccounts,
} from "../../services/accounting/goldenCoastPhase7HadiTransfer";
import { getCompanyRequestRuntimeContext } from "../../services/security/companyRequestRuntimeContext";
import { assertTransactionCompanyScope } from "../../services/security/transactionCompanyScope";
import { getCurrentExchangeRate } from "../helpers/exchangeRateHelpers";
import * as core from "./goldenCoastPhase6AutoHadiCore";

export {
  GoldenCoastPhase6AutoHadiError,
  resolveGoldenCoastAutomaticHadiPair,
  selectGoldenCoastAutomaticHadiCashAccount,
} from "./goldenCoastPhase6AutoHadiCore";
import { isAccountType } from "../../services/accounting/accountClassification";
export type { GoldenCoastAutomaticHadiAccount, GoldenCoastAutomaticHadiPair } from "./goldenCoastPhase6AutoHadiCore";

const postingDependencies = createDatabasePostingDependencies();
type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type PersistedPostingResult = CentralPostingResult<typeof vouchers.$inferSelect, typeof voucherEntries.$inferSelect>;
type AutomaticCashCandidate = core.GoldenCoastAutomaticHadiAccount & {
  source: "cash-ledger" | "bank-ledger" | "bank-account";
};

export type GoldenCoastAutomaticHadiPostingRole = GoldenCoastPhase7PostingRole | "sales_payable";
export interface GoldenCoastAutomaticHadiResult extends Omit<core.GoldenCoastAutomaticHadiResult, "postings"> {
  postings: Array<{
    role: GoldenCoastAutomaticHadiPostingRole;
    voucher: PersistedPostingResult["voucher"];
    entries: PersistedPostingResult["entries"];
  }>;
}

function assertHadiAuthorized(pair: core.GoldenCoastAutomaticHadiPair): void {
  const requestContext = getCompanyRequestRuntimeContext();
  if (!requestContext?.authorizedCompanyIds?.includes(pair.hadiCompanyId)) {
    throw new core.GoldenCoastPhase6AutoHadiError(
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

  if (rows.length !== 1 || !isAccountType(rows[0].accountType, "Intercompany")) {
    throw new core.GoldenCoastPhase6AutoHadiError(
      rows.length === 0
        ? `${label} is not configured for company ${companyId}; run Golden Coast setup first.`
        : rows.length > 1
          ? `${label} is ambiguous; repair duplicate active ${subType} accounts first.`
          : `${label} must have account type Intercompany, not ${rows[0].accountType}.`,
      "GC_PHASE6_AUTO_HADI_INTERCOMPANY_INVALID",
      409
    );
  }
  return { id: Number(rows[0].id), name: String(rows[0].name) };
}

async function resolveAutomaticRoleAccounts(
  tx: DatabaseTransaction,
  pair: core.GoldenCoastAutomaticHadiPair,
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
): Promise<core.GoldenCoastAutomaticHadiAccount> {
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

  return core.selectGoldenCoastAutomaticHadiCashAccount({
    cashLedgers: cashLedgers.map((row): AutomaticCashCandidate => ({
      kind: "ledger",
      id: Number(row.id),
      name: String(row.name),
      source: "cash-ledger",
    })),
    fallbackAccounts: [
      ...bankLedgers.map((row): AutomaticCashCandidate => ({
        kind: "ledger",
        id: Number(row.id),
        name: String(row.name),
        source: "bank-ledger",
      })),
      ...banks.map((row): AutomaticCashCandidate => ({
        kind: "bank",
        id: Number(row.id),
        name: String(row.name),
        source: "bank-account",
      })),
    ],
  });
}

async function outstandingAutomaticHadiCollections(tx: DatabaseTransaction, companyId: number): Promise<Decimal> {
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
  const outstanding = new Decimal(String(resultRows(query)[0]?.outstanding ?? "0"));
  if (!outstanding.isFinite() || outstanding.lessThan(0)) {
    throw new core.GoldenCoastPhase6AutoHadiError(
      "Automatic HADI collection history is inconsistent: remittances exceed collections.",
      "GC_PHASE6_AUTO_HADI_HISTORY_INVALID",
      409
    );
  }
  return outstanding;
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
    throw new core.GoldenCoastPhase6AutoHadiError(
      `Automatic HADI idempotency marker ${idempotencyKey} references a missing or deleted voucher.`,
      "GC_PHASE6_AUTO_HADI_IDEMPOTENCY_INCONSISTENT",
      409
    );
  }
  return { voucher, sourceId: String(marker.sourceId ?? "") };
}

async function findReplayedAutomaticTransfer(
  tx: DatabaseTransaction,
  pair: core.GoldenCoastAutomaticHadiPair,
  clientRequestId: string,
  transferDigest: string
): Promise<core.GoldenCoastAutomaticHadiResult["postings"] | null> {
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
        goldenCoastPhase7IdempotencyKey(pair.goldenCoastCompanyId, clientRequestId, item.role)
      ),
    });
  }
  await assertTransactionCompanyScope(tx, pair.goldenCoastCompanyId);

  const posted = found.filter((item) => item.marker != null);
  if (posted.length === 0) return null;
  if (posted.length !== roles.length) {
    throw new core.GoldenCoastPhase6AutoHadiError(
      `Automatic HADI collection ${clientRequestId} has a partially recorded cross-company posting pair.`,
      "GC_PHASE6_AUTO_HADI_IDEMPOTENCY_INCONSISTENT",
      409
    );
  }

  for (const item of found) {
    const expectedSourceId = goldenCoastPhase7SourceId("collect_via_hadi", transferDigest, item.role);
    if (item.marker?.sourceId !== expectedSourceId) {
      throw new core.GoldenCoastPhase6AutoHadiError(
        `Automatic HADI collection ${clientRequestId} was already posted with different routing data.`,
        "GC_PHASE6_AUTO_HADI_IDEMPOTENCY_CONFLICT",
        409
      );
    }
  }

  return Promise.all(
    found.map(async (item) => {
      const voucher = item.marker!.voucher;
      return {
        role: item.role,
        voucher,
        entries: await tx.select().from(voucherEntries).where(eq(voucherEntries.voucherId, voucher.id)),
      };
    })
  );
}

async function resolveFreshStartEquityAccount(
  tx: DatabaseTransaction,
  companyId: number
): Promise<{ id: number; name: string }> {
  await assertTransactionCompanyScope(tx, companyId);
  const rows = await tx
    .select({ id: ledgerAccounts.id, name: ledgerAccounts.name, accountType: ledgerAccounts.accountType })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.companyId, companyId),
        eq(ledgerAccounts.subType, "gc_partner_capital"),
        eq(ledgerAccounts.active, true),
        isNull(ledgerAccounts.deletedAt)
      )
    )
    .orderBy(asc(ledgerAccounts.id))
    .limit(2);

  if (rows.length !== 1 || !isAccountType(rows[0].accountType, "Equity")) {
    throw new core.GoldenCoastPhase6AutoHadiError(
      rows.length === 0
        ? "Fresh Start FZ Equity is not configured for Golden Coast; run Golden Coast setup first."
        : rows.length > 1
          ? "Fresh Start FZ Equity is ambiguous; repair duplicate active partner-capital accounts first."
          : `Fresh Start FZ Equity must have account type Equity, not ${rows[0].accountType}.`,
      "GC_PHASE15_SALES_PAYABLE_ACCOUNT_INVALID",
      409
    );
  }

  return { id: Number(rows[0].id), name: String(rows[0].name) };
}

function entryNetDebit(entries: PersistedPostingResult["entries"], ledgerAccountId: number): Decimal {
  return entries
    .filter((entry) => Number(entry.ledgerAccountId ?? 0) === ledgerAccountId)
    .reduce(
      (sum, entry) => sum.plus(String(entry.debitAmount ?? "0")).minus(String(entry.creditAmount ?? "0")),
      new Decimal(0)
    );
}

function verifyPhase15SalesPayablePosting(input: {
  posted: PersistedPostingResult;
  companyId: number;
  freshStartEquityAccountId: number;
  gcSalesCashAccountId: number;
  amountUsd: string;
}): void {
  const expected = new Decimal(input.amountUsd);
  const voucher = input.posted.voucher;
  const entries = input.posted.entries;
  const allowed = new Set([input.freshStartEquityAccountId, input.gcSalesCashAccountId]);
  const invalidEntry = entries.find(
    (entry) =>
      entry.bankAccountId != null || entry.ledgerAccountId == null || !allowed.has(Number(entry.ledgerAccountId))
  );
  const freshNetDebit = entryNetDebit(entries, input.freshStartEquityAccountId);
  const payableNetDebit = entryNetDebit(entries, input.gcSalesCashAccountId);

  if (
    Number(voucher.companyId) !== input.companyId ||
    voucher.deletedAt != null ||
    entries.length !== 2 ||
    invalidEntry ||
    !freshNetDebit.equals(expected) ||
    !payableNetDebit.equals(expected.negated())
  ) {
    throw new core.GoldenCoastPhase6AutoHadiError(
      "Phase 15 sales-payable replay state is missing, deleted, or no longer matches the canonical Fresh Start Equity / GC Sales Cash journal.",
      "GC_PHASE15_SALES_PAYABLE_IDEMPOTENCY_INCONSISTENT",
      409
    );
  }
}

async function postPhase15SalesPayableBridge(input: {
  tx: DatabaseTransaction;
  companyId: number;
  gcSalesCashAccountId: number;
  saleDate: string;
  amountUsd: string;
  clientRequestId: string;
  transfer: core.GoldenCoastAutomaticHadiResult["transfer"];
  actor?: PostingActor;
}): Promise<GoldenCoastAutomaticHadiResult["postings"][number]> {
  const freshStartEquity = await resolveFreshStartEquityAccount(input.tx, input.companyId);
  const saleDigest = createHash("sha256").update(JSON.stringify(input.transfer)).digest("hex").slice(0, 32);
  const sale = {
    companyId: input.companyId,
    saleDate: input.saleDate,
    amountUsd: input.amountUsd,
    clientRequestId: input.clientRequestId,
    saleDigest,
    freshStartEquityAccountId: freshStartEquity.id,
    gcSalesCashAccountId: input.gcSalesCashAccountId,
  };
  const digest = goldenCoastPhase15SalesPayableDigest(sale);
  const request = buildGoldenCoastPhase15SalesPayablePosting({ sale, digest, exchangeRate: null, actor: input.actor });
  const posted = (await postBalancedVoucherTx(input.tx, request, postingDependencies)) as PersistedPostingResult;
  verifyPhase15SalesPayablePosting({
    posted,
    companyId: input.companyId,
    freshStartEquityAccountId: freshStartEquity.id,
    gcSalesCashAccountId: input.gcSalesCashAccountId,
    amountUsd: input.amountUsd,
  });
  await assertTransactionCompanyScope(input.tx, input.companyId);
  return { role: "sales_payable", voucher: posted.voucher, entries: posted.entries };
}

/**
 * Automatic POS collection is sale-scoped, not balance-scoped. Phase 15 leaves
 * GC Sales Cash credit-normal between sales, so a running payable must never
 * block the next sale from moving its own physical proceeds to HADI. Manual
 * Phase 7 transfers retain their existing live-balance rules; only this atomic
 * sale companion uses the current sale amount as its posting authority.
 */
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
    throw new core.GoldenCoastPhase6AutoHadiError(
      "Automatic HADI collection amount must be greater than zero.",
      "GC_PHASE6_AUTO_HADI_AMOUNT_INVALID",
      400
    );
  }
  const amountUsd = amount.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
  const pair = await core.resolveGoldenCoastAutomaticHadiPair(input.tx, input.companyId);
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
      amountUsd,
      clientRequestId: input.clientRequestId,
      reference: `Automatic HADI collection for Golden Coast POS sale ${input.clientRequestId}`,
      hadiCashAccount: { kind: hadiCashAccount.kind, id: hadiCashAccount.id },
    },
  });
  const transferDigest = goldenCoastPhase7TransferDigest({ transfer, accounts });
  const replayed = await findReplayedAutomaticTransfer(input.tx, pair, input.clientRequestId, transferDigest);
  if (replayed) {
    const salesPayable = await postPhase15SalesPayableBridge({
      tx: input.tx,
      companyId: input.companyId,
      gcSalesCashAccountId: input.gcSalesCashAccountId,
      saleDate: input.saleDate,
      amountUsd,
      clientRequestId: input.clientRequestId,
      transfer,
      actor: input.actor,
    });
    return {
      replayed: true,
      pair,
      transfer,
      hadiCashAccount,
      plan: null,
      postings: [...replayed, salesPayable],
    };
  }

  const outstanding = await outstandingAutomaticHadiCollections(input.tx, pair.goldenCoastCompanyId);
  const plan = {
    ...transfer,
    gcSalesCashDebitBalanceBeforeUsd: amountUsd,
    gcSalesCashDebitBalanceAfterUsd: "0.00",
    // Same two figures read as the credit-normal payable, so this path reports
    // the balance the same way every other Golden Coast phase does.
    gcSalesCashPayableBeforeUsd: gcSalesCashPayableBalance(amountUsd),
    gcSalesCashPayableAfterUsd: gcSalesCashPayableBalance("0.00"),
    outstandingHadiCollectionsBeforeUsd: outstanding.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
    outstandingHadiCollectionsAfterUsd: outstanding.plus(amount).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
  };
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
      throw new core.GoldenCoastPhase6AutoHadiError(
        `Automatic HADI collection ${input.clientRequestId} ${item.role} voucher replayed unexpectedly.`,
        "GC_PHASE6_AUTO_HADI_IDEMPOTENCY_INCONSISTENT",
        409
      );
    }
    postings.push({ role: item.role, voucher: posted.voucher, entries: posted.entries });
  }
  await assertTransactionCompanyScope(input.tx, pair.goldenCoastCompanyId);
  postings.push(
    await postPhase15SalesPayableBridge({
      tx: input.tx,
      companyId: input.companyId,
      gcSalesCashAccountId: input.gcSalesCashAccountId,
      saleDate: input.saleDate,
      amountUsd,
      clientRequestId: input.clientRequestId,
      transfer,
      actor: input.actor,
    })
  );

  return { replayed: false, pair, transfer, hadiCashAccount, plan, postings };
}
