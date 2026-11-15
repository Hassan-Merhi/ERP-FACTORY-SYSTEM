// Extracted from ./userManagementRoutes.ts to keep that module under the source-size cap.
import { db } from "../../db";
import { companyStockValue } from "../../services/inventory/stockValuation";
import { storage } from "../../storage";
import {
  bankAccounts,
  containers,
  employees,
  ledgerAccounts,
  salaryAdvances,
  salesItems,
  stockItems,
  voucherEntries,
  vouchers,
} from "@shared/schema";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type Decimal from "decimal.js";
import { debitMinusCredit, MoneyDecimal, sumMoney, toMoney } from "../../lib/money";

/** An opening balance signed for a debit-normal account: positive unless its side is not "Dr". */
const drOpening = (amount: string | null, side: string | null) =>
  (side || "Dr") === "Dr" ? toMoney(amount) : toMoney(amount).negated();

/** An opening balance signed for a credit-normal account: positive only when its side is "Cr". */
const crOpening = (amount: string | null, side: string | null) =>
  side === "Cr" ? toMoney(amount) : toMoney(amount).negated();

// Shared helper: compute the raw import cycle balance for a given company.
// Uses the identical formula as /api/stats/import-cycle-balance (without the stored equity adjustment).
// Shared by both the single-company and all-companies recalculate endpoints.
export async function computeRawBalance(companyId: number): Promise<number> {
  const getBalance = async (accountType: string, isLiability = false): Promise<Decimal> => {
    const accts = await db
      .select()
      .from(ledgerAccounts)
      .where(
        and(
          eq(ledgerAccounts.companyId, companyId),
          eq(ledgerAccounts.accountType, accountType),
          isNull(ledgerAccounts.deletedAt)
        )
      );
    let total: Decimal = new MoneyDecimal(0);
    for (const acct of accts) {
      const entries = await db
        .select({ cr: voucherEntries.creditAmount, dr: voucherEntries.debitAmount })
        .from(voucherEntries)
        .innerJoin(vouchers, eq(voucherEntries.voucherId, vouchers.id))
        .where(
          and(
            eq(voucherEntries.ledgerAccountId, acct.id),
            eq(vouchers.companyId, companyId),
            isNull(vouchers.deletedAt),
            eq(vouchers.optional, false)
          )
        );
      const movement = debitMinusCredit(entries.map((e) => ({ debitAmount: e.dr, creditAmount: e.cr })));
      total = total.plus(
        isLiability
          ? crOpening(acct.openingBalance, acct.openingBalanceSide).minus(movement)
          : drOpening(acct.openingBalance, acct.openingBalanceSide).plus(movement)
      );
    }
    return total;
  };

  const getTxBalance = async (accountType: string, isLiability = true): Promise<Decimal> => {
    const r = await db
      .select({
        totalCredit: sql<string>`COALESCE(SUM(CAST(${voucherEntries.creditAmount} AS DECIMAL)), 0)`,
        totalDebit: sql<string>`COALESCE(SUM(CAST(${voucherEntries.debitAmount}  AS DECIMAL)), 0)`,
      })
      .from(voucherEntries)
      .innerJoin(vouchers, eq(voucherEntries.voucherId, vouchers.id))
      .innerJoin(ledgerAccounts, eq(voucherEntries.ledgerAccountId, ledgerAccounts.id))
      .where(
        and(
          eq(ledgerAccounts.companyId, companyId),
          eq(ledgerAccounts.accountType, accountType),
          isNull(ledgerAccounts.deletedAt),
          eq(vouchers.companyId, companyId),
          isNull(vouchers.deletedAt),
          eq(vouchers.optional, false)
        )
      );
    const cr = toMoney(r[0]?.totalCredit);
    const dr = toMoney(r[0]?.totalDebit);
    return isLiability ? cr.minus(dr) : dr.minus(cr);
  };

  const supplierEntries = await db
    .select({ supplierId: voucherEntries.supplierId, cr: voucherEntries.creditAmount, dr: voucherEntries.debitAmount })
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
  const allSuppliersRaw = await storage.getAllSuppliers();
  const activeSupplierIds = new Set(supplierEntries.map((e) => e.supplierId).filter(Boolean));
  const coContainers = await db
    .select({ supplierId: containers.supplierId })
    .from(containers)
    .where(eq(containers.companyId, companyId));
  for (const c of coContainers) {
    if (c.supplierId) activeSupplierIds.add(c.supplierId);
  }
  const supplierOpeningTotal = sumMoney(
    allSuppliersRaw.filter((s) => activeSupplierIds.has(s.id)).map((sup) => sup.openingBalance)
  );
  const supplierBalance = supplierOpeningTotal.minus(
    debitMinusCredit(supplierEntries.map((e) => ({ debitAmount: e.dr, creditAmount: e.cr })))
  );

  const otwRows = await db
    .select({ grandTotal: containers.grandTotal })
    .from(containers)
    .where(and(eq(containers.companyId, companyId), eq(containers.status, "OTW")));
  const stockOtwValue = sumMoney(otwRows.map((c) => c.grandTotal));

  const dutyAgentBalance = await getBalance("Duty Agent", true);
  const transporterAgentBalance = await getBalance("Transporter Agent", true);
  const loansBalance = await getBalance("Loans", true);
  const cashBalance = await getBalance("Cash", false);

  const ledgerBankBalance = await getBalance("Bank", false);
  const standaloneBankEntries = await db
    .select({ cr: voucherEntries.creditAmount, dr: voucherEntries.debitAmount })
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
    );
  const standaloneBankAccts = await db
    .select()
    .from(bankAccounts)
    .where(
      and(eq(bankAccounts.companyId, companyId), isNull(bankAccounts.deletedAt), isNull(bankAccounts.linkedLedgerId))
    );
  const standaloneOpening = sumMoney(standaloneBankAccts.map((a) => drOpening(a.openingBalance, a.openingBalanceSide)));
  const standaloneVoucher = debitMinusCredit(
    standaloneBankEntries.map((e) => ({ debitAmount: e.dr, creditAmount: e.cr }))
  );
  const bankBalance = ledgerBankBalance.plus(standaloneOpening).plus(standaloneVoucher);

  const indirectExpenseBalance = await getBalance("Indirect Expense", false);
  const incomeBalance = await getBalance("Income", true);

  // Wave 11: the one stock valuation (stockValuation.ts, SUM(total_value)).
  const stockOnFloorValue = toMoney(await companyStockValue(db, companyId));

  const cogsRows = await db
    .select({ totalCost: salesItems.totalCost })
    .from(salesItems)
    .innerJoin(vouchers, eq(salesItems.voucherId, vouchers.id))
    .where(and(eq(vouchers.companyId, companyId), isNull(vouchers.deletedAt), eq(vouchers.optional, false)));
  const cogsBalance = sumMoney(cogsRows.map((i) => i.totalCost));

  const payrollAccts = await db
    .select({ id: ledgerAccounts.id, openingBalance: ledgerAccounts.openingBalance })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.companyId, companyId),
        eq(ledgerAccounts.accountType, "Expense"),
        sql`(${ledgerAccounts.name} ILIKE '%salary%' OR ${ledgerAccounts.name} ILIKE '%payroll%' OR ${ledgerAccounts.name} ILIKE '%wage%')`,
        isNull(ledgerAccounts.deletedAt)
      )
    );
  let payrollExpenseBalance: Decimal = new MoneyDecimal(0);
  if (payrollAccts.length > 0) {
    const payrollIds = payrollAccts.map((a) => a.id);
    const payrollEntries = await db
      .select({ cr: voucherEntries.creditAmount, dr: voucherEntries.debitAmount })
      .from(voucherEntries)
      .innerJoin(vouchers, eq(voucherEntries.voucherId, vouchers.id))
      .where(
        and(
          inArray(voucherEntries.ledgerAccountId, payrollIds),
          eq(vouchers.companyId, companyId),
          isNull(vouchers.deletedAt),
          eq(vouchers.optional, false)
        )
      );
    const openingTot = sumMoney(payrollAccts.map((a) => a.openingBalance));
    const txTot = debitMinusCredit(payrollEntries.map((e) => ({ debitAmount: e.dr, creditAmount: e.cr })));
    payrollExpenseBalance = openingTot.plus(txTot);
  }

  const advRows = await db
    .select({ remainingBalance: salaryAdvances.remainingBalance })
    .from(salaryAdvances)
    .where(and(eq(salaryAdvances.companyId, companyId), eq(salaryAdvances.fullyPaid, false)));
  const salaryAdvancesBalance = sumMoney(advRows.map((a) => a.remainingBalance));

  const empRows = await db
    .select({ currentBalance: employees.currentBalance })
    .from(employees)
    .where(and(eq(employees.companyId, companyId), isNull(employees.deletedAt)));
  const payrollLiabilitiesBalance = sumMoney(empRows.map((e) => MoneyDecimal.max(toMoney(e.currentBalance), 0)));

  const assetBalance = await getBalance("Asset", false);
  const governmentTaxesBalance = await getBalance("Government Taxes", false);
  const liabilityBalance = await getBalance("Liability", true);
  const profitBalance = await getBalance("Profit", true);
  const equityTransactionBalance = await getTxBalance("Equity", true);
  const apTransactionBalance = await getTxBalance("Accounts Payable", true);

  const allLedgerAccts = await db
    .select({ openingBalance: ledgerAccounts.openingBalance, openingBalanceSide: ledgerAccounts.openingBalanceSide })
    .from(ledgerAccounts)
    .where(and(eq(ledgerAccounts.companyId, companyId), isNull(ledgerAccounts.deletedAt)));
  let totalDrOpenings: Decimal = new MoneyDecimal(0);
  let totalCrOpenings: Decimal = new MoneyDecimal(0);
  for (const a of allLedgerAccts) {
    const raw = toMoney(a.openingBalance);
    if (raw.isZero()) continue;
    if ((a.openingBalanceSide || "Dr") === "Dr") totalDrOpenings = totalDrOpenings.plus(raw);
    else totalCrOpenings = totalCrOpenings.plus(raw);
  }
  const empOpenings = await db
    .select({ openingBalance: employees.openingBalance })
    .from(employees)
    .where(and(eq(employees.companyId, companyId), isNull(employees.deletedAt)));
  totalCrOpenings = totalCrOpenings.plus(sumMoney(empOpenings.map((e) => e.openingBalance)));
  let openingBalanceEquity = totalCrOpenings.minus(totalDrOpenings);

  const stockItemOpenings = await db
    .select({ openingValue: stockItems.openingValue })
    .from(stockItems)
    .where(and(eq(stockItems.companyId, companyId), isNull(stockItems.deletedAt)));
  openingBalanceEquity = openingBalanceEquity.minus(sumMoney(stockItemOpenings.map((i) => i.openingValue)));

  const assets = sumMoney([
    stockOtwValue,
    cashBalance,
    bankBalance,
    stockOnFloorValue,
    assetBalance,
    indirectExpenseBalance,
    payrollExpenseBalance,
    governmentTaxesBalance,
    cogsBalance,
    salaryAdvancesBalance,
  ]);
  const liabilities = sumMoney([
    supplierBalance,
    dutyAgentBalance,
    transporterAgentBalance,
    loansBalance,
    liabilityBalance,
    profitBalance,
    equityTransactionBalance,
    apTransactionBalance,
    incomeBalance,
    payrollLiabilitiesBalance,
  ]).minus(openingBalanceEquity);
  // Cents, rounding halves toward +infinity as Math.round did.
  return assets.minus(liabilities).toDecimalPlaces(2, MoneyDecimal.ROUND_HALF_CEIL).toNumber();
}
