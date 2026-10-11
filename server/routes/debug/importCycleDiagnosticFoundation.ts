import { db } from "../../db";
import { companyStockValue } from "../../services/inventory/stockValuation";
import { storage } from "../../storage";
import { isParentCompanyContext } from "../helpers/supplierBalanceHelpers";
import {
  bankAccounts,
  containers,
  employees,
  inventory,
  ledgerAccounts,
  locations,
  salesItems,
  stockItems,
  suppliers,
  voucherEntries,
  vouchers,
} from "@shared/schema";
import { and, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import type Decimal from "decimal.js";
import { MoneyDecimal, debitMinusCredit, sumMoney, toMoney } from "../../lib/money";
import type { DiagnosticIssue, ImportCycleBalanceSnapshot } from "./importCycleDiagnosticTypes";

/** An opening balance signed for a debit-normal account: negative unless its side is "Dr" (the default). */
const drOpening = (amount: string | null, side: string | null) =>
  (side || "Dr") === "Dr" ? toMoney(amount) : toMoney(amount).negated();
/** An opening balance signed for a credit-normal account: positive only when its side is "Cr". */
const crOpening = (amount: string | null, side: string | null) =>
  side === "Cr" ? toMoney(amount) : toMoney(amount).negated();

async function getAccountTypeBalance(companyId: number, accountType: string, isLiability = false): Promise<Decimal> {
  const accounts = await db
    .select()
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.companyId, companyId),
        eq(ledgerAccounts.accountType, accountType),
        isNull(ledgerAccounts.deletedAt)
      )
    );

  let totalBalance = new MoneyDecimal(0);
  for (const account of accounts) {
    const entries = await db
      .select({
        creditAmount: voucherEntries.creditAmount,
        debitAmount: voucherEntries.debitAmount,
      })
      .from(voucherEntries)
      .innerJoin(vouchers, eq(voucherEntries.voucherId, vouchers.id))
      .where(
        and(
          eq(voucherEntries.ledgerAccountId, account.id),
          eq(vouchers.companyId, companyId),
          isNull(vouchers.deletedAt),
          eq(vouchers.optional, false)
        )
      );

    const movement = debitMinusCredit(entries);
    totalBalance = totalBalance.plus(
      isLiability
        ? crOpening(account.openingBalance, account.openingBalanceSide).minus(movement)
        : drOpening(account.openingBalance, account.openingBalanceSide).plus(movement)
    );
  }

  return totalBalance;
}

