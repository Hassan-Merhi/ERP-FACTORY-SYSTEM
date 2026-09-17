/**
 * Shared Net Position calculation logic.
 *
 * This module is the single source of truth for how ledger accounts are
 * classified as assets (forUs) or liabilities (onUs) when computing a
 * company's net position.  Both the ERP route (/api/stats/net-profit) and
 * the Factory route (/api/factory/net-position) call classifyNetPositionAccounts()
 * so they always use identical math.  Only the upstream data (which accounts,
 * which extra sources of assets/liabilities) differs between modes.
 */

import { isAccountMigrationClearingAccount } from "./lib/systemOnlyLedgerAccounts";

export interface AccountLike {
  id: number;
  name: string;
  code: string | null;
  accountType: string | null;
  subType?: string | null;
  openingBalance: string | null;
  openingBalanceSide: string | null;
  parentId?: number | null;
}

export interface AccountBalance {
  debit: number;
  credit: number;
}

export interface NetPositionAccount {
  id?: number;
  name: string;
  code: string;
  value: number;
  category: string;
}

export interface EquityAccount extends NetPositionAccount {
  balanceSide: "Dr" | "Cr";
}

export interface EquityResult {
  total: number;
  accounts: EquityAccount[];
}

export interface ClassifyOptions {
  /**
   * Extra account codes (uppercase) to skip from net-position classification.
   * Use this to inject factory-specific clearing codes like FACTORY_IMPORT_COST.
   */
  additionalExcludedCodes?: Set<string>;
  /**
   * When false, Supplier-type ledger accounts are excluded from the
   * classification (factory handles suppliers via its own calculation).
   * Defaults to true.
   */
  includeSupplierTypeAccounts?: boolean;
}

export interface ClassifyResult {
  forUsTotal: number;
  onUsTotal: number;
  forUsAccounts: NetPositionAccount[];
  onUsAccounts: NetPositionAccount[];
  /**
   * Raw category → value map.  Caller may push additional entries (e.g.
   * stockOnFloor, workerAdvances) before building the final breakdown arrays.
   * Keys use the prefixes  "asset_"  and  "liability_"  so helpers that build
   * breakdown arrays can strip them.
   */
  categoryTotals: Record<string, number>;
}

// ─── Constants (mirror the ERP route) ───────────────────────────────────────

const assetDefaultDrTypes = ["Asset", "Current Asset", "Bank", "Cash", "Customer"];
const liabilityAccountTypes = ["Liability", "Duty Agent", "Transporter Agent", "Loan", "Loans"];
const excludedAccountTypes = ["Income", "Profit", "Equity", "EQUITY", "Fixed Asset", "Intercompany"];
export const expenseTypes = ["Expense", "Direct Expense", "Indirect Expense"];
const assetAccountTypes = ["Asset", "Current Asset", "Fixed Asset", "Bank", "Cash"];

const fixedAssetNamePatterns = [
  "rover",
  "toyota",
  "mercedes",
  "vehicle",
  "car",
  "truck",
  "land",
  "property",
  "building",
  "house",
  "rolex",
  "watch",
  "luxury",
  "jewelry",
  "guarantee",
  "deposit",
  "caution",
];

const stockInventoryPatterns = [
  "closing stock",
  "opening stock",
  "stock in hand",
  "stock on hand",
  "inventory",
  "stock account",
  "goods in stock",
  "merchandise",
];

const stockInventoryCodes = ["CLOSING_STOCK", "OPENING_STOCK", "STOCK", "INVENTORY", "STOCK_IN_HAND"];

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

// ─── Core helpers ────────────────────────────────────────────────────────────

/**
 * Returns the signed net balance for a ledger account.
 * Positive  →  we hold an asset / they owe us.
 * Negative  →  we owe them / it is a liability.
 */
export function getAccountNetBalance(acc: AccountLike, balanceMap: Map<number, AccountBalance>): number {
  const opening = parseFloat(acc.openingBalance || "0");
  const defaultSide = assetDefaultDrTypes.includes(acc.accountType || "") ? 1 : -1;
  const openingSide = acc.openingBalanceSide === "Dr" ? 1 : acc.openingBalanceSide === "Cr" ? -1 : defaultSide;
  const signedOpening = opening * openingSide;
  const balance = balanceMap.get(acc.id) || { debit: 0, credit: 0 };
  return signedOpening + balance.debit - balance.credit;
}

