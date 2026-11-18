// Extracted from ./employeeNetPositionRoutes.ts: dated FX rates and ledger balances for the Factory Net Position.
import {
  netPositionRecordedThrough,
  netPositionKnownTransactionThrough,
  netPositionVoucherEntryKnown,
} from "../../../services/factory/netPositionAsOf";
import { db } from "../../../db";
import { sql, eq, and, inArray, isNull } from "drizzle-orm";
import { toMoney } from "../../../lib/money";
import type { FactoryNetPositionAsOf } from "@shared/factoryNetPositionAsOf";
import { loadFxWalletHistoryGaps } from "../../../services/factory/netPositionFxWalletCoverage";
import {
  fxAgentTablesExist,
  loadFxAgentWallets,
  getFxAgentWalletSnapshot,
} from "../../../services/factory/fxAgentWalletDb";
import { getAccountNetBalance, type AccountLike } from "../../../netPositionHelper";
import { customers, ledgerAccounts, voucherEntries, vouchers } from "@shared/schema";
import { loadHeldChargeSnapshot } from "../customers-core/heldUnfinalizedCustomerCharges";
import type Decimal from "decimal.js";
import { ledgerCarriesStock } from "../../../services/accounting/perpetualInventory/reportBasis";
import type { loadFactoryNetPositionEmployees } from "../../../services/factory/netPositionEmployees";
import type { loadFactoryHistoricalCoverage } from "../../../services/factory/netPositionHistoryCoverage";

type LoadFactoryHistoricalCoverageResult = Awaited<ReturnType<typeof loadFactoryHistoricalCoverage>>;
type LoadFactoryNetPositionEmployeesResult = Awaited<ReturnType<typeof loadFactoryNetPositionEmployees>>;
type LoadNetPositionConfigFxResult = Awaited<ReturnType<typeof loadNetPositionConfigFx>>;

export async function loadNetPositionConfigFx({
  companyId,
  asOf,
  asOfContext,
}: {
  companyId: number;
  asOf: string;
  asOfContext: FactoryNetPositionAsOf;
}) {
  // Load user-configured display FX rates (set in Settings → FX Rates)
  const fxRateRows = await db.execute(sql`
        SELECT DISTINCT ON (currency_code) currency_code, rate_to_usd
        FROM factory_fx_rates
        WHERE company_id = ${companyId} AND source = 'manual' AND effective_date <= ${asOf}::date
          ${
            asOfContext.isHistorical
              ? sql`AND ${netPositionRecordedThrough(sql`created_at`, asOfContext, "utc-naive-timestamp")}`
              : sql``
          }
        ORDER BY currency_code, effective_date DESC, created_at DESC, id DESC
      `);
  const configFxRates: Record<string, number> = {};
  for (const row of fxRateRows.rows) {
    const currency = String(row.currency_code ?? "")
      .trim()
      .toUpperCase();
    if (currency) configFxRates[currency] = toMoney(row.rate_to_usd as string).toNumber();
  }
  // Only use manually configured rates — no hardcoded fallbacks
  const getConfigFx = (cc: string): number => {
    const currency = cc.trim().toUpperCase();
    if (currency === "USD") return 1;
    const rate = configFxRates[currency];
    if (!rate || !Number.isFinite(rate) || rate <= 0) throw new Error(`Missing confirmed USD exchange rate for ${cc}`);
    return rate;
  };

  return { configFxRates, getConfigFx };
}

