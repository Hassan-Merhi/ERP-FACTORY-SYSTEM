// ---------------------------------------------------------------------------
// Dashboard Stats Service
// Extracted from server/routes/stats/statsDataRoutes.ts (Phase 9 refactor).
// Routes keep: auth, validation, req/res handling.
// This service: orchestrates storage/DB calls, returns plain data.
// API contracts (URL, params, response shape) are unchanged.
// ---------------------------------------------------------------------------

import { db } from "../../db";
import { storage } from "../../storage";
import { vouchers, voucherEntries } from "@shared/schema";
import { eq, and, isNull, inArray } from "drizzle-orm";
import { _getCached, _setCached } from "../shared/ttlCache";

// ---------------------------------------------------------------------------
// getMonthlyData — /api/stats/monthly-data
// Returns last 6 months of sales volume and profit for dashboard charts.
// ---------------------------------------------------------------------------
export async function getMonthlyData(
  companyId: number
): Promise<Array<{ month: string; sales: number; profit: number }>> {
  // Get all Sales vouchers for this company (excluding optional)
  const salesVouchers = await db
    .select()
    .from(vouchers)
    .where(
      and(
        eq(vouchers.companyId, companyId),
        eq(vouchers.voucherType, "Sales"),
        isNull(vouchers.deletedAt),
        eq(vouchers.optional, false)
      )
    )
    .execute();

  // Get all Income and Expense ledger accounts
  const companyAccounts = await storage.getAllLedgerAccounts(companyId, true); // Include hidden accounts for financial calculations
  const incomeAccountIds = companyAccounts.filter((acc) => acc.accountType === "Income").map((acc) => acc.id);

  // Include ALL expenses in monthly profit calculation for consistency with P&L report
  // PURCHASES are now included (previously excluded) to match P&L calculation
  // Only exclude container-related import charges that are capitalized to inventory
  const excludedExpenseCodes = [
    "IMPORTCHARGES", // Old consolidated import charges (deprecated, capitalized)
    "IMPORT_CHARGES", // Alternative format
    "DUTIES", // Container import duties (capitalized)
    "DUT", // Abbreviated duties code
    "TRANSPORTCHARGES", // Container transport costs (capitalized)
    "TRANSPORT", // Alternative transport account name (capitalized)
    "TRA", // Abbreviated transport code
    "TRANSFER_CHARGES", // Transfer charges (capitalized)
    "CONTAINERLICENSES", // Container license fees (capitalized)
    "CONLIC", // Abbreviated container licenses
    "LICENSES", // Alternative license account name (capitalized)
    "LIC", // Abbreviated licenses code
  ];

  // Name patterns to exclude (container-related costs only)
  const excludedNamePatterns = ["duties", "transport charges", "container license", "import charge", "transfer charge"];

  // Normalize function: uppercase + remove spaces/underscores for comparison
  const normalizeCode = (code: string) => code.toUpperCase().replace(/[\s_-]/g, "");

  const expenseAccounts = companyAccounts.filter((acc) => {
    // Include Purchase accounts by code (for P&L consistency)
    const isPurchaseAccount = acc.code === "PURCHASES" || acc.code?.startsWith("PURCHASES-");
    if (isPurchaseAccount) return true;

    // Support both correct format (accountType="Expense") and legacy format
    // (accountType="Indirect Expense" or "Direct Expense")
    const isExpenseAccount =
      acc.accountType === "Expense" || acc.accountType === "Indirect Expense" || acc.accountType === "Direct Expense";

    if (!isExpenseAccount) return false;

    // Check if code matches exclusion list
    const normalizedCode = normalizeCode(acc.code);
    const codeExcluded = excludedExpenseCodes.some((excluded) => normalizeCode(excluded) === normalizedCode);

    // Check if name contains excluded patterns
    const nameLower = (acc.name || "").toLowerCase();
    const nameExcluded = excludedNamePatterns.some((pattern) => nameLower.includes(pattern));

    // Exclude if either code or name matches
    return !codeExcluded && !nameExcluded;
  });
  const expenseAccountIds = expenseAccounts.map((acc) => acc.id);

  // Single JOIN query: fetch entries with their voucher dates — replaces two-step
  // (previously: fetch companyVouchers → extract IDs → inArray(voucherEntries))
  const companyEntriesRaw = await db
    .select({
      ledgerAccountId: voucherEntries.ledgerAccountId,
      debitAmount: voucherEntries.debitAmount,
      creditAmount: voucherEntries.creditAmount,
      voucherDate: vouchers.voucherDate,
      voucherId: voucherEntries.voucherId,
    })
    .from(voucherEntries)
    .innerJoin(vouchers, eq(voucherEntries.voucherId, vouchers.id))
    .where(and(eq(vouchers.companyId, companyId), eq(vouchers.optional, false), isNull(vouchers.deletedAt)))
    .execute();

  // Keep voucherDateMap for compatibility with code below that uses it
  const voucherDateMap = new Map(companyEntriesRaw.map((e) => [e.voucherId, e.voucherDate]));

  // companyEntriesRaw already fetched above via JOIN
  const companyEntries = companyEntriesRaw;

  // Group data by month (last 6 months)
  const monthlyData = new Map<string, { sales: number; profit: number }>();
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  // Initialize last 6 months
  const currentDate = new Date();
  for (let i = 5; i >= 0; i--) {
    const date = new Date(currentDate.getFullYear(), currentDate.getMonth() - i, 1);
    const monthKey = monthNames[date.getMonth()];
    monthlyData.set(monthKey, { sales: 0, profit: 0 });
  }

  // Calculate sales by month
  for (const voucher of salesVouchers) {
    const voucherDate = new Date(voucher.voucherDate);
    const monthKey = monthNames[voucherDate.getMonth()];
    const amount = parseFloat(voucher.totalAmount || "0");

    if (monthlyData.has(monthKey)) {
      const data = monthlyData.get(monthKey)!;
      data.sales += amount;
    }
  }

  // Calculate profit by month (income - expenses)
  for (const entry of companyEntries) {
    const voucherDate = voucherDateMap.get(entry.voucherId);
    if (!voucherDate) continue;

    const date = new Date(voucherDate);
    const monthKey = monthNames[date.getMonth()];

    if (!monthlyData.has(monthKey)) continue;

    const data = monthlyData.get(monthKey)!;

    // Income accounts: credits increase profit, debits decrease it
    if (entry.ledgerAccountId && incomeAccountIds.includes(entry.ledgerAccountId)) {
      data.profit += parseFloat(entry.creditAmount || "0") - parseFloat(entry.debitAmount || "0");
    }

    // Expense accounts (including Purchases): debits decrease profit, credits increase it
    if (entry.ledgerAccountId && expenseAccountIds.includes(entry.ledgerAccountId)) {
      data.profit -= parseFloat(entry.debitAmount || "0") - parseFloat(entry.creditAmount || "0");
    }
  }

  // Convert map to array
  return Array.from(monthlyData.entries()).map(([month, data]) => ({
    month,
    sales: data.sales,
    profit: data.profit,
  }));
}