async function getTransactionOnlyBalance(companyId: number, accountType: string, isLiability = true): Promise<Decimal> {
  const result = await db
    .select({
      totalCredit: sql<string>`COALESCE(SUM(CAST(${voucherEntries.creditAmount} AS DECIMAL)), 0)`,
      totalDebit: sql<string>`COALESCE(SUM(CAST(${voucherEntries.debitAmount} AS DECIMAL)), 0)`,
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

  const net = toMoney(result[0]?.totalDebit).minus(toMoney(result[0]?.totalCredit));
  return isLiability ? net.negated() : net;
}

export async function collectImportCycleBalanceSnapshot(companyId: number): Promise<ImportCycleBalanceSnapshot> {
  const issues: DiagnosticIssue[] = [];
  let issueCounter = 0;
  const generateIssueId = () => `issue-${++issueCounter}`;

  const negativeInventory = await db
    .select({
      id: inventory.id,
      stockItemId: inventory.stockItemId,
      stockItemCode: stockItems.code,
      stockItemName: stockItems.name,
      locationId: inventory.locationId,
      locationName: locations.name,
      quantity: inventory.quantity,
      averageRate: inventory.averageRate,
      totalValue: inventory.totalValue,
    })
    .from(inventory)
    .innerJoin(stockItems, eq(inventory.stockItemId, stockItems.id))
    .leftJoin(locations, eq(inventory.locationId, locations.id))
    .where(and(eq(inventory.companyId, companyId), sql`CAST(${inventory.quantity} AS DECIMAL) < 0`));

  for (const item of negativeInventory) {
    const qty = toMoney(item.quantity).toNumber();
    const rate = toMoney(item.averageRate).toNumber();
    // The shortage's provisional value as the sub-ledger holds it (wave 11
    // negative-stock policy). A short row written before wave 11 holds no
    // value, so its impact is estimated at the cost memory (display only).
    const heldValue = toMoney(item.totalValue);
    const impact = (heldValue.isZero() ? toMoney(item.quantity).times(toMoney(item.averageRate)) : heldValue)
      .abs()
      .toNumber();
    issues.push({
      id: generateIssueId(),
      type: "negative_inventory",
      severity: "critical",
      description: `Negative inventory: ${item.stockItemCode} at ${item.locationName || `Location ${item.locationId}`}`,
      impact,
      details: {
        stockItemId: item.stockItemId,
        stockItemCode: item.stockItemCode,
        stockItemName: item.stockItemName,
        locationId: item.locationId,
        locationName: item.locationName,
        quantity: qty,
        averageRate: rate,
      },
      fixGuidance:
        "Create a Production voucher to add missing inventory, or review sales/consumption vouchers for errors.",
    });
  }

  const orphanedInventory = await db
    .select({
      id: inventory.id,
      stockItemId: inventory.stockItemId,
      stockItemCode: stockItems.code,
      stockItemName: stockItems.name,
      locationId: inventory.locationId,
      quantity: inventory.quantity,
      averageRate: inventory.averageRate,
      totalValue: inventory.totalValue,
    })
    .from(inventory)
    .innerJoin(stockItems, eq(inventory.stockItemId, stockItems.id))
    .leftJoin(locations, eq(inventory.locationId, locations.id))
    .where(and(eq(inventory.companyId, companyId), or(isNull(locations.id), isNotNull(locations.deletedAt))));

  for (const item of orphanedInventory) {
    const qty = toMoney(item.quantity).toNumber();
    const rate = toMoney(item.averageRate).toNumber();
    // The value the sub-ledger holds on the row (total_value, wave 11).
    const exactImpact = toMoney(item.totalValue).abs();
    const impact = exactImpact.toNumber();
    if (exactImpact.greaterThan(0.01)) {
      issues.push({
        id: generateIssueId(),
        type: "orphaned_inventory",
        severity: "warning",
        description: `Orphaned inventory: ${item.stockItemCode} at deleted/missing location ${item.locationId}`,
        impact,
        details: {
          inventoryId: item.id,
          stockItemId: item.stockItemId,
          stockItemCode: item.stockItemCode,
          stockItemName: item.stockItemName,
          locationId: item.locationId,
          quantity: qty,
          averageRate: rate,
        },
        fixGuidance: "Restore the location or transfer inventory to an active location before deleting.",
      });
    }
  }

  const voucherBalances = await db
    .select({
      voucherId: vouchers.id,
      voucherNumber: vouchers.voucherNumber,
      voucherType: vouchers.voucherType,
      voucherDate: vouchers.voucherDate,
      totalDebit: sql<string>`COALESCE(SUM(CAST(${voucherEntries.debitAmount} AS DECIMAL)), 0)`,
      totalCredit: sql<string>`COALESCE(SUM(CAST(${voucherEntries.creditAmount} AS DECIMAL)), 0)`,
    })
    .from(vouchers)
    .leftJoin(voucherEntries, eq(voucherEntries.voucherId, vouchers.id))
    .where(and(eq(vouchers.companyId, companyId), isNull(vouchers.deletedAt), eq(vouchers.optional, false)))
    .groupBy(vouchers.id, vouchers.voucherNumber, vouchers.voucherType, vouchers.voucherDate);

  for (const voucher of voucherBalances) {
    const debit = toMoney(voucher.totalDebit);
    const credit = toMoney(voucher.totalCredit);
    const exactDifference = debit.minus(credit).abs();
    const difference = exactDifference.toNumber();
    if (exactDifference.greaterThan(0.01)) {
      issues.push({
        id: generateIssueId(),
        type: "unbalanced_voucher",
        severity: "critical",
        description: `Unbalanced voucher: ${voucher.voucherNumber} (${voucher.voucherType}) - Debits: $${debit.toFixed(2)}, Credits: $${credit.toFixed(2)}`,
        impact: difference,
        details: {
          voucherId: voucher.voucherId,
          voucherNumber: voucher.voucherNumber,
          voucherType: voucher.voucherType,
          voucherDate: voucher.voucherDate,
          totalDebit: debit.toNumber(),
          totalCredit: credit.toNumber(),
          difference,
        },
        fixGuidance: "Edit the voucher to ensure debits equal credits, or delete and recreate it.",
      });
    }
  }

  const ninetyDaysAgo = new Date();
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
  const staleContainers = await db
    .select({
      id: containers.id,
      containerNumber: containers.containerNumber,
      supplierName: suppliers.legalName,
      grandTotal: containers.grandTotal,
      createdAt: containers.createdAt,
    })
    .from(containers)
    .leftJoin(suppliers, eq(containers.supplierId, suppliers.id))
    .where(
      and(
        eq(containers.companyId, companyId),
        eq(containers.status, "OTW"),
        sql`${containers.createdAt} < ${ninetyDaysAgo.toISOString()}`
      )
    );

  for (const container of staleContainers) {
    const value = toMoney(container.grandTotal).toNumber();
    const daysSinceCreated = Math.floor(
      (Date.now() - new Date(container.createdAt || 0).getTime()) / (1000 * 60 * 60 * 24)
    );
    issues.push({
      id: generateIssueId(),
      type: "stale_otw_container",
      severity: "warning",
      description: `Stale OTW container: ${container.containerNumber} (${daysSinceCreated} days old) from ${container.supplierName || "Unknown Supplier"}`,
      impact: value,
      details: {
        containerId: container.id,
        containerNumber: container.containerNumber,
        supplierName: container.supplierName,
        grandTotal: value,
        daysSinceCreated,
        createdAt: container.createdAt,
      },
      fixGuidance: "Offload this container if goods have arrived, or cancel if the shipment was lost/cancelled.",
    });
  }

  const duplicateInventory = await db
    .select({
      stockItemId: inventory.stockItemId,
      locationId: inventory.locationId,
      count: sql<number>`COUNT(*)`,
    })
    .from(inventory)
    .where(eq(inventory.companyId, companyId))
    .groupBy(inventory.stockItemId, inventory.locationId)
    .having(sql`COUNT(*) > 1`);

  for (const duplicate of duplicateInventory) {
    issues.push({
      id: generateIssueId(),
      type: "duplicate_inventory",
      severity: "critical",
      description: `Duplicate inventory records: ${duplicate.count} records for same stock item at same location`,
      impact: 0,
      details: {
        stockItemId: duplicate.stockItemId,
        locationId: duplicate.locationId,
        duplicateCount: duplicate.count,
      },
      fixGuidance: "Merge duplicate records by summing quantities and recalculating average rate.",
    });
  }

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

  const isParentContext = await isParentCompanyContext(companyId);
  let supplierOpeningTotal = new MoneyDecimal(0);
  if (isParentContext) {
    const allSuppliers = await storage.getAllSuppliers();
    const supplierIdsWithActivity = new Set(
      (
        await db
          .select({ supplierId: voucherEntries.supplierId })
          .from(voucherEntries)
          .innerJoin(vouchers, eq(voucherEntries.voucherId, vouchers.id))
          .where(
            and(
              isNotNull(voucherEntries.supplierId),
              eq(vouchers.companyId, companyId),
              isNull(vouchers.deletedAt),
              eq(vouchers.optional, false)
            )
          )
      )
        .map((entry) => entry.supplierId)
        .filter(Boolean)
    );

    const companyContainers = await db
      .select({ supplierId: containers.supplierId })
      .from(containers)
      .where(eq(containers.companyId, companyId));
    for (const container of companyContainers) {
      if (container.supplierId) supplierIdsWithActivity.add(container.supplierId);
    }

    supplierOpeningTotal = sumMoney(
      allSuppliers
        .filter((supplier) => supplierIdsWithActivity.has(supplier.id))
        .map((supplier) => supplier.openingBalance)
    );
  }

  const supplierBalance = supplierOpeningTotal.minus(debitMinusCredit(supplierEntries));

  const otwContainers = await db
    .select()
    .from(containers)
    .where(and(eq(containers.companyId, companyId), eq(containers.status, "OTW")));
  const stockOtwValue = sumMoney(otwContainers.map((container) => container.grandTotal));

  const cashBalance = await getAccountTypeBalance(companyId, "Cash", false);
  const ledgerBankBalance = await getAccountTypeBalance(companyId, "Bank", false);
  const standaloneBankEntries = await db
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
    );
  const standaloneBankAccounts = await db
    .select()
    .from(bankAccounts)
    .where(
      and(eq(bankAccounts.companyId, companyId), isNull(bankAccounts.deletedAt), isNull(bankAccounts.linkedLedgerId))
    );
  const standaloneBankOpening = sumMoney(
    standaloneBankAccounts.map((account) => drOpening(account.openingBalance, account.openingBalanceSide))
  );
  const standaloneBankVoucher = debitMinusCredit(standaloneBankEntries);

  const bankBalance = ledgerBankBalance.plus(standaloneBankOpening).plus(standaloneBankVoucher);
  const assetBalance = await getAccountTypeBalance(companyId, "Asset", false);
  const dutyAgentBalance = await getAccountTypeBalance(companyId, "Duty Agent", true);
  const transporterAgentBalance = await getAccountTypeBalance(companyId, "Transporter Agent", true);
  const loansBalance = await getAccountTypeBalance(companyId, "Loans", true);
  const liabilityBalance = await getAccountTypeBalance(companyId, "Liability", true);
  const profitBalance = await getAccountTypeBalance(companyId, "Profit", true);
  const incomeBalance = await getAccountTypeBalance(companyId, "Income", true);
  const indirectExpenseBalance = await getAccountTypeBalance(companyId, "Indirect Expense", false);
  const governmentTaxesBalance = await getAccountTypeBalance(companyId, "Government Taxes", false);
  const payrollExpenseBalance = await getAccountTypeBalance(companyId, "Payroll Expense", false);
  const salaryAdvancesBalance = await getAccountTypeBalance(companyId, "Salary Advances", false);
  const generalExpenseBalance = await getAccountTypeBalance(companyId, "Expense", false);
  const equityTransactionBalance = await getTransactionOnlyBalance(companyId, "Equity", true);
  const apTransactionBalance = await getTransactionOnlyBalance(companyId, "Accounts Payable", true);

  // Wave 11: the one stock valuation (stockValuation.ts, SUM(total_value)).
  const stockOnFloorValue = toMoney(await companyStockValue(db, companyId));

  const cogsData = await db
    .select({ totalCost: salesItems.totalCost })
    .from(salesItems)
    .innerJoin(vouchers, eq(salesItems.voucherId, vouchers.id))
    .where(and(eq(vouchers.companyId, companyId), isNull(vouchers.deletedAt), eq(vouchers.optional, false)));
  const cogsBalance = sumMoney(cogsData.map((item) => item.totalCost));

  const employeesData = await db
    .select({ currentBalance: employees.currentBalance })
    .from(employees)
    .where(and(eq(employees.companyId, companyId), isNull(employees.deletedAt)));
  const payrollLiabilitiesBalance = sumMoney(
    employeesData.map((employee) => toMoney(employee.currentBalance)).filter((balance) => balance.greaterThan(0))
  );

  const allAccountsForOpening = await db
    .select()
    .from(ledgerAccounts)
    .where(and(eq(ledgerAccounts.companyId, companyId), isNull(ledgerAccounts.deletedAt)));
  // Dr openings minus Cr openings is the sum of debit-signed openings, so the equity is its negation.
  const openingBalanceEquityBeforeStock = sumMoney(
    allAccountsForOpening.map((account) => drOpening(account.openingBalance, account.openingBalanceSide))
  ).negated();

  const stockItemsWithOpening = await db
    .select({ openingValue: stockItems.openingValue })
    .from(stockItems)
    .where(and(eq(stockItems.companyId, companyId), isNull(stockItems.deletedAt)));
  const openingStockValue = sumMoney(stockItemsWithOpening.map((item) => item.openingValue));
  const openingBalanceEquity = openingBalanceEquityBeforeStock.minus(openingStockValue);

  const assets = sumMoney([
    stockOtwValue,
    cashBalance,
    bankBalance,
    stockOnFloorValue,
    assetBalance,
    salaryAdvancesBalance,
    indirectExpenseBalance,
    payrollExpenseBalance,
    governmentTaxesBalance,
    cogsBalance,
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
  // Math.round's rule (halves toward +infinity), applied to the exact value.
  const netImportCycleBalance = assets.minus(liabilities).toDecimalPlaces(2, MoneyDecimal.ROUND_HALF_CEIL).toNumber();

  return {
    issues,
    stockOtwValue: stockOtwValue.toNumber(),
    cashBalance: cashBalance.toNumber(),
    bankBalance: bankBalance.toNumber(),
    stockOnFloorValue: stockOnFloorValue.toNumber(),
    assetBalance: assetBalance.toNumber(),
    salaryAdvancesBalance: salaryAdvancesBalance.toNumber(),
    indirectExpenseBalance: indirectExpenseBalance.toNumber(),
    payrollExpenseBalance: payrollExpenseBalance.toNumber(),
    governmentTaxesBalance: governmentTaxesBalance.toNumber(),
    cogsBalance: cogsBalance.toNumber(),
    supplierBalance: supplierBalance.toNumber(),
    dutyAgentBalance: dutyAgentBalance.toNumber(),
    transporterAgentBalance: transporterAgentBalance.toNumber(),
    loansBalance: loansBalance.toNumber(),
    liabilityBalance: liabilityBalance.toNumber(),
    profitBalance: profitBalance.toNumber(),
    equityTransactionBalance: equityTransactionBalance.toNumber(),
    apTransactionBalance: apTransactionBalance.toNumber(),
    incomeBalance: incomeBalance.toNumber(),
    payrollLiabilitiesBalance: payrollLiabilitiesBalance.toNumber(),
    openingBalanceEquity: openingBalanceEquity.toNumber(),
    openingStockValue: openingStockValue.toNumber(),
    generalExpenseBalance: generalExpenseBalance.toNumber(),
    netImportCycleBalance,
  };
}
