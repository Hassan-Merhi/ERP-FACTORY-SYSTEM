import { db } from "../../db";
import { round2 } from "../../netPositionHelper";
import { containers, ledgerAccounts, suppliers, voucherEntries, vouchers } from "@shared/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import type {
  AccountContribution,
  BucketVariance,
  ComponentAudit,
  ContainerAuditEntry,
  ImportCycleBalanceSnapshot,
} from "./importCycleDiagnosticTypes";

export async function buildImportCycleDiagnostics(companyId: number, snapshot: ImportCycleBalanceSnapshot) {
  const {
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
    netImportCycleBalance,
  } = snapshot;

  const accountContributions: AccountContribution[] = [];
  const allAccountsForRecon = await db
    .select({
      id: ledgerAccounts.id,
      name: ledgerAccounts.name,
      code: ledgerAccounts.code,
      parentType: sql<string>`${ledgerAccounts.accountType}`.as("parentType"),
      currentBalance: sql<string>`COALESCE(${ledgerAccounts.openingBalance}, '0')`.as("currentBalance"),
      currentBalanceSide: sql<string>`COALESCE(${ledgerAccounts.openingBalanceSide}, 'Dr')`.as(
        "currentBalanceSide"
      ),
    })
    .from(ledgerAccounts)
    .where(and(eq(ledgerAccounts.companyId, companyId), isNull(ledgerAccounts.deletedAt)));

  const reconBuckets: Record<string, number> = {
    supplierBalance: 0,
    dutyAgentBalance: 0,
    transporterAgentBalance: 0,
    loansBalance: 0,
    liabilityBalance: 0,
    profitBalance: 0,
    incomeBalance: 0,
    assetBalance: 0,
    indirectExpenseBalance: 0,
    governmentTaxesBalance: 0,
    salaryAdvancesBalance: 0,
    payrollExpenseBalance: 0,
    cashBalance: 0,
    bankBalance: 0,
    uncategorized: 0,
  };

  for (const account of allAccountsForRecon) {
    const balanceRaw = parseFloat(account.currentBalance || "0");
    if (Math.abs(balanceRaw) < 0.01) continue;

    const parentType = account.parentType || "UNKNOWN";
    const name = account.name?.toUpperCase() || "";
    const side = account.currentBalanceSide || "Dr";
    let bucket = "uncategorized";
    let signedBalance = balanceRaw;

    if (parentType === "SUPPLIER") {
      bucket = "supplierBalance";
      signedBalance = side === "Cr" ? balanceRaw : -balanceRaw;
    } else if (parentType === "DUTY_AGENT") {
      bucket = "dutyAgentBalance";
      signedBalance = side === "Cr" ? balanceRaw : -balanceRaw;
    } else if (parentType === "TRANSPORTER_AGENT") {
      bucket = "transporterAgentBalance";
      signedBalance = side === "Cr" ? balanceRaw : -balanceRaw;
    } else if (parentType === "LOAN") {
      bucket = "loansBalance";
      signedBalance = side === "Cr" ? balanceRaw : -balanceRaw;
    } else if (parentType === "LIABILITY") {
      bucket = "liabilityBalance";
      signedBalance = side === "Cr" ? balanceRaw : -balanceRaw;
    } else if (parentType === "PROFIT") {
      bucket = "profitBalance";
      signedBalance = side === "Cr" ? balanceRaw : -balanceRaw;
    } else if (parentType === "INCOME" || parentType === "SALES") {
      bucket = "incomeBalance";
      signedBalance = side === "Cr" ? balanceRaw : -balanceRaw;
    } else if (parentType === "ASSET") {
      bucket = "assetBalance";
      signedBalance = side === "Dr" ? balanceRaw : -balanceRaw;
    } else if (parentType === "INDIRECT_EXPENSE" || parentType === "OPERATING_EXPENSE") {
      bucket = "indirectExpenseBalance";
      signedBalance = side === "Dr" ? balanceRaw : -balanceRaw;
    } else if (parentType === "GOVERNMENT_TAXES") {
      bucket = "governmentTaxesBalance";
      signedBalance = side === "Dr" ? balanceRaw : -balanceRaw;
    } else if (parentType === "SALARY_ADVANCE") {
      bucket = "salaryAdvancesBalance";
      signedBalance = side === "Dr" ? balanceRaw : -balanceRaw;
    } else if (parentType === "CASH") {
      bucket = "cashBalance";
      signedBalance = side === "Dr" ? balanceRaw : -balanceRaw;
    } else if (parentType === "BANK") {
      bucket = "bankBalance";
      signedBalance = side === "Dr" ? balanceRaw : -balanceRaw;
    } else if (name.includes("SALARY") || name.includes("PAYROLL") || name.includes("WAGE")) {
      if (parentType?.includes("EXPENSE")) {
        bucket = "payrollExpenseBalance";
        signedBalance = side === "Dr" ? balanceRaw : -balanceRaw;
      }
    }

    reconBuckets[bucket] = round2((reconBuckets[bucket] || 0) + signedBalance);
    accountContributions.push({
      accountId: account.id,
      accountName: account.name || "Unknown",
      accountCode: account.code || "",
      parentType,
      bucket,
      balance: round2(signedBalance),
    });
  }

  const variances: BucketVariance[] = [
    ["supplierBalance", supplierBalance],
    ["dutyAgentBalance", dutyAgentBalance],
    ["transporterAgentBalance", transporterAgentBalance],
    ["loansBalance", loansBalance],
    ["liabilityBalance", liabilityBalance],
    ["profitBalance", profitBalance],
    ["incomeBalance", incomeBalance],
    ["assetBalance", assetBalance],
    ["indirectExpenseBalance", indirectExpenseBalance],
    ["governmentTaxesBalance", governmentTaxesBalance],
    ["salaryAdvancesBalance", salaryAdvancesBalance],
    ["payrollExpenseBalance", payrollExpenseBalance],
    ["cashBalance", cashBalance],
    ["bankBalance", bankBalance],
  ].map(([bucket, computed]) => ({
    bucket: bucket as string,
    computed: round2(computed as number),
    fromAccounts: reconBuckets[bucket as string],
    variance: 0,
    accountsInBucket: 0,
  }));

  for (const variance of variances) {
    variance.variance = round2(variance.computed - variance.fromAccounts);
    variance.accountsInBucket = accountContributions.filter(
      (account) => account.bucket === variance.bucket
    ).length;
  }

  const significantVariances = variances.filter((variance) => Math.abs(variance.variance) > 1);
  const uncategorizedAccounts = accountContributions.filter(
    (account) => account.bucket === "uncategorized" && Math.abs(account.balance) > 1
  );

  if (uncategorizedAccounts.length > 0) {
    const totalUncategorized = uncategorizedAccounts.reduce((sum, account) => sum + account.balance, 0);
    issues.push({
      id: "uncategorized-accounts",
      type: "uncategorized-accounts",
      details: { accounts: uncategorizedAccounts },
      severity: "warning",
      title: "Accounts with Unknown Category",
      description: `Found ${uncategorizedAccounts.length} account(s) with balance of $${Math.abs(totalUncategorized).toFixed(2)} that don't fit any standard category. These may be causing the imbalance.`,
      impact: Math.abs(totalUncategorized),
      howToFix:
        "Review these accounts and ensure they have the correct parent type set: " +
        uncategorizedAccounts.map((account) => account.accountName).join(", "),
      category: "Account Mapping",
    });
  }

  for (const variance of significantVariances) {
    issues.push({
      id: `variance-${variance.bucket}`,
      type: "variance",
      details: {
        bucket: variance.bucket,
        computed: variance.computed,
        fromAccounts: variance.fromAccounts,
      },
      severity: "warning",
      title: `Variance in ${variance.bucket}`,
      description: `Computed value ($${variance.computed.toFixed(2)}) differs from account-level sum ($${variance.fromAccounts.toFixed(2)}) by $${Math.abs(variance.variance).toFixed(2)}. This may indicate double-counting or a calculation discrepancy.`,
      impact: Math.abs(variance.variance),
      howToFix:
        "Check if any accounts are being counted in multiple buckets, or if there's a special calculation that's not reflected in the account balances.",
      category: "Reconciliation",
    });
  }

  const componentAudit: ComponentAudit[] = [
    {
      key: "stockOtwValue",
      label: "Stock OTW",
      value: round2(stockOtwValue),
      source: "containers",
      ledgerVerified: false,
    },
    {
      key: "cashBalance",
      label: "Cash",
      value: round2(cashBalance),
      source: "ledger",
      ledgerVerified: true,
      ledgerSum: reconBuckets.cashBalance,
      variance: round2(cashBalance - reconBuckets.cashBalance),
    },
    {
      key: "bankBalance",
      label: "Bank",
      value: round2(bankBalance),
      source: "ledger",
      ledgerVerified: true,
      ledgerSum: reconBuckets.bankBalance,
      variance: round2(bankBalance - reconBuckets.bankBalance),
    },
    {
      key: "stockOnFloorValue",
      label: "Stock on Floor",
      value: round2(stockOnFloorValue),
      source: "inventory",
      ledgerVerified: false,
    },
    {
      key: "assetBalance",
      label: "Other Assets",
      value: round2(assetBalance),
      source: "ledger",
      ledgerVerified: true,
      ledgerSum: reconBuckets.assetBalance,
      variance: round2(assetBalance - reconBuckets.assetBalance),
    },
    {
      key: "salaryAdvancesBalance",
      label: "Salary Advances",
      value: round2(salaryAdvancesBalance),
      source: "ledger",
      ledgerVerified: true,
      ledgerSum: reconBuckets.salaryAdvancesBalance,
      variance: round2(salaryAdvancesBalance - reconBuckets.salaryAdvancesBalance),
    },
    {
      key: "indirectExpenseBalance",
      label: "Indirect Expenses",
      value: round2(indirectExpenseBalance),
      source: "ledger",
      ledgerVerified: true,
      ledgerSum: reconBuckets.indirectExpenseBalance,
      variance: round2(indirectExpenseBalance - reconBuckets.indirectExpenseBalance),
    },
    {
      key: "payrollExpenseBalance",
      label: "Payroll Expenses",
      value: round2(payrollExpenseBalance),
      source: "ledger",
      ledgerVerified: true,
      ledgerSum: reconBuckets.payrollExpenseBalance,
      variance: round2(payrollExpenseBalance - reconBuckets.payrollExpenseBalance),
    },
    {
      key: "governmentTaxesBalance",
      label: "Gov Taxes",
      value: round2(governmentTaxesBalance),
      source: "ledger",
      ledgerVerified: true,
      ledgerSum: reconBuckets.governmentTaxesBalance,
      variance: round2(governmentTaxesBalance - reconBuckets.governmentTaxesBalance),
    },
    { key: "cogsBalance", label: "COGS", value: round2(cogsBalance), source: "sales", ledgerVerified: false },
    {
      key: "supplierBalance",
      label: "Suppliers",
      value: round2(supplierBalance),
      source: "ledger",
      ledgerVerified: true,
      ledgerSum: reconBuckets.supplierBalance,
      variance: round2(supplierBalance - reconBuckets.supplierBalance),
    },
    {
      key: "dutyAgentBalance",
      label: "Duty Agent",
      value: round2(dutyAgentBalance),
      source: "ledger",
      ledgerVerified: true,
      ledgerSum: reconBuckets.dutyAgentBalance,
      variance: round2(dutyAgentBalance - reconBuckets.dutyAgentBalance),
    },
    {
      key: "transporterAgentBalance",
      label: "Transporter",
      value: round2(transporterAgentBalance),
      source: "ledger",
      ledgerVerified: true,
      ledgerSum: reconBuckets.transporterAgentBalance,
      variance: round2(transporterAgentBalance - reconBuckets.transporterAgentBalance),
    },
    {
      key: "loansBalance",
      label: "Loans",
      value: round2(loansBalance),
      source: "ledger",
      ledgerVerified: true,
      ledgerSum: reconBuckets.loansBalance,
      variance: round2(loansBalance - reconBuckets.loansBalance),
    },
    {
      key: "liabilityBalance",
      label: "Other Liabilities",
      value: round2(liabilityBalance),
      source: "ledger",
      ledgerVerified: true,
      ledgerSum: reconBuckets.liabilityBalance,
      variance: round2(liabilityBalance - reconBuckets.liabilityBalance),
    },
    {
      key: "profitBalance",
      label: "Profit",
      value: round2(profitBalance),
      source: "ledger",
      ledgerVerified: true,
      ledgerSum: reconBuckets.profitBalance,
      variance: round2(profitBalance - reconBuckets.profitBalance),
    },
    {
      key: "incomeBalance",
      label: "Income",
      value: round2(incomeBalance),
      source: "ledger",
      ledgerVerified: true,
      ledgerSum: reconBuckets.incomeBalance,
      variance: round2(incomeBalance - reconBuckets.incomeBalance),
    },
    {
      key: "payrollLiabilitiesBalance",
      label: "Payroll Liabilities",
      value: round2(payrollLiabilitiesBalance),
      source: "employees",
      ledgerVerified: false,
    },
    {
      key: "openingBalanceEquity",
      label: "Opening Equity",
      value: round2(openingBalanceEquity),
      source: "calculated",
      ledgerVerified: false,
    },
  ];

  const componentsWithVariance = componentAudit.filter(
    (component) => component.ledgerVerified && component.variance && Math.abs(component.variance) > 0.5
  );
  for (const component of componentsWithVariance) {
    issues.push({
      id: "variance-" + component.key,
      type: "component-variance",
      details: { key: component.key, value: component.value, ledgerSum: component.ledgerSum },
      severity: "warning",
      title: "Variance in " + component.label,
      description:
        "Computed: $" +
        component.value.toFixed(2) +
        ", Ledger sum: $" +
        (component.ledgerSum || 0).toFixed(2) +
        ", Difference: $" +
        Math.abs(component.variance || 0).toFixed(2),
      impact: Math.abs(component.variance || 0),
      howToFix:
        "Check the account categorization for " +
        component.label +
        " accounts. Some accounts may be miscategorized or double-counted.",
      category: "Reconciliation",
    });
  }

  const reconciliation = {
    buckets: variances,
    uncategorizedAccounts: uncategorizedAccounts.slice(0, 20),
    totalUncategorized: round2(reconBuckets.uncategorized),
    significantVarianceCount: significantVariances.length,
    componentAudit,
  };

  const containerAudit: ContainerAuditEntry[] = [];
  const offloadedContainers = await db
    .select({
      id: containers.id,
      containerNumber: containers.containerNumber,
      status: containers.status,
      supplierId: containers.supplierId,
      itemsTotal: containers.itemsTotal,
      chargesTotal: containers.chargesTotal,
      grandTotal: containers.grandTotal,
    })
    .from(containers)
    .where(and(eq(containers.companyId, companyId), eq(containers.status, "OFFLOADED")));

  for (const container of offloadedContainers) {
    const supplier = await db
      .select({ name: suppliers.legalName })
      .from(suppliers)
      .where(eq(suppliers.id, container.supplierId))
      .limit(1);
    const supplierName = supplier[0]?.name || "Unknown";
    const containerPattern = `%${container.containerNumber}%`;
    const relatedEntries = await db
      .select({
        id: voucherEntries.id,
        debitAmount: voucherEntries.debitAmount,
        creditAmount: voucherEntries.creditAmount,
        narration: voucherEntries.narration,
      })
      .from(voucherEntries)
      .innerJoin(vouchers, eq(voucherEntries.voucherId, vouchers.id))
      .where(
        and(
          eq(vouchers.companyId, companyId),
          sql`${voucherEntries.narration} ILIKE ${containerPattern}`,
          sql`COALESCE(${vouchers.optional}, false) = false`
        )
      );

    let totalDebits = 0;
    let totalCredits = 0;
    for (const entry of relatedEntries) {
      totalDebits += parseFloat(entry.debitAmount || "0");
      totalCredits += parseFloat(entry.creditAmount || "0");
    }
    const difference = round2(totalDebits - totalCredits);
    containerAudit.push({
      containerId: container.id,
      containerNumber: container.containerNumber,
      status: container.status,
      supplierName,
      itemsTotal: parseFloat(container.itemsTotal || "0"),
      chargesTotal: parseFloat(container.chargesTotal || "0"),
      grandTotal: parseFloat(container.grandTotal || "0"),
      voucherDebits: round2(totalDebits),
      voucherCredits: round2(totalCredits),
      difference,
      voucherCount: relatedEntries.length,
      hasDiscrepancy: Math.abs(difference) > 1,
    });
  }

  const containersWithDiscrepancy = containerAudit.filter((container) => container.hasDiscrepancy);
  for (const container of containersWithDiscrepancy) {
    issues.push({
      id: `container-discrepancy-${container.containerId}`,
      type: "container-discrepancy",
      details: {
        containerId: container.containerId,
        containerNumber: container.containerNumber,
        difference: container.difference,
      },
      severity: "critical",
      title: `Container ${container.containerNumber} has unbalanced entries`,
      description: `Voucher debits ($${container.voucherDebits.toFixed(2)}) do not equal credits ($${container.voucherCredits.toFixed(2)}). Difference: $${Math.abs(container.difference).toFixed(2)}. This container's offload entries are not balanced.`,
      impact: Math.abs(container.difference),
      howToFix: `Review voucher entries for container ${container.containerNumber}. A correction journal entry of $${Math.abs(container.difference).toFixed(2)} is needed to balance the books.`,
      category: "Container Offload",
    });
  }

  const totalIssueImpact = round2(issues.reduce((sum, issue) => sum + issue.impact, 0));
  const totalAssets = round2(stockOtwValue + cashBalance + bankBalance + stockOnFloorValue + assetBalance);
  const totalExpenses = round2(
    salaryAdvancesBalance + indirectExpenseBalance + payrollExpenseBalance + governmentTaxesBalance + cogsBalance
  );
  const totalLiabilities = round2(
    supplierBalance +
      dutyAgentBalance +
      transporterAgentBalance +
      loansBalance +
      liabilityBalance +
      profitBalance +
      equityTransactionBalance +
      apTransactionBalance +
      incomeBalance +
      payrollLiabilitiesBalance
  );

  return {
    totals: {
      assets: totalAssets,
      expenses: totalExpenses,
      liabilities: totalLiabilities,
      netBalance: netImportCycleBalance,
    },
    components: {
      stockOtwValue: round2(stockOtwValue),
      cashBalance: round2(cashBalance),
      bankBalance: round2(bankBalance),
      stockOnFloorValue: round2(stockOnFloorValue),
      assetBalance: round2(assetBalance),
      salaryAdvancesBalance: round2(salaryAdvancesBalance),
      indirectExpenseBalance: round2(indirectExpenseBalance),
      payrollExpenseBalance: round2(payrollExpenseBalance),
      governmentTaxesBalance: round2(governmentTaxesBalance),
      cogsBalance: round2(cogsBalance),
      supplierBalance: round2(supplierBalance),
      dutyAgentBalance: round2(dutyAgentBalance),
      transporterAgentBalance: round2(transporterAgentBalance),
      loansBalance: round2(loansBalance),
      liabilityBalance: round2(liabilityBalance),
      profitBalance: round2(profitBalance),
      equityTransactionBalance: round2(equityTransactionBalance),
      apTransactionBalance: round2(apTransactionBalance),
      incomeBalance: round2(incomeBalance),
      payrollLiabilitiesBalance: round2(payrollLiabilitiesBalance),
      openingBalanceEquity: round2(openingBalanceEquity),
      openingStockValue: round2(openingStockValue),
    },
    issues,
    summary: {
      totalIssues: issues.length,
      criticalIssues: issues.filter((issue) => issue.severity === "critical").length,
      warningIssues: issues.filter((issue) => issue.severity === "warning").length,
      totalIssueImpact,
    },
    reconciliation,
    containerAudit,
  };
}