// ---------------------------------------------------------------------------
// getStockSummary — /api/stats/stock-summary
// Returns total stock items count, low-stock list, critical count for dashboard KPIs.
// ---------------------------------------------------------------------------
export async function getStockSummary(companyId: number): Promise<{
  totalStockItems: number;
  lowStockCount: number;
  criticalCount: number;
  lowStockItems: Array<{ name: string; stock: number; location: string }>;
}> {
  // Get total stock items count
  const stockItemList = await storage.getAllStockItems(companyId);
  const totalStockItems = stockItemList.length;

  // Get all inventory for the company
  const inventory = await storage.getCompanyInventory(companyId);

  // Calculate low stock items (quantity < 20)
  const lowStockThreshold = 20;
  const lowStockItems = inventory
    .filter((item) => parseFloat(item.quantity) < lowStockThreshold && parseFloat(item.quantity) > 0)
    .map((item) => ({
      name: item.stockItemName ?? "Unknown",
      stock: parseFloat(item.quantity),
      location: item.locationName || "Unknown",
    }))
    .sort((a, b) => a.stock - b.stock) // Sort by lowest stock first
    .slice(0, 10); // Limit to top 10 low stock items

  // Count critical items (quantity < 5)
  const criticalThreshold = 5;
  const criticalCount = inventory.filter(
    (item) => parseFloat(item.quantity) < criticalThreshold && parseFloat(item.quantity) > 0
  ).length;

  return {
    totalStockItems,
    lowStockCount: lowStockItems.length,
    criticalCount,
    lowStockItems,
  };
}

