// ---------------------------------------------------------------------------
// Financial Reports Service
// Extracted from server/routes/stats/statsSalesRoutes.ts (Phase 9 refactor).
// Routes keep: auth, validation, req/res handling.
// This service: orchestrates storage/DB calls, returns plain data.
// API contracts (URL, params, response shape) are unchanged.
// ---------------------------------------------------------------------------

import { db } from "../../db";
import type Decimal from "decimal.js";
import { MoneyDecimal, sumMoney, toMoney } from "../../lib/money";
import { storage } from "../../storage";
import { vouchers, voucherEntries } from "@shared/schema";
import { eq, and, isNull, inArray, isNotNull, lte } from "drizzle-orm";
import { sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// getProfitLoss — /api/reports/profit-loss
// Returns income/expense breakdown and net profit for the given date range.
// ---------------------------------------------------------------------------
export async function getProfitLoss(
  companyId: number,
  startDate: string | undefined,
  endDate: string | undefined
): Promise<{
  incomeItems: Array<{ id: number; code: string; name: string; accountType: string; balance: number }>;
  expenseItems: Array<{ id: number; code: string; name: string; accountType: string; balance: number }>;
  totalIncome: number;
  totalExpenses: number;
  netProfit: number;
  startDate: string | null;
  endDate: string | null;
}> {
  // Get all ledger accounts for this company
  const companyAccounts = await storage.getAllLedgerAccounts(companyId, true); // Include hidden accounts for financial calculations

  const incomeAccounts = companyAccounts.filter((acc) => acc.accountType === "Income");
  const expenseAccounts = companyAccounts.filter(
    (acc) =>
      acc.accountType === "Expense" || acc.accountType === "Indirect Expense" || acc.accountType === "Direct Expense"
  );

  const incomeAccountIds = incomeAccounts.map((acc) => acc.id);
  const expenseAccountIds = expenseAccounts.map((acc) => acc.id);

  const plConditions = [eq(vouchers.companyId, companyId), eq(vouchers.optional, false), isNull(vouchers.deletedAt)];
  if (startDate) {
    plConditions.push(sql`${vouchers.voucherDate} >= ${startDate}`);
  }
  if (endDate) {
    plConditions.push(sql`${vouchers.voucherDate} <= ${endDate}`);
  }

  // Single JOIN query — replaces two-step (fetch voucher IDs → inArray entries)
  // Only fetch entries for income/expense accounts to avoid reading the whole table
  const allAccountIds = [...incomeAccountIds, ...expenseAccountIds];
  const companyEntries =
    allAccountIds.length > 0
      ? await db
          .select({
            ledgerAccountId: voucherEntries.ledgerAccountId,
            debitAmount: voucherEntries.debitAmount,
            creditAmount: voucherEntries.creditAmount,
          })
          .from(voucherEntries)
          .innerJoin(vouchers, eq(voucherEntries.voucherId, vouchers.id))
          .where(
            and(
              ...plConditions,
              isNotNull(voucherEntries.ledgerAccountId),
              inArray(voucherEntries.ledgerAccountId, allAccountIds)
            )
          )
          .execute()
      : [];

  // Calculate balances for each account
  const exactBalances = new Map<number, Decimal>();

  for (const entry of companyEntries) {
    if (entry.ledgerAccountId) {
      const currentBalance = exactBalances.get(entry.ledgerAccountId) ?? new MoneyDecimal(0);
      exactBalances.set(
        entry.ledgerAccountId,
        currentBalance.plus(toMoney(entry.creditAmount)).minus(toMoney(entry.debitAmount))
      );
    }
  }
  // Exact sums, so an account whose entries cancel reads 0 rather than a float residue.
  const accountBalances = new Map(Array.from(exactBalances, ([id, balance]) => [id, balance.toNumber()] as const));

  // Build income statement
  const incomeItems = incomeAccounts
    .map((acc) => ({
      id: acc.id,
      code: acc.code,
      name: acc.name,
      accountType: acc.accountType,
      balance: accountBalances.get(acc.id) || 0,
    }))
    .filter((item) => item.balance !== 0);

  const expenseItems = expenseAccounts
    .map((acc) => ({
      id: acc.id,
      code: acc.code,
      name: acc.name,
      accountType: acc.accountType,
      balance: accountBalances.get(acc.id) || 0,
    }))
    .filter((item) => item.balance !== 0);

  const totalIncomeExact = sumMoney(incomeItems.map((item) => exactBalances.get(item.id)));
  const totalExpensesExact = sumMoney(expenseItems.map((item) => exactBalances.get(item.id)));
  const totalIncome = totalIncomeExact.toNumber();
  const totalExpenses = totalExpensesExact.toNumber();
  const netProfit = totalIncomeExact.minus(totalExpensesExact).toNumber();

  return {
    incomeItems,
    expenseItems,
    totalIncome,
    totalExpenses,
    netProfit,
    startDate: startDate || null,
    endDate: endDate || null,
  };
}

// ---------------------------------------------------------------------------
// getBalanceSheet — /api/reports/balance-sheet
// Returns assets, liabilities, equity as of the given date.
// ---------------------------------------------------------------------------
export async function getBalanceSheet(
  companyId: number,
  asOfDate: string | undefined
): Promise<{
  assets: {
    ledgers: Array<{ id: number; code: string; name: string; balance: number }>;
    banks: Array<{ id: number; code: string; name: string; balance: number }>;
    fixedAssets: Array<{ id: number; code: string; name: string; balance: number }>;
    total: number;
  };
  liabilities: {
    ledgers: Array<{ id: number; code: string; name: string; balance: number }>;
    suppliers: Array<{ id: number; code: string; name: string; balance: number }>;
    total: number;
  };
  equity: {
    accounts: Array<{ id: number; code: string; name: string; balance: number }>;
    total: number;
  };
  asOfDate: string | null;
}> {
  // Build conditions for voucher date filter
  const conditions = [eq(vouchers.companyId, companyId)];
  if (asOfDate) {
    conditions.push(lte(vouchers.voucherDate, asOfDate));
  }

  // Parallel fetch: all accounts + all entries (JOIN replaces two-step inArray)
  const [ledgers, banks, assets, _employees, suppliers, allEntries] = await Promise.all([
    storage.getAllLedgerAccounts(companyId),
    storage.getAllBankAccounts(companyId),
    storage.getAllFixedAssets(companyId),
    storage.getAllEmployees(companyId),
    storage.getAllSuppliers(),
    db
      .select({
        voucherId: voucherEntries.voucherId,
        ledgerAccountId: voucherEntries.ledgerAccountId,
        bankAccountId: voucherEntries.bankAccountId,
        fixedAssetId: voucherEntries.fixedAssetId,
        supplierId: voucherEntries.supplierId,
        employeeId: voucherEntries.employeeId,
        debitAmount: voucherEntries.debitAmount,
        creditAmount: voucherEntries.creditAmount,
      })
      .from(voucherEntries)
      .innerJoin(vouchers, eq(voucherEntries.voucherId, vouchers.id))
      .where(and(...conditions))
      .execute(),
  ]);

  // Calculate balances
  type Totals = { debits: Decimal; credits: Decimal };
  const none = (): Totals => ({ debits: new MoneyDecimal(0), credits: new MoneyDecimal(0) });
  const ledgerBalances = new Map<number, Totals>();
  const bankBalances = new Map<number, Totals>();
  const assetBalances = new Map<number, Totals>();
  const employeeBalances = new Map<number, Totals>();
  const supplierBalances = new Map<number, Totals>();

  for (const entry of allEntries) {
    const debit = toMoney(entry.debitAmount);
    const credit = toMoney(entry.creditAmount);

    if (entry.ledgerAccountId) {
      const existing = ledgerBalances.get(entry.ledgerAccountId) ?? none();
      ledgerBalances.set(entry.ledgerAccountId, {
        debits: existing.debits.plus(debit),
        credits: existing.credits.plus(credit),
      });
    }

    if (entry.bankAccountId) {
      const existing = bankBalances.get(entry.bankAccountId) ?? none();
      bankBalances.set(entry.bankAccountId, {
        debits: existing.debits.plus(debit),
        credits: existing.credits.plus(credit),
      });
    }

    if (entry.fixedAssetId) {
      const existing = assetBalances.get(entry.fixedAssetId) ?? none();
      assetBalances.set(entry.fixedAssetId, {
        debits: existing.debits.plus(debit),
        credits: existing.credits.plus(credit),
      });
    }

    if (entry.supplierId) {
      const existing = supplierBalances.get(entry.supplierId) ?? none();
      // Only count pure credit or pure debit entries to prevent double-counting
      // This matches the logic in /api/suppliers/stats
      if (credit.gt(0) && debit.isZero()) {
        supplierBalances.set(entry.supplierId, {
          debits: existing.debits,
          credits: existing.credits.plus(credit),
        });
      } else if (debit.gt(0) && credit.isZero()) {
        supplierBalances.set(entry.supplierId, {
          debits: existing.debits.plus(debit),
          credits: existing.credits,
        });
      }
    }

    if (entry.employeeId) {
      const existing = employeeBalances.get(entry.employeeId) ?? none();
      employeeBalances.set(entry.employeeId, {
        debits: existing.debits.plus(debit),
        credits: existing.credits.plus(credit),
      });
    }
  }

  // Categorize and calculate net balances
  const assetAccounts = ledgers
    .filter((l) => l.accountType === "Asset")
    .map((acc) => {
      const bal = ledgerBalances.get(acc.id) ?? none();
      const openingBalance = toMoney(acc.openingBalance);
      return {
        id: acc.id,
        code: acc.code,
        name: acc.name,
        balance: openingBalance.plus(bal.debits).minus(bal.credits).toNumber(),
      };
    });

  const bankAccountItems = banks.map((bank) => {
    const bal = bankBalances.get(bank.id) ?? none();
    const openingBalance = toMoney(bank.openingBalance);
    return {
      id: bank.id,
      code: bank.accountNumber,
      name: bank.bankName,
      balance: openingBalance.plus(bal.debits).minus(bal.credits).toNumber(),
    };
  });

  const fixedAssetAccounts = assets.map((asset) => {
    const bal = assetBalances.get(asset.id) ?? none();
    const purchaseValue = toMoney(asset.purchaseAmount);
    return {
      id: asset.id,
      code: asset.code,
      name: asset.name,
      balance: purchaseValue.plus(bal.debits).minus(bal.credits).toNumber(),
    };
  });

  const liabilityAccounts = ledgers
    .filter((l) => l.accountType === "Liability")
    .map((acc) => {
      const bal = ledgerBalances.get(acc.id) ?? none();
      const openingBalance = toMoney(acc.openingBalance);
      return {
        id: acc.id,
        code: acc.code,
        name: acc.name,
        balance: openingBalance.plus(bal.credits).minus(bal.debits).toNumber(),
      };
    });

  const supplierAccounts = suppliers
    .map((supplier) => {
      const bal = supplierBalances.get(supplier.id) ?? none();
      return {
        id: supplier.id,
        code: supplier.code,
        name: supplier.legalName,
        balance: bal.credits.minus(bal.debits).toNumber(),
      };
    })
    .filter((s) => s.balance !== 0);

  const equityAccounts = ledgers
    .filter((l) => l.accountType === "Equity")
    .map((acc) => {
      const bal = ledgerBalances.get(acc.id) ?? none();
      const openingBalance = toMoney(acc.openingBalance);
      return {
        id: acc.id,
        code: acc.code,
        name: acc.name,
        balance: openingBalance.plus(bal.credits).minus(bal.debits).toNumber(),
      };
    });

  // Each balance above is an exact sum read once as a number, so these totals re-add short decimals.
  const totalAssets = sumMoney(
    [...assetAccounts, ...bankAccountItems, ...fixedAssetAccounts].map((item) => item.balance)
  ).toNumber();

  const totalLiabilities = sumMoney([...liabilityAccounts, ...supplierAccounts].map((item) => item.balance)).toNumber();

  const totalEquity = sumMoney(equityAccounts.map((item) => item.balance)).toNumber();

  return {
    assets: {
      ledgers: assetAccounts.filter((a) => a.balance !== 0),
      banks: bankAccountItems.filter((b) => b.balance !== 0),
      fixedAssets: fixedAssetAccounts.filter((f) => f.balance !== 0),
      total: totalAssets,
    },
    liabilities: {
      ledgers: liabilityAccounts.filter((l) => l.balance !== 0),
      suppliers: supplierAccounts,
      total: totalLiabilities,
    },
    equity: {
      accounts: equityAccounts.filter((e) => e.balance !== 0),
      total: totalEquity,
    },
    asOfDate: asOfDate || null,
  };
}
