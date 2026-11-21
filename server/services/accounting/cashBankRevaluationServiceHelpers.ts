// Extracted from ./cashBankRevaluationService.ts
import Decimal from "decimal.js";
import { and, eq, isNull, or } from "drizzle-orm";
import { db } from "../../db";
import { bankAccounts, ledgerAccounts } from "@shared/schema";

export const DP_AMOUNT = 6;

export const DP_RATE = 10;

export interface NativeBalancesByCurrency {
  [currency: string]: string;
}

export interface CashBankCurrencySummary {
  accountKind: "ledger" | "bank";
  id: number;
  linkedLedgerId: number | null;
  name: string;
  code: string;
  accountType: string;
  nativeBalancesByCurrency: NativeBalancesByCurrency;
  historicalBaseBalance: string;
  currentTranslatedBaseBalance: string | null;
  translationDifference: string | null;
  currentCfaPerUsd: string | null;
  currentZmwPerUsd: string | null;
  currentRateMissing: boolean;
  openingBalanceCurrencyUnresolved: boolean;
  unresolvedOpeningBalanceRaw: string | null;
  unresolvedLegacyEntryCount: number;
  unresolvedLegacyNetRaw: string;
  unresolvedTranslationCurrencies: string[];
  totalsProvisional: boolean;
}

export interface AccountRow {
  accountKind: "ledger" | "bank";
  id: number;
  linkedLedgerId: number | null;
  name: string;
  code: string;
  accountType: string;
  openingBalance: string | null;
  openingBalanceSide: string | null;
  openingBalanceNativeAmount: string | null;
  openingBalanceCurrency: string | null;
  openingBalanceHistoricalRate: string | null;
  openingBalanceBaseAmount: string | null;
}

export interface AggregateRow {
  account_id: string;
  entry_currency: string;
  native_debit: string;
  native_credit: string;
  hist_base_debit: string;
  hist_base_credit: string;
  unresolved_count: string;
  unresolved_raw_net: string;
}

export function amount(value: string | number | null | undefined): Decimal {
  try {
    const d = new Decimal(value ?? 0);
    return d.isFinite() ? d : new Decimal(0);
  } catch {
    return new Decimal(0);
  }
}

/**
 * How bank lines are attributed.
 *
 *   - "legacy" (the account pages' default): a bank's aggregate is every line
 *     naming the bank, and a bank linked to a Cash/Bank ledger
 *     (bank_accounts.linked_ledger_id) is represented by that ledger account,
 *     its own row dropped — with its opening and bank-only lines.
 *   - "engine" (net position, wave 10 part 3): the balance engine's rule
 *     (balances/ledgerBalanceEngine.ts). A line naming a ledger account belongs
 *     to the ledger account, so a bank's aggregate is only the lines that name
 *     the bank and no ledger account, and every bank keeps its own row (linked
 *     or not): the ledger and the bank never share a line or an opening.
 */
export type CashBankAttribution = "legacy" | "engine";

export interface CashBankRevaluationOptions {
  attribution?: CashBankAttribution;
  /** Current snapshot rate date (default company business date). Does not date-cut voucher balances. */
  asOf?: string;
}

export async function loadAccounts(companyId: number, attribution: CashBankAttribution): Promise<AccountRow[]> {
  const [ledgers, banks] = await Promise.all([
    db
      .select({
        id: ledgerAccounts.id,
        name: ledgerAccounts.name,
        code: ledgerAccounts.code,
        accountType: ledgerAccounts.accountType,
        openingBalance: ledgerAccounts.openingBalance,
        openingBalanceSide: ledgerAccounts.openingBalanceSide,
        openingBalanceNativeAmount: ledgerAccounts.openingBalanceNativeAmount,
        openingBalanceCurrency: ledgerAccounts.openingBalanceCurrency,
        openingBalanceHistoricalRate: ledgerAccounts.openingBalanceHistoricalRate,
        openingBalanceBaseAmount: ledgerAccounts.openingBalanceBaseAmount,
      })
      .from(ledgerAccounts)
      .where(
        and(
          eq(ledgerAccounts.companyId, companyId),
          isNull(ledgerAccounts.deletedAt),
          or(eq(ledgerAccounts.accountType, "Bank"), eq(ledgerAccounts.accountType, "Cash"))
        )
      ),
    db
      .select({
        id: bankAccounts.id,
        linkedLedgerId: bankAccounts.linkedLedgerId,
        name: bankAccounts.name,
        code: bankAccounts.code,
        openingBalance: bankAccounts.openingBalance,
        openingBalanceSide: bankAccounts.openingBalanceSide,
        openingBalanceNativeAmount: bankAccounts.openingBalanceNativeAmount,
        openingBalanceCurrency: bankAccounts.openingBalanceCurrency,
        openingBalanceHistoricalRate: bankAccounts.openingBalanceHistoricalRate,
        openingBalanceBaseAmount: bankAccounts.openingBalanceBaseAmount,
      })
      .from(bankAccounts)
      .where(and(eq(bankAccounts.companyId, companyId), isNull(bankAccounts.deletedAt))),
  ]);

  const rows: AccountRow[] = ledgers.map((row) => ({
    accountKind: "ledger",
    id: row.id,
    linkedLedgerId: null,
    name: row.name,
    code: row.code,
    accountType: row.accountType,
    openingBalance: row.openingBalance,
    openingBalanceSide: row.openingBalanceSide,
    openingBalanceNativeAmount: row.openingBalanceNativeAmount,
    openingBalanceCurrency: row.openingBalanceCurrency,
    openingBalanceHistoricalRate: row.openingBalanceHistoricalRate,
    openingBalanceBaseAmount: row.openingBalanceBaseAmount,
  }));

  // A linked bank is represented by its ledger account to avoid double-counting.
  const representedLedgerIds = new Set(rows.map((row) => row.id));
  for (const row of banks) {
    if (attribution === "legacy" && row.linkedLedgerId && representedLedgerIds.has(row.linkedLedgerId)) continue;
    rows.push({
      accountKind: "bank",
      id: row.id,
      linkedLedgerId: row.linkedLedgerId ?? null,
      name: row.name,
      code: row.code,
      accountType: "Bank",
      openingBalance: row.openingBalance,
      openingBalanceSide: row.openingBalanceSide,
      openingBalanceNativeAmount: row.openingBalanceNativeAmount,
      openingBalanceCurrency: row.openingBalanceCurrency,
      openingBalanceHistoricalRate: row.openingBalanceHistoricalRate,
      openingBalanceBaseAmount: row.openingBalanceBaseAmount,
    });
  }
  return rows;
}
