import { db } from "../../db";
import { round2 } from "../../netPositionHelper";
import { suppliers, voucherEntries, vouchers } from "@shared/schema";
import { and, eq, sql } from "drizzle-orm";
import type { ImportCycleBalanceSnapshot } from "./importCycleDiagnosticTypes";
import { plusMoney, toMoney } from "../../lib/money";
import { buildImportCycleDiagnosticsStep1 } from "./buildImportCycleDiagnosticsStep1";
import { buildImportCycleDiagnosticsStep2 } from "./buildImportCycleDiagnosticsStep2";

export async function buildImportCycleDiagnostics(companyId: number, snapshot: ImportCycleBalanceSnapshot) {
  const {
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
  } = await buildImportCycleDiagnosticsStep1(companyId, snapshot);
  const { containerAudit, offloadedContainers, reconciliation } = await buildImportCycleDiagnosticsStep2(
    {
      assetBalance,
      bankBalance,
      cashBalance,
      cogsBalance,
      dutyAgentBalance,
      governmentTaxesBalance,
      incomeBalance,
      indirectExpenseBalance,
      issues,
      liabilityBalance,
      loansBalance,
      openingBalanceEquity,
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
    },
    companyId
  );
  const { totalAssets, totalExpenses, totalIssueImpact, totalLiabilities } = await buildImportCycleDiagnosticsStep3(
    {
      apTransactionBalance,
      assetBalance,
      bankBalance,
      cashBalance,
      cogsBalance,
      containerAudit,
      dutyAgentBalance,
      equityTransactionBalance,
      governmentTaxesBalance,
      incomeBalance,
      indirectExpenseBalance,
      issues,
      liabilityBalance,
      loansBalance,
      offloadedContainers,
      payrollExpenseBalance,
      payrollLiabilitiesBalance,
      profitBalance,
      salaryAdvancesBalance,
      stockOnFloorValue,
      stockOtwValue,
      supplierBalance,
      transporterAgentBalance,
    },
    companyId
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

async function buildImportCycleDiagnosticsStep3(
  {
    apTransactionBalance,
    assetBalance,
    bankBalance,
    cashBalance,
    cogsBalance,
    containerAudit,
    dutyAgentBalance,
    equityTransactionBalance,
    governmentTaxesBalance,
    incomeBalance,
    indirectExpenseBalance,
    issues,
    liabilityBalance,
    loansBalance,
    offloadedContainers,
    payrollExpenseBalance,
    payrollLiabilitiesBalance,
    profitBalance,
    salaryAdvancesBalance,
    stockOnFloorValue,
    stockOtwValue,
    supplierBalance,
    transporterAgentBalance,
  }: Pick<
    Awaited<ReturnType<typeof buildImportCycleDiagnosticsStep1>> &
      Awaited<ReturnType<typeof buildImportCycleDiagnosticsStep2>>,
    | "apTransactionBalance"
    | "assetBalance"
    | "bankBalance"
    | "cashBalance"
    | "cogsBalance"
    | "containerAudit"
    | "dutyAgentBalance"
    | "equityTransactionBalance"
    | "governmentTaxesBalance"
    | "incomeBalance"
    | "indirectExpenseBalance"
    | "issues"
    | "liabilityBalance"
    | "loansBalance"
    | "offloadedContainers"
    | "payrollExpenseBalance"
    | "payrollLiabilitiesBalance"
    | "profitBalance"
    | "salaryAdvancesBalance"
    | "stockOnFloorValue"
    | "stockOtwValue"
    | "supplierBalance"
    | "transporterAgentBalance"
  >,
  companyId: number
) {
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
      totalDebits = plusMoney(totalDebits, entry.debitAmount);
      totalCredits = plusMoney(totalCredits, entry.creditAmount);
    }
    const difference = round2(totalDebits - totalCredits);
    containerAudit.push({
      containerId: container.id,
      containerNumber: container.containerNumber,
      status: container.status,
      supplierName,
      itemsTotal: toMoney(container.itemsTotal).toNumber(),
      chargesTotal: toMoney(container.chargesTotal).toNumber(),
      grandTotal: toMoney(container.grandTotal).toNumber(),
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
  return { totalAssets, totalExpenses, totalIssueImpact, totalLiabilities };
}
