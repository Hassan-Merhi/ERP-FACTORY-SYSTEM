import { db } from "../../db";
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
import type { DiagnosticIssue, ImportCycleBalanceSnapshot } from "./importCycleDiagnosticTypes";

async function getAccountTypeBalance(companyId: number, accountType: string, isLiability = false) {
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

  let totalBalance = 0;
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

    const openingBalanceRaw = parseFloat(account.openingBalance || "0");
    const openingSide = account.openingBalanceSide || "Dr";
    const signedOpening = isLiability
      ? openingSide === "Cr"
        ? openingBalanceRaw
        : -openingBalanceRaw
      : openingSide === "Dr"
        ? openingBalanceRaw
        : -openingBalanceRaw;

    const balance = entries.reduce((sum, entry) => {
      const credit = parseFloat(entry.creditAmount || "0");
      const debit = parseFloat(entry.debitAmount || "0");
      return isLiability ? sum + credit - debit : sum + debit - credit;
    }, signedOpening);

    totalBalance += balance;
  }

  return totalBalance;
}

async function getTransactionOnlyBalance(companyId: number, accountType: string, isLiability = true) {
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

  const totalCredit = parseFloat(result[0]?.totalCredit || "0");
  const totalDebit = parseFloat(result[0]?.totalDebit || "0");
  return isLiability ? totalCredit - totalDebit : totalDebit - totalCredit;
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
    })
    .from(inventory)
    .innerJoin(stockItems, eq(inventory.stockItemId, stockItems.id))
    .leftJoin(locations, eq(inventory.locationId, locations.id))
    .where(and(eq(inventory.companyId, companyId), sql`CAST(${inventory.quantity} AS DECIMAL) < 0`));

  for (const item of negativeInventory) {
    const qty = parseFloat(item.quantity || "0");
    const rate = parseFloat(item.averageRate || "0");
    const impact = Math.abs(qty * rate);
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
    })
    .from(inventory)
    .innerJoin(stockItems, eq(inventory.stockItemId, stockItems.id))
    .leftJoin(locations, eq(inventory.locationId, locations.id))
    .where(and(eq(inventory.companyId, companyId), or(isNull(locations.id), isNotNull(locations.deletedAt))));

  for (const item of orphanedInventory) {
    const qty = parseFloat(item.quantity || "0");
    const rate = parseFloat(item.averageRate || "0");
    const impact = Math.abs(qty * rate);
    if (impact > 0.01) {
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
    const debit = parseFloat(voucher.totalDebit || "0");
    const credit = parseFloat(voucher.totalCredit || "0");
    const difference = Math.abs(debit - credit);
    if (difference > 0.01) {
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
          totalDebit: debit,
          totalCredit: credit,
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
    const value = parseFloat(container.grandTotal || "0");
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
  let supplierOpeningTotal = 0;
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

    supplierOpeningTotal = allSuppliers
      .filter((supplier) => supplierIdsWithActivity.has(supplier.id))
      .reduce((sum, supplier) => sum + parseFloat(supplier.openingBalance || "0"), 0);
  }

  const supplierBalance = supplierEntries.reduce(
    (sum, entry) => sum + parseFloat(entry.creditAmount || "0") - parseFloat(entry.debitAmount || "0"),
    supplierOpeningTotal
  );

  const otwContainers = await db
    .select()
    .from(containers)
    .where(and(eq(containers.companyId, companyId), eq(containers.status, "OTW")));
  const stockOtwValue = otwContainers.reduce((sum, container) => sum + parseFloat(container.grandTotal || "0"), 0);

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
      and(
        eq(bankAccounts.companyId, companyId),
        isNull(bankAccounts.deletedAt),
        isNull(bankAccounts.linkedLedgerId)
      )
    );
  const standaloneBankOpening = standaloneBankAccounts.reduce((sum, account) => {
    const openingBalanceRaw = parseFloat(account.openingBalance || "0");
    const openingSide = account.openingBalanceSide || "Dr";
    return sum + (openingSide === "Dr" ? openingBalanceRaw : -openingBalanceRaw);
  }, 0);
  const standaloneBankVoucher = standaloneBankEntries.reduce((sum, entry) => {
    const credit = parseFloat(entry.creditAmount || "0");
    const debit = parseFloat(entry.debitAmount || "0");
    return sum + debit - credit;
  }, 0);

  const bankBalance = ledgerBankBalance + standaloneBankOpening + standaloneBankVoucher;
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

  const inventoryItems = await db
    .select({ quantity: inventory.quantity, averageRate: inventory.averageRate })
    .from(inventory)
    .innerJoin(locations, eq(inventory.locationId, locations.id))
    .where(and(eq(inventory.companyId, companyId), isNull(locations.deletedAt)));
  const stockOnFloorValue = inventoryItems.reduce(
    (sum, item) => sum + parseFloat(item.quantity || "0") * parseFloat(item.averageRate || "0"),
    0
  );

  const cogsData = await db
    .select({ totalCost: salesItems.totalCost })
    .from(salesItems)
    .innerJoin(vouchers, eq(salesItems.voucherId, vouchers.id))
    .where(and(eq(vouchers.companyId, companyId), isNull(vouchers.deletedAt), eq(vouchers.optional, false)));
  const cogsBalance = cogsData.reduce((sum, item) => sum + parseFloat(item.totalCost || "0"), 0);

  const employeesData = await db
    .select({ currentBalance: employees.currentBalance })
    .from(employees)
    .where(and(eq(employees.companyId, companyId), isNull(employees.deletedAt)));
  const payrollLiabilitiesBalance = employeesData.reduce((sum, employee) => {
    const balance = parseFloat(employee.currentBalance || "0");
    return sum + (balance > 0 ? balance : 0);
  }, 0);

  const allAccountsForOpening = await db
    .select()
    .from(ledgerAccounts)
    .where(and(eq(ledgerAccounts.companyId, companyId), isNull(ledgerAccounts.deletedAt)));
  let totalDrOpenings = 0;
  let totalCrOpenings = 0;
  for (const account of allAccountsForOpening) {
    const openingBalanceRaw = parseFloat(account.openingBalance || "0");
    const openingSide = account.openingBalanceSide || "Dr";
    if (openingSide === "Dr") totalDrOpenings += openingBalanceRaw;
    else totalCrOpenings += openingBalanceRaw;
  }
  let openingBalanceEquity = totalCrOpenings - totalDrOpenings;

  const stockItemsWithOpening = await db
    .select({ openingValue: stockItems.openingValue })
    .from(stockItems)
    .where(and(eq(stockItems.companyId, companyId), isNull(stockItems.deletedAt)));
  const openingStockValue = stockItemsWithOpening.reduce(
    (sum, item) => sum + parseFloat(item.openingValue || "0"),
    0
  );
  openingBalanceEquity -= openingStockValue;

  const netImportCycleBalance =
    Math.round(
      (stockOtwValue +
        cashBalance +
        bankBalance +
        stockOnFloorValue +
        assetBalance +
        salaryAdvancesBalance +
        indirectExpenseBalance +
        payrollExpenseBalance +
        governmentTaxesBalance +
        cogsBalance -
        (supplierBalance +
          dutyAgentBalance +
          transporterAgentBalance +
          loansBalance +
          liabilityBalance +
          profitBalance +
          equityTransactionBalance +
          apTransactionBalance +
          incomeBalance +
          payrollLiabilitiesBalance -
          openingBalanceEquity)) *
        100
    ) / 100;

  return {
    issues,
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
    openingBalanceEquity,
    openingStockValue,
    generalExpenseBalance,
    netImportCycleBalance,
  };
}