/** Classifies equity accounts for display without including them in Assets/Liabilities totals. */
export function classifyEquityAccounts(accounts: AccountLike[], balanceMap: Map<number, AccountBalance>): EquityResult {
  let total = 0;
  const equityAccounts: EquityAccount[] = [];

  for (const acc of accounts) {
    if (isAccountMigrationClearingAccount(acc)) continue;
    if (!["Equity", "EQUITY"].includes(acc.accountType || "")) continue;

    const netBalance = getAccountNetBalance(acc, balanceMap);
    if (Math.abs(netBalance) < 0.01) continue;

    total += netBalance;
    equityAccounts.push({
      id: acc.id,
      name: acc.name,
      code: acc.code || "",
      value: round2(Math.abs(netBalance)),
      category: "Partner Capital / Equity",
      balanceSide: netBalance >= 0 ? "Dr" : "Cr",
    });
  }

  return {
    total: round2(total),
    accounts: equityAccounts.sort((a, b) => b.value - a.value),
  };
}

// ─── Main classification function ────────────────────────────────────────────

/**
 * Classifies a set of ledger accounts into assets (forUs) and liabilities
 * (onUs) using the ERP sign-based formula.
 *
 *   • Expense / Income account types are always skipped — they do NOT feed
 *     into net position.
 *   • Excluded account types (Income, Profit, Equity, Fixed Asset) are skipped.
 *   • Stock / inventory ledger accounts are excluded so callers can add the
 *     computed inventory value separately (prevents double-counting).
 *   • Fixed-asset accounts identified by name pattern are excluded.
 *   • Callers may pass additionalExcludedCodes for mode-specific clearing
 *     accounts (e.g. FACTORY_IMPORT_COST).
 */
export function classifyNetPositionAccounts(
  accounts: AccountLike[],
  balanceMap: Map<number, AccountBalance>,
  options: ClassifyOptions = {}
): ClassifyResult {
  const { additionalExcludedCodes = new Set<string>(), includeSupplierTypeAccounts = true } = options;

  // Build the set of accounts excluded from expense tracking (IMPORT_CHARGES
  // children, PURCHASES, etc.) — the same set the ERP uses.
  const excludedFromExpenses = new Set<number>();
  const importChargesParent = accounts.find((a) => a.code === "IMPORT_CHARGES");
  if (importChargesParent) {
    excludedFromExpenses.add(importChargesParent.id);
    for (const acc of accounts) {
      if (acc.parentId === importChargesParent.id) excludedFromExpenses.add(acc.id);
    }
  }
  for (const acc of accounts) {
    if (
      acc.code === "PURCHASES" ||
      acc.code?.startsWith("PURCHASES_") ||
      acc.code === "PRODUCTION_ADJUSTMENT" ||
      acc.code === "CONSUMPTION_EXPENSE"
    ) {
      excludedFromExpenses.add(acc.id);
    }
  }

  const isExcludedFromNetPosition = (acc: AccountLike): boolean => {
    if (isAccountMigrationClearingAccount(acc)) return true;
    if (excludedAccountTypes.includes(acc.accountType || "")) return true;
    if (acc.code === "PRODUCTION_ADJUSTMENT" || acc.code === "CONSUMPTION_EXPENSE") return true;
    if (!includeSupplierTypeAccounts && acc.accountType === "Supplier") return true;
    if (additionalExcludedCodes.has((acc.code || "").trim().toUpperCase())) return true;
    // Deferred Rent Revenue is an internal accrual account; it offsets Rent Income
    // when rent is prepaid and should not appear as a net-position liability.
    if ((acc.code || "").toUpperCase() === "DEF-RENT-REV") return true;
    if ((acc.name || "").toLowerCase() === "deferred rent revenue") return true;

    const nameLower = (acc.name || "").toLowerCase();
    const codeLower = (acc.code || "").toLowerCase();

    if (assetAccountTypes.includes(acc.accountType || "")) {
      if (stockInventoryPatterns.some((p) => nameLower.includes(p))) return true;
      if (stockInventoryCodes.some((c) => codeLower === c.toLowerCase() || codeLower.startsWith(c.toLowerCase() + "_")))
        return true;
      // Fixed-asset name patterns (vehicles, land, luxury goods, etc.) are only applied
      // to accounts explicitly typed as "Fixed Asset". Regular Asset / Current Asset
      // accounts (e.g. "Security Deposits Paid") are current assets and must appear in
      // the net position.
      if (acc.accountType === "Fixed Asset" && fixedAssetNamePatterns.some((p) => nameLower.includes(p))) return true;
    }

    return false;
  };

  let forUsTotal = 0;
  let onUsTotal = 0;
  const forUsAccounts: NetPositionAccount[] = [];
  const onUsAccounts: NetPositionAccount[] = [];
  const categoryTotals: Record<string, number> = {};

  for (const acc of accounts) {
    // Skip expense and income types — not part of balance-sheet net position
    const isExpenseType = expenseTypes.includes(acc.accountType || "");
    const isIncomeType = acc.accountType === "Income";
    if (isExpenseType || isIncomeType) continue;

    if (isExcludedFromNetPosition(acc)) continue;

    const netBalance = getAccountNetBalance(acc, balanceMap);
    if (Math.abs(netBalance) < 0.01) continue;

    const isLiabilityType = liabilityAccountTypes.includes(acc.accountType || "");
    const category = acc.accountType || "Other";

    if (isLiabilityType) {
      // Positive balance on a liability account = deposit we paid = asset
      // Negative balance on a liability account = we owe them = liability
      if (netBalance > 0) {
        forUsTotal += netBalance;
        categoryTotals[`asset_${category} Deposits`] = (categoryTotals[`asset_${category} Deposits`] || 0) + netBalance;
        forUsAccounts.push({
          id: acc.id,
          name: acc.name,
          code: acc.code || "",
          value: round2(netBalance),
          category: `${category} Deposits`,
        });
      } else {
        onUsTotal += Math.abs(netBalance);
        categoryTotals[`liability_${category}`] = (categoryTotals[`liability_${category}`] || 0) + Math.abs(netBalance);
        onUsAccounts.push({
          id: acc.id,
          name: acc.name,
          code: acc.code || "",
          value: round2(Math.abs(netBalance)),
          category,
        });
      }
    } else {
      // Asset-type (and other) accounts: positive = asset, negative = liability (overdraft).
      // Exception: accounts whose names contain "prepaid" are always balance-sheet assets.
      // When they carry a credit balance they REDUCE the asset total rather than creating
      // a separate liability entry (which is confusing and typically indicates a timing
      // difference rather than a true liability).
      const isPrepaid = (acc.name || "").toLowerCase().includes("prepaid");

      if (netBalance > 0) {
        forUsTotal += netBalance;
        categoryTotals[`asset_${category}`] = (categoryTotals[`asset_${category}`] || 0) + netBalance;
        forUsAccounts.push({ id: acc.id, name: acc.name, code: acc.code || "", value: round2(netBalance), category });
      } else if (isPrepaid) {
        // Credit-balance prepaid: add as a negative entry on the asset side so it
        // reduces the prepaid total without appearing on the liability side.
        forUsTotal += netBalance; // netBalance is negative, so this reduces forUsTotal
        categoryTotals[`asset_${category}`] = (categoryTotals[`asset_${category}`] || 0) + netBalance;
        forUsAccounts.push({ id: acc.id, name: acc.name, code: acc.code || "", value: round2(netBalance), category });
      } else {
        onUsTotal += Math.abs(netBalance);
        categoryTotals[`liability_${category}`] = (categoryTotals[`liability_${category}`] || 0) + Math.abs(netBalance);
        onUsAccounts.push({
          id: acc.id,
          name: acc.name,
          code: acc.code || "",
          value: round2(Math.abs(netBalance)),
          category,
        });
      }
    }
  }

  return {
    forUsTotal: round2(forUsTotal),
    onUsTotal: round2(onUsTotal),
    forUsAccounts: forUsAccounts.sort((a, b) => b.value - a.value),
    onUsAccounts: onUsAccounts.sort((a, b) => b.value - a.value),
    categoryTotals,
  };
}