// ---------------------------------------------------------------------------
// getExpenseBreakdown — /api/stats/expense-breakdown
// Returns aggregated expense totals by account type for dashboard donut chart.
// Uses TTL cache (30 s) to avoid repeated expensive joins.
// ---------------------------------------------------------------------------
export async function getExpenseBreakdown(companyId: number): Promise<Array<{ name: string; value: number }> | null> {
  const _ebCacheKey = `expense-breakdown:${companyId}`;
  const _ebCached = _getCached(_ebCacheKey);
  // Only this function writes this cache key, always as Array<{name, value}>.
  if (_ebCached) return _ebCached as Array<{ name: string; value: number }>;

  // Get all expense-related ledger accounts
  const allAccounts = await storage.getAllLedgerAccounts(companyId);

  // Find accounts to EXCLUDE from expenses:
  // 1. IMPORT_CHARGES parent and children (import costs capitalized into inventory)
  // 2. PURCHASES accounts (inventory cost, not expense until sold as COGS)
  const importChargesParent = allAccounts.find((acc) => acc.code === "IMPORT_CHARGES");
  const excludedFromExpenses = new Set<number>();

  if (importChargesParent) {
    excludedFromExpenses.add(importChargesParent.id);
    // Also find all children of IMPORT_CHARGES
    for (const acc of allAccounts) {
      if (acc.parentId === importChargesParent.id) {
        excludedFromExpenses.add(acc.id);
      }
    }
  }

  // Exclude PURCHASES accounts - these are inventory costs, not expenses
  for (const acc of allAccounts) {
    if (acc.code === "PURCHASES" || acc.code?.startsWith("PURCHASES_")) {
      excludedFromExpenses.add(acc.id);
    }
  }

  const expenseAccounts = allAccounts.filter(
    (acc) =>
      (acc.accountType === "Expense" ||
        acc.accountType === "Direct Expense" ||
        acc.accountType === "Indirect Expense") &&
      !excludedFromExpenses.has(acc.id)
  );

  const expenseAccountIds = new Set(expenseAccounts.map((a) => a.id));
  const accountTypeMap = new Map<number, string>();
  for (const acc of expenseAccounts) {
    accountTypeMap.set(acc.id, acc.accountType);
  }

  if (expenseAccountIds.size === 0) {
    _setCached(_ebCacheKey, []);
    return [];
  }

  // Single JOIN — replaces the two-query IN-clause anti-pattern.
  // Directly filters entries to expense accounts for this company.
  const expenseEntries = await db
    .select({
      ledgerAccountId: voucherEntries.ledgerAccountId,
      debitAmount: voucherEntries.debitAmount,
      creditAmount: voucherEntries.creditAmount,
    })
    .from(voucherEntries)
    .innerJoin(vouchers, eq(voucherEntries.voucherId, vouchers.id))
    .where(
      and(
        eq(vouchers.companyId, companyId),
        eq(vouchers.optional, false),
        isNull(vouchers.deletedAt),
        inArray(voucherEntries.ledgerAccountId, [...expenseAccountIds])
      )
    )
    .execute();

  // Sum balances by expense type
  const expenseByType = new Map<string, number>();

  for (const entry of expenseEntries) {
    if (!entry.ledgerAccountId) continue;
    const accountType = accountTypeMap.get(entry.ledgerAccountId);
    if (!accountType) continue;
    const amount = parseFloat(entry.debitAmount || "0") - parseFloat(entry.creditAmount || "0");
    if (amount <= 0) continue;
    expenseByType.set(accountType, (expenseByType.get(accountType) || 0) + amount);
  }

  // Convert to array format for chart
  const result = Array.from(expenseByType.entries())
    .filter(([_, value]) => value > 0)
    .map(([name, value]) => ({
      name: name.replace(" Expense", ""),
      value: Math.round(value * 100) / 100,
    }))
    .sort((a, b) => b.value - a.value);

  _setCached(_ebCacheKey, result);
  return result;
}
