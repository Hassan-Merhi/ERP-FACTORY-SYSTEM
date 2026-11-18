// Extracted from ./netProfitExcelSheets.ts to keep that module under the source-size cap.
import type Decimal from "decimal.js";
import type { LedgerAccount } from "@shared/schema";
import { isInventoryValuationOnlyAccount } from "../lib/inventoryPnlAccounts";
import { MoneyDecimal, toMoney } from "../lib/money";
import { classifyAccountType, expenseCategory, isIndirectIncome } from "../services/accounting/accountClassification";

/**
 * Statistics and ExcelJS sheet rendering for the net-profit workbook.
 *
 * These were declared inside the /api/reports/net-profit-excel handler but take
 * everything they need as arguments - the stats object, the worksheet, the
 * labels - so they are a function of their inputs alone.
 *
 * config/report-characterization.json pins the workbook's cell values across the
 * move, which is what makes an extraction of this size checkable at all.
 */

/**
 * The three pieces of per-request context these functions need. They were
 * captured from the handler's scope; passing them explicitly is the only change
 * to the code that moved.
 */
export interface NetProfitSheetContext {
  companyAccounts: LedgerAccount[];
  importChargesIds: Set<number>;
  companyName: string;
}

export const fmt = (n: number) => (Number.isFinite(n) ? new MoneyDecimal(n).toDecimalPlaces(2).toNumber() : n);

export type NetProfitBalanceEntry = {
  ledgerAccountId?: number | null;
  debitAmount?: string | null;
  creditAmount?: string | null;
};

export function computeBalancesFromEntries(
  entries: NetProfitBalanceEntry[]
): Map<number, { debit: number; credit: number }> {
  const exact = new Map<number, { debit: Decimal; credit: Decimal }>();
  for (const e of entries) {
    if (e.ledgerAccountId) {
      const cur = exact.get(e.ledgerAccountId);
      exact.set(e.ledgerAccountId, {
        debit: toMoney(e.debitAmount).plus(cur?.debit ?? 0),
        credit: toMoney(e.creditAmount).plus(cur?.credit ?? 0),
      });
    }
  }
  const bal = new Map<number, { debit: number; credit: number }>();
  for (const [id, { debit, credit }] of exact) bal.set(id, { debit: debit.toNumber(), credit: credit.toNumber() });
  return bal;
}

/**
 * The section of the net-profit workbook an account belongs to, by the shared
 * classifier (wave 13): case-insensitive types, both storage forms of a sub
 * type ("Direct Expense" as the type or "Expense" + subType), Revenue,
 * Government Taxes and COGS included. Every income- and expense-class account
 * lands in exactly one section:
 *   - "salesAccount": income accounts read through the sales total (SALES-named
 *     and uncategorised income; the route adds their non-POS vouchers to it);
 *   - "directIncome": Direct Income that is not SALES-named;
 *   - "indirectIncome": Indirect Income (either storage form), below gross
 *     profit; before wave 13 it was in no section;
 *   - "purchase": PURCHASES / PURCHASES-* by code;
 *   - "directExpense": Direct Expense, COGS and the IMPORT_CHARGES tree;
 *   - "indirectExpense": every other expense (Indirect Expense, plain Expense,
 *     Government Taxes). Before wave 13 a plain "Expense" account with no sub
 *     type and Government Taxes were in no section, so the workbook's profit
 *     left them out while the P&L counted them.
 * Inventory-valuation-only accounts and non-P&L accounts are null.
 */
export type NetProfitSection =
  "salesAccount" | "directIncome" | "indirectIncome" | "purchase" | "directExpense" | "indirectExpense";