/** Builds sorted breakdown arrays from a categoryTotals map. */
export function buildBreakdowns(categoryTotals: Record<string, number>): {
  forUsBreakdown: { name: string; value: number }[];
  onUsBreakdown: { name: string; value: number }[];
  expensesBreakdown: { name: string; value: number }[];
  incomeBreakdown: { name: string; value: number }[];
} {
  const forUsBreakdown: { name: string; value: number }[] = [];
  const onUsBreakdown: { name: string; value: number }[] = [];
  const expensesBreakdown: { name: string; value: number }[] = [];
  const incomeBreakdown: { name: string; value: number }[] = [];

  for (const [key, value] of Object.entries(categoryTotals)) {
    if (value === 0) continue;
    const v = round2(value);
    if (key.startsWith("asset_")) forUsBreakdown.push({ name: key.replace("asset_", ""), value: v });
    else if (key.startsWith("liability_")) onUsBreakdown.push({ name: key.replace("liability_", ""), value: v });
    else if (key.startsWith("exp_")) expensesBreakdown.push({ name: key.replace("exp_", ""), value: v });
    else if (key.startsWith("income_")) incomeBreakdown.push({ name: key.replace("income_", ""), value: v });
  }

  forUsBreakdown.sort((a, b) => b.value - a.value);
  onUsBreakdown.sort((a, b) => b.value - a.value);
  expensesBreakdown.sort((a, b) => b.value - a.value);
  incomeBreakdown.sort((a, b) => b.value - a.value);

  return { forUsBreakdown, onUsBreakdown, expensesBreakdown, incomeBreakdown };
}
