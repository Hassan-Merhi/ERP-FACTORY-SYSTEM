// Extracted from ./importCycleDiagnosticAnalysis.ts to keep that module under the source-size cap.
import { db } from "../../db";
import { round2 } from "../../netPositionHelper";
import { containers } from "@shared/schema";
import { and, eq } from "drizzle-orm";
import type { ComponentAudit, ContainerAuditEntry } from "./importCycleDiagnosticTypes";
import { buildImportCycleDiagnosticsStep1 } from "./buildImportCycleDiagnosticsStep1";

export async function buildImportCycleDiagnosticsStep2(
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
  }: Pick<
    Awaited<ReturnType<typeof buildImportCycleDiagnosticsStep1>>,
    | "assetBalance"
    | "bankBalance"
    | "cashBalance"
    | "cogsBalance"
    | "dutyAgentBalance"
    | "governmentTaxesBalance"
    | "incomeBalance"
    | "indirectExpenseBalance"
    | "issues"
    | "liabilityBalance"
    | "loansBalance"
    | "openingBalanceEquity"
    | "payrollExpenseBalance"
    | "payrollLiabilitiesBalance"
    | "profitBalance"
    | "reconBuckets"
    | "salaryAdvancesBalance"
    | "significantVariances"
    | "stockOnFloorValue"
    | "stockOtwValue"
    | "supplierBalance"
    | "transporterAgentBalance"
    | "uncategorizedAccounts"
    | "variances"
  >,
  companyId: number
) {
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
  return { containerAudit, offloadedContainers, reconciliation };
}