export async function loadNetPositionLedgerBalances({
  companyId,
  asOfContext,
  employeeBalances,
  asOf,
  historyCoverage,
  configFxRates,
  round2,
}: {
  companyId: number;
  asOfContext: FactoryNetPositionAsOf;
  employeeBalances: LoadFactoryNetPositionEmployeesResult;
  asOf: string;
  historyCoverage: LoadFactoryHistoricalCoverageResult | null;
  configFxRates: LoadNetPositionConfigFxResult["configFxRates"];
  round2: (n: number) => number;
}) {
  // ── 2. ERP ledger account balances for the factory company ──────────
  const factoryAccounts = await db
    .select()
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.companyId, companyId),
        asOfContext.isHistorical
          ? sql`(${ledgerAccounts.deletedAt} IS NULL OR NOT ${netPositionRecordedThrough(sql`${ledgerAccounts.deletedAt}`, asOfContext, "utc-naive-timestamp")})`
          : isNull(ledgerAccounts.deletedAt),
        asOfContext.isHistorical
          ? netPositionRecordedThrough(sql`${ledgerAccounts.createdAt}`, asOfContext, "utc-naive-timestamp")
          : sql`TRUE`
      )
    );

  // Ledger lines on legacy EMP-<code> accounts also mutate the employee
  // cached balance. For historic snapshots their voucher movement belongs
  // on the employee row exactly once; retain any ledger ACCOUNT OPENING.
  // Exact match, as netPositionEmployees and employeeBalancePosting map them.
  const historicalEmployeeCodes = new Set(employeeBalances.map((e) => `EMP-${e.code}`));
  const legacyEmployeeLedgerIds = new Set(
    asOfContext.isHistorical
      ? factoryAccounts.filter((a) => a.code && historicalEmployeeCodes.has(a.code)).map((a) => a.id)
      : []
  );
  const countedAsEmployee = (e: { ledgerAccountId: number | null; employeeId: number | null }) =>
    asOfContext.isHistorical &&
    e.employeeId == null &&
    e.ledgerAccountId != null &&
    legacyEmployeeLedgerIds.has(e.ledgerAccountId);

  const factoryVouchers = await db
    .select({ id: vouchers.id })
    .from(vouchers)
    .where(
      and(
        eq(vouchers.companyId, companyId),
        eq(vouchers.optional, false),
        asOfContext.isHistorical
          ? sql`(${vouchers.deletedAt} IS NULL OR NOT ${netPositionRecordedThrough(sql`${vouchers.deletedAt}`, asOfContext, "utc-naive-timestamp")})`
          : isNull(vouchers.deletedAt),
        asOfContext.isHistorical
          ? netPositionKnownTransactionThrough(
              sql`COALESCE(${vouchers.effectiveDate}, ${vouchers.voucherDate})`,
              sql`${vouchers.createdAt}`,
              asOfContext,
              "utc-naive-timestamp"
            )
          : sql`COALESCE(${vouchers.effectiveDate}, ${vouchers.voucherDate}) <= ${asOf}`
      )
    );

  const fVoucherIds = factoryVouchers.map((v) => v.id);
  const factoryEntries =
    fVoucherIds.length > 0
      ? await db
          .select()
          .from(voucherEntries)
          .where(
            and(
              inArray(voucherEntries.voucherId, fVoucherIds),
              asOfContext.isHistorical
                ? netPositionVoucherEntryKnown(
                    sql`${voucherEntries.createdAt}`,
                    sql`${voucherEntries.voucherId}`,
                    asOfContext
                  )
                : sql`TRUE`
            )
          )
      : [];

  const exactBalances = new Map<number, { debit: Decimal; credit: Decimal }>();
  for (const e of factoryEntries) {
    if (!e.ledgerAccountId || countedAsEmployee(e)) continue;
    const cur = exactBalances.get(e.ledgerAccountId);
    exactBalances.set(e.ledgerAccountId, {
      debit: toMoney(e.debitAmount).plus(cur?.debit ?? 0),
      credit: toMoney(e.creditAmount).plus(cur?.credit ?? 0),
    });
  }
  const accBalances = new Map<number, { debit: number; credit: number }>();
  for (const [id, { debit, credit }] of exactBalances) {
    accBalances.set(id, { debit: debit.toNumber(), credit: credit.toNumber() });
  }

  // ── 2b. Classify accounts using the shared ERP formula ─────────────────
  // Factory-specific clearing/cost codes must not appear in net position:
  //   FACTORY_IMPORT_COST   – Dr side of goods-received journal; liability already in supplier balances
  //   FACTORY_CHARGES_PAYABLE – Dr side of other-charges journal; cost entry, not an asset
  //   FREIGHT / OC_OTHER_CHARGE – factory cost clearing codes
  const factoryExcludedCodes = new Set([
    "FACTORY_IMPORT_COST",
    "FACTORY_CHARGES_PAYABLE",
    "FACTORY_OC_EXPENSE",
    "OC_OTHER_CHARGE",
    "PRODUCTION_ADJUSTMENT",
    "CONSUMPTION_EXPENSE",
    "FREIGHT",
  ]);

  // Perpetual inventory (wave 8.5): from the cut-over the ledger carries the
  // factory's stock (raw material, work in progress, finished goods).
  const ledgerStock = await ledgerCarriesStock(companyId, asOf);
  // ── 2c. Customer balances — ALL customers, authoritative formula ─────────
  // Customer ledger accounts can carry premature CHARGE-PRE debits.
  // The Parties page and this page now share one reconciled projection.
  // To avoid counting a linked account twice we:
  //   a) exclude customer-owned ledger accounts from the ledger classification, and
  //   b) compute every customer's balance via the same formula as the Customers page.
  const allCustomersForNP = await db
    .select()
    .from(customers)
    .where(
      and(
        eq(customers.companyId, companyId),
        asOfContext.isHistorical
          ? sql`(${customers.deletedAt} IS NULL OR NOT ${netPositionRecordedThrough(sql`${customers.deletedAt}`, asOfContext, "utc-naive-timestamp")})`
          : isNull(customers.deletedAt),
        asOfContext.isHistorical
          ? netPositionRecordedThrough(sql`${customers.createdAt}`, asOfContext, "utc-naive-timestamp")
          : sql`TRUE`
      )
    );

  // The previous code hid pre-finalization customer debits in the statement
  // while keeping them on Parties AND in the net-position account totals.
  // Exclude BOTH sides of the same premature voucher from this projected
  // dashboard (the trial balance remains the unmodified ledger).
  const heldSnapshot = await loadHeldChargeSnapshot(
    companyId,
    allCustomersForNP.map((c) => c.id),
    asOf,
    asOfContext.isHistorical ? asOfContext : undefined
  );
  let projectedAccountBalances = accBalances;
  if (heldSnapshot.voucherIds.size > 0) {
    const netByAccount = new Map<number, { debit: Decimal; credit: Decimal }>();
    for (const entry of factoryEntries) {
      if (!entry.ledgerAccountId || heldSnapshot.voucherIds.has(entry.voucherId) || countedAsEmployee(entry)) continue;
      const current = netByAccount.get(entry.ledgerAccountId);
      netByAccount.set(entry.ledgerAccountId, {
        debit: toMoney(entry.debitAmount).plus(current?.debit ?? 0),
        credit: toMoney(entry.creditAmount).plus(current?.credit ?? 0),
      });
    }
    projectedAccountBalances = new Map(
      [...netByAccount].map(([id, value]) => [id, { debit: value.debit.toNumber(), credit: value.credit.toNumber() }])
    );
  }

  // Revalue only specifically activated FX-agent ledger accounts for the
  // current/as-of Net Position display. No voucher/book amount is mutated.
  // If an account was changed outside the wallet, leave the historic book
  // balance visible and return a warning rather than invent an FX amount.
  const fxAgentWallets: Array<{
    accountId: number;
    name: string;
    eur: string;
    usd: string;
    currentUsd: string | null;
    rate: string | null;
    synchronized: boolean;
  }> = [];
  const fxAgentWalletWarnings: string[] = [];
  // Keep verified wallet native-rate movement outside the posted ledger
  // row, so it appears in the same net-position FX gain/loss accounts as
  // supplier and other monetary currency movements.
  const walletFxDifferences = new Map<number, { name: string; delta: number }>();
  if (await fxAgentTablesExist()) {
    if (historyCoverage && asOfContext.isHistorical) {
      historyCoverage.gaps.push(...(await loadFxWalletHistoryGaps(companyId, asOfContext)));
    }
    const wallets = await loadFxAgentWallets(companyId, asOf, db, asOfContext.isHistorical ? asOfContext : undefined);
    projectedAccountBalances = new Map(projectedAccountBalances);
    for (const wallet of wallets) {
      const account = factoryAccounts.find((a) => a.id === wallet.ledgerAccountId);
      if (!account) continue;
      const rate = configFxRates.EUR ? String(configFxRates.EUR) : null;
      const projectedBook = toMoney(getAccountNetBalance(account as AccountLike, projectedAccountBalances));
      const snapshot = await getFxAgentWalletSnapshot(
        wallet,
        asOf,
        db,
        rate,
        asOfContext.isHistorical ? { scope: asOfContext, ledgerBookUsd: projectedBook.toFixed(6) } : undefined
      );
      const matching = snapshot.synchronized && projectedBook.minus(snapshot.state.totalBookUsd).abs().lte("0.01");
      fxAgentWallets.push({
        accountId: account.id,
        name: account.name,
        eur: snapshot.state.eur,
        usd: snapshot.state.usd,
        currentUsd: snapshot.currentUsd,
        rate,
        synchronized: matching,
      });
      if (!matching || snapshot.currentUsd === null) {
        fxAgentWalletWarnings.push(
          !matching
            ? account.name + ": FX wallet and posted ledger do not agree; showing historical ledger value"
            : account.name + ": Set EUR rate in Factory Settings to value this FX balance"
        );
        continue;
      }
      const change = toMoney(snapshot.currentUsd).minus(projectedBook);
      if (asOfContext.isHistorical) {
        // Historical snapshots retain their existing dated wallet valuation
        // and never acquire new FX display rows.
        const before = projectedAccountBalances.get(account.id) || { debit: 0, credit: 0 };
        projectedAccountBalances.set(account.id, {
          debit: before.debit + (change.gt(0) ? change.toNumber() : 0),
          credit: before.credit + (change.lt(0) ? change.negated().toNumber() : 0),
        });
      } else if (!change.isZero()) {
        walletFxDifferences.set(account.id, { name: account.name, delta: round2(change.toNumber()) });
      }
    }
  }

  return {
    factoryAccounts,
    factoryExcludedCodes,
    ledgerStock,
    allCustomersForNP,
    projectedAccountBalances,
    fxAgentWallets,
    fxAgentWalletWarnings,
    walletFxDifferences,
  };
}
