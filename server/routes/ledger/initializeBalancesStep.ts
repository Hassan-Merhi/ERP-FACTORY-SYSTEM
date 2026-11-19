// Extracted from ./initialize-balances.ts: a stage of initialize-balances.
import { db, type RawQueryRow } from "../../db";
import { MoneyDecimal, toMoney } from "../../lib/money";
import { ledgerAccounts, containers, vouchers, voucherEntries, bankAccounts } from "@shared/schema";
import { eq, and, or, inArray, sql, isNull, isNotNull } from "drizzle-orm";
import type { storage } from "../../storage";
import type { AccountBalanceAggregateRow } from "./initialize-balances";

export async function initializeBalancesStep({
  company,
}: {
  company: Awaited<ReturnType<typeof storage.getAllCompanies>>[number];
}) {
  const companyId = company.id;

  // Single-query aggregate replaces N+1 (fetch accounts → per-account entry fetch)
  const getAccountTypeBalance = async (accountType: string, isLiability: boolean = false) => {
    const rows = await db.execute<RawQueryRow<AccountBalanceAggregateRow>>(sql`
              SELECT
                la.opening_balance,
                la.opening_balance_side,
                COALESCE(SUM(CAST(ve.debit_amount  AS numeric)), 0) AS total_debit,
                COALESCE(SUM(CAST(ve.credit_amount AS numeric)), 0) AS total_credit
              FROM ledger_accounts la
              LEFT JOIN voucher_entries ve
                ON  ve.ledger_account_id = la.id
                AND ve.voucher_id IN (
                  SELECT id FROM vouchers
                   WHERE company_id  = ${companyId}
                     AND optional    = false
                     AND deleted_at IS NULL
                )
              WHERE la.company_id   = ${companyId}
                AND la.account_type = ${accountType}
                AND la.deleted_at  IS NULL
              GROUP BY la.id, la.opening_balance, la.opening_balance_side
            `);

    let totalBalance = new MoneyDecimal(0);
    for (const row of rows.rows) {
      const openingBalanceRaw = toMoney(row.opening_balance);
      const openingSide = row.opening_balance_side || "Dr";
      const signedOpening = isLiability
        ? openingSide === "Cr"
          ? openingBalanceRaw
          : openingBalanceRaw.negated()
        : openingSide === "Dr"
          ? openingBalanceRaw
          : openingBalanceRaw.negated();
      const debit = toMoney(row.total_debit);
      const credit = toMoney(row.total_credit);
      totalBalance = totalBalance.plus(signedOpening).plus(isLiability ? credit.minus(debit) : debit.minus(credit));
    }
    return totalBalance.toNumber();
  };

  // Helper function: Get Import Charges balance (only under IMPORT_CHARGES parent account)
  // This must match the calculation in the import-cycle-balance endpoint
  const getImportChargesBalance = async () => {
    // First find the IMPORT_CHARGES parent account
    const [importChargesParent] = await db
      .select()
      .from(ledgerAccounts)
      .where(
        and(
          eq(ledgerAccounts.companyId, companyId),
          eq(ledgerAccounts.code, "IMPORT_CHARGES"),
          isNull(ledgerAccounts.deletedAt)
        )
      )
      .limit(1);

    if (!importChargesParent) {
      return 0; // No import charges yet
    }

    // Get all accounts under IMPORT_CHARGES parent (including the parent itself)
    const importChargeAccounts = await db
      .select()
      .from(ledgerAccounts)
      .where(
        and(
          eq(ledgerAccounts.companyId, companyId),
          or(eq(ledgerAccounts.id, importChargesParent.id), eq(ledgerAccounts.parentId, importChargesParent.id)),
          isNull(ledgerAccounts.deletedAt)
        )
      );

    if (importChargeAccounts.length === 0) {
      return 0;
    }

    const accountIds = importChargeAccounts.map((a) => a.id);

    // Get opening balances
    let totalBalance = importChargeAccounts.reduce((sum, account) => {
      const openingBalanceRaw = toMoney(account.openingBalance);
      const openingSide = account.openingBalanceSide || "Dr";
      // Expense accounts: Dr opening = positive
      return sum.plus(openingSide === "Dr" ? openingBalanceRaw : openingBalanceRaw.negated());
    }, new MoneyDecimal(0));

    // Get all voucher entries for these accounts
    const entries = await db
      .select({
        creditAmount: voucherEntries.creditAmount,
        debitAmount: voucherEntries.debitAmount,
      })
      .from(voucherEntries)
      .innerJoin(vouchers, eq(voucherEntries.voucherId, vouchers.id))
      .where(
        and(
          inArray(voucherEntries.ledgerAccountId, accountIds),
          eq(vouchers.companyId, companyId),
          isNull(vouchers.deletedAt),
          eq(vouchers.optional, false)
        )
      );

    // Expense accounts: Debits increase (positive), Credits decrease (negative)
    totalBalance = entries.reduce((sum, entry) => {
      const credit = toMoney(entry.creditAmount);
      const debit = toMoney(entry.debitAmount);
      return sum.plus(debit).minus(credit);
    }, totalBalance);

    return totalBalance.toNumber();
  };

  // Calculate all balances (same logic as import-cycle-balance endpoint)
  // 1. Supplier Balance - calculated from voucher entries only (company-scoped)
  // NOTE: Supplier opening balances are global and cannot be attributed to a single company
  // Future enhancement: Add per-company supplier opening balances table
  const supplierEntries = await db
    .select({
      creditAmount: voucherEntries.creditAmount,
      debitAmount: voucherEntries.debitAmount,
    })
    .from(voucherEntries)
    .innerJoin(vouchers, eq(voucherEntries.voucherId, vouchers.id))
    .where(
      and(
        isNotNull(voucherEntries.supplierId),
        eq(vouchers.companyId, companyId),
        isNull(vouchers.deletedAt),
        eq(vouchers.optional, false)
      )
    );

  // Supplier is a liability: Credits increase (we owe more), Debits decrease (we paid)
  const supplierBalance = supplierEntries
    .reduce(
      (sum, entry) => sum.plus(toMoney(entry.creditAmount)).minus(toMoney(entry.debitAmount)),
      new MoneyDecimal(0)
    )
    .toNumber();

  // 2. Stock OTW
  const otwContainers = await db
    .select()
    .from(containers)
    .where(and(eq(containers.companyId, companyId), eq(containers.status, "OTW")));
  const stockOtwValue = otwContainers
    .reduce((sum, container) => sum.plus(toMoney(container.grandTotal)), new MoneyDecimal(0))
    .toNumber();

  // 3-10: All independent — run in parallel
  const [
    dutyAgentBalance,
    transporterAgentBalance,
    loansBalance,
    cashBalance,
    ledgerBankBalance,
    standaloneBankAccountEntries,
    standaloneBankAccountsForBalance,
    directExpenseBalance,
    indirectExpenseBalance,
    incomeBalance,
  ] = await Promise.all([
    getAccountTypeBalance("Duty Agent", true),
    getAccountTypeBalance("Transporter Agent", true),
    getAccountTypeBalance("Loans", true),
    getAccountTypeBalance("Cash", false),
    getAccountTypeBalance("Bank", false),
    db
      .select({
        bankAccountId: voucherEntries.bankAccountId,
        creditAmount: voucherEntries.creditAmount,
        debitAmount: voucherEntries.debitAmount,
      })
      .from(voucherEntries)
      .innerJoin(vouchers, eq(voucherEntries.voucherId, vouchers.id))
      .innerJoin(bankAccounts, eq(voucherEntries.bankAccountId, bankAccounts.id))
      .where(
        and(
          isNotNull(voucherEntries.bankAccountId),
          isNull(voucherEntries.ledgerAccountId),
          isNull(bankAccounts.linkedLedgerId),
          eq(bankAccounts.companyId, companyId),
          isNull(bankAccounts.deletedAt),
          eq(vouchers.companyId, companyId),
          isNull(vouchers.deletedAt),
          eq(vouchers.optional, false)
        )
      ),
    db
      .select()
      .from(bankAccounts)
      .where(
        and(eq(bankAccounts.companyId, companyId), isNull(bankAccounts.deletedAt), isNull(bankAccounts.linkedLedgerId))
      ),
    getImportChargesBalance(),
    getAccountTypeBalance("Indirect Expense", false),
    getAccountTypeBalance("Income", true),
  ]);

  const standaloneBankOpeningBalance = standaloneBankAccountsForBalance.reduce((sum, account) => {
    const openingBalanceRaw = toMoney(account.openingBalance);
    const openingSide = account.openingBalanceSide || "Dr";
    return sum.plus(openingSide === "Dr" ? openingBalanceRaw : openingBalanceRaw.negated());
  }, new MoneyDecimal(0));
  const standaloneBankVoucherBalance = standaloneBankAccountEntries.reduce(
    (sum, entry) => sum.plus(toMoney(entry.debitAmount)).minus(toMoney(entry.creditAmount)),
    new MoneyDecimal(0)
  );

  return {
    companyId,
    getAccountTypeBalance,
    supplierBalance,
    stockOtwValue,
    dutyAgentBalance,
    transporterAgentBalance,
    loansBalance,
    cashBalance,
    ledgerBankBalance,
    directExpenseBalance,
    indirectExpenseBalance,
    incomeBalance,
    standaloneBankOpeningBalance,
    standaloneBankVoucherBalance,
  };
}
