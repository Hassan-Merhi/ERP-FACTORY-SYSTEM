// Extracted from ./importCycleDiagnosticAnalysis.ts to keep that module under the source-size cap.
import { db } from "../../db";
import { round2 } from "../../netPositionHelper";
import { ledgerAccounts } from "@shared/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { AccountContribution, BucketVariance, ImportCycleBalanceSnapshot } from "./importCycleDiagnosticTypes";
import { toMoney } from "../../lib/money";

export async function buildImportCycleDiagnosticsStep1(companyId: number, snapshot: ImportCycleBalanceSnapshot) {
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
      currentBalanceSide: sql<string>`COALESCE(${ledgerAccounts.openingBalanceSide}, 'Dr')`.as("currentBalanceSide"),
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
    const balanceRaw = toMoney(account.currentBalance).toNumber();
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
    variance.accountsInBucket = accountContributions.filter((account) => account.bucket === variance.bucket).length;
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
  return {
    apTransactionBalance,
    assetBalance,
    bankBalance,
    cashBalance,
    cogsBalance,
    dutyAgentBalance,
    equityTransactionBalance,
    governmentTaxesBalance,
    incomeBalance,
    indirectExpenseBalance,
    issues,
    liabilityBalance,
    loansBalance,
    netImportCycleBalance,
    openingBalanceEquity,
    openingStockValue,
    payrollExpenseBalance,
    payrollLiabilitiesBalance,
    profitBalance,
    reconBuckets,
    salaryAdvancesBalance,
    significantVariances,
    stockOnFloorValue,
    stockOtwValue,
    supplierBalance,
    transporterAgentBalance,
    uncategorizedAccounts,
    variances,
  };
}