export function netProfitSection(
  acc: Pick<LedgerAccount, "id" | "code" | "name" | "accountType" | "subType">,
  importChargesIds: ReadonlySet<number>
): NetProfitSection | null {
  const accountClass = classifyAccountType(acc.accountType, acc.subType);
  if (accountClass === "income") {
    if (isIndirectIncome(acc.accountType, acc.subType)) return "indirectIncome";
    const salesNamed = Boolean(acc.code?.includes("SALES") || acc.name?.toLowerCase().includes("sales"));
    const direct = [acc.accountType, acc.subType].some((t) => (t ?? "").trim().toLowerCase() === "direct income");
    return direct && !salesNamed ? "directIncome" : "salesAccount";
  }
  if (acc.code === "PURCHASES" || acc.code?.startsWith("PURCHASES-")) return "purchase";
  if (accountClass !== "expense" && !importChargesIds.has(acc.id)) return null;
  if (acc.code?.startsWith("PURCHASES")) return null;
  if (isInventoryValuationOnlyAccount(acc)) return null;
  if (importChargesIds.has(acc.id)) return "directExpense";
  const category = expenseCategory(acc.accountType, acc.subType);
  return category === "Direct Expense" || category === "COGS" ? "directExpense" : "indirectExpense";
}

type SectionDetail = { id: number; name: string; debit: number; credit: number; balance: number };

function sectionDetails(
  ctx: NetProfitSheetContext,
  balances: Map<number, { debit: number; credit: number }>,
  section: NetProfitSection,
  normal: "debit" | "credit"
): { total: number; details: SectionDetail[] } {
  let total = new MoneyDecimal(0);
  const details: SectionDetail[] = [];
  for (const acc of ctx.companyAccounts) {
    if (netProfitSection(acc, ctx.importChargesIds) !== section) continue;
    const b = balances.get(acc.id) || { debit: 0, credit: 0 };
    const net = normal === "debit" ? toMoney(b.debit).minus(b.credit) : toMoney(b.credit).minus(b.debit);
    total = total.plus(net);
    if (b.debit !== 0 || b.credit !== 0) {
      details.push({ id: acc.id, name: acc.name, debit: b.debit, credit: b.credit, balance: net.toNumber() });
    }
  }
  return { total: total.toNumber(), details };
}

export function computeStats(
  ctx: NetProfitSheetContext,
  balances: Map<number, { debit: number; credit: number }>,
  salesTotal: number,
  openingSt: number,
  closingSt: number,
  monthlyMode = false
) {
  const { total: directIncTotal, details: directIncDetails } = sectionDetails(ctx, balances, "directIncome", "credit");
  const { total: indirectIncTotal, details: indirectIncDetails } = sectionDetails(
    ctx,
    balances,
    "indirectIncome",
    "credit"
  );
  const totalIncome = toMoney(salesTotal).plus(directIncTotal).toNumber();
  const { total: purchaseTotal, details: purchaseDetails } = sectionDetails(ctx, balances, "purchase", "debit");
  const { total: directExpTotal, details: directExpDetails } = sectionDetails(ctx, balances, "directExpense", "debit");
  const { total: indirectExpTotal, details: indirectExpDetails } = sectionDetails(
    ctx,
    balances,
    "indirectExpense",
    "debit"
  );

  // COGS: Opening + Purchases + Direct + Indirect - Closing (monthlyMode: no opening/closing)
  const cogsExact = toMoney(purchaseTotal).plus(directExpTotal).plus(indirectExpTotal);
  const totalCOGS = (monthlyMode ? cogsExact : cogsExact.plus(openingSt).minus(closingSt)).toNumber();

  const grossProfit = toMoney(totalIncome).minus(totalCOGS).toNumber();
  // Indirect income is earned below gross profit (wave 13).
  const netProfit = toMoney(grossProfit).plus(indirectIncTotal).toNumber();
  const grossMarginPct = totalIncome > 0 ? (grossProfit / totalIncome) * 100 : 0;
  const netMarginPct = totalIncome > 0 ? (netProfit / totalIncome) * 100 : 0;

  return {
    salesTotal,
    directIncTotal,
    directIncDetails,
    totalIncome,
    indirectIncTotal,
    indirectIncDetails,
    purchaseTotal,
    purchaseDetails,
    directExpTotal,
    directExpDetails,
    indirectExpTotal,
    indirectExpDetails,
    openingSt,
    closingSt,
    totalCOGS,
    grossProfit,
    netProfit,
    grossMarginPct,
    netMarginPct,
    monthlyMode,
  };
}
