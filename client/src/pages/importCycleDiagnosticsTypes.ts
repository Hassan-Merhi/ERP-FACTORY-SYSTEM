// Extracted from ./ImportCycleDiagnostics.tsx: response types and display metadata.
export interface ImportCycleData {
  netImportCycleBalance: number;
  components: {
    supplierBalance: number;
    stockOtwValue: number;
    dutyAgentBalance: number;
    transporterAgentBalance: number;
    loansBalance: number;
    cashBalance: number;
    bankBalance: number;
    assetBalance: number;
    directExpenseBalance: number;
    indirectExpenseBalance: number;
    generalExpenseBalance: number;
    governmentTaxesBalance: number;
    incomeBalance: number;
    liabilityBalance: number;
    profitBalance: number;
    equityTransactionBalance: number;
    apTransactionBalance: number;
    stockOnFloorValue: number;
    cogsBalance: number;
    consumptionBalance: number;
    productionBalance: number;
    payrollExpenseBalance: number;
    salaryAdvancesBalance: number;
    payrollLiabilitiesBalance: number;
    openingBalanceEquity: number;
    openingStockValue: number;
  };
}

export interface DiagnosticIssue {
  id: string;
  severity: "critical" | "warning" | "info";
  title: string;
  description: string;
  impact: number;
  howToFix: string;
  category: string;
}

export interface BucketVariance {
  bucket: string;
  computed: number;
  fromAccounts: number;
  variance: number;
  accountsInBucket: number;
}

export interface UncategorizedAccount {
  accountId: number;
  accountName: string;
  accountCode: string;
  parentType: string;
  bucket: string;
  balance: number;
}

export interface ComponentAudit {
  key: string;
  label: string;
  value: number;
  source: "ledger" | "inventory" | "containers" | "sales" | "employees" | "calculated";
  ledgerVerified: boolean;
  ledgerSum?: number;
  variance?: number;
}

export interface Reconciliation {
  buckets: BucketVariance[];
  uncategorizedAccounts: UncategorizedAccount[];
  totalUncategorized: number;
  significantVarianceCount: number;
  componentAudit?: ComponentAudit[];
}

export interface ContainerAuditEntry {
  containerId: number;
  containerNumber: string;
  status: string;
  supplierName: string;
  itemsTotal: number;
  chargesTotal: number;
  grandTotal: number;
  voucherDebits: number;
  voucherCredits: number;
  difference: number;
  voucherCount: number;
  hasDiscrepancy: boolean;
}

export interface DiagnosticsData {
  issues: DiagnosticIssue[];
  summary: {
    totalIssues: number;
    criticalCount: number;
    warningCount: number;
    totalImpact: number;
  };
  reconciliation?: Reconciliation;
  containerAudit?: ContainerAuditEntry[];
}

export interface ComponentInfo {
  key: string;
  label: string;
  category: "asset" | "expense" | "liability";
  inFormula: boolean;
  sign: "+" | "-";
}

export const componentConfig: ComponentInfo[] = [
  { key: "stockOtwValue", label: "Stock OTW (In Transit)", category: "asset", inFormula: true, sign: "+" },
  { key: "cashBalance", label: "Cash", category: "asset", inFormula: true, sign: "+" },
  { key: "bankBalance", label: "Bank", category: "asset", inFormula: true, sign: "+" },
  { key: "stockOnFloorValue", label: "Stock on Floor", category: "asset", inFormula: true, sign: "+" },
  { key: "assetBalance", label: "Other Assets", category: "asset", inFormula: true, sign: "+" },
  { key: "salaryAdvancesBalance", label: "Salary Advances", category: "asset", inFormula: true, sign: "+" },
  { key: "indirectExpenseBalance", label: "Indirect Expenses", category: "expense", inFormula: true, sign: "+" },
  { key: "payrollExpenseBalance", label: "Payroll Expenses", category: "expense", inFormula: true, sign: "+" },
  { key: "governmentTaxesBalance", label: "Government Taxes", category: "expense", inFormula: true, sign: "+" },
  { key: "cogsBalance", label: "Cost of Goods Sold", category: "expense", inFormula: true, sign: "+" },
  { key: "supplierBalance", label: "Supplier Payables", category: "liability", inFormula: true, sign: "-" },
  { key: "dutyAgentBalance", label: "Duty Agent", category: "liability", inFormula: true, sign: "-" },
  { key: "transporterAgentBalance", label: "Transporter Agent", category: "liability", inFormula: true, sign: "-" },
  { key: "loansBalance", label: "Loans", category: "liability", inFormula: true, sign: "-" },
  { key: "liabilityBalance", label: "Other Liabilities", category: "liability", inFormula: true, sign: "-" },
  { key: "profitBalance", label: "Profit / Retained Earnings", category: "liability", inFormula: true, sign: "-" },
  { key: "equityTransactionBalance", label: "Equity Transfers", category: "liability", inFormula: true, sign: "-" },
  { key: "apTransactionBalance", label: "Accounts Payable", category: "liability", inFormula: true, sign: "-" },
  { key: "incomeBalance", label: "Income", category: "liability", inFormula: true, sign: "-" },
  { key: "payrollLiabilitiesBalance", label: "Payroll Liabilities", category: "liability", inFormula: true, sign: "-" },
  { key: "openingBalanceEquity", label: "Opening Balance Equity", category: "liability", inFormula: true, sign: "+" },
  {
    key: "directExpenseBalance",
    label: "Import Charges (capitalised)",
    category: "expense",
    inFormula: false,
    sign: "+",
  },
  {
    key: "generalExpenseBalance",
    label: "General Expenses (Purchases)",
    category: "expense",
    inFormula: false,
    sign: "+",
  },
  { key: "consumptionBalance", label: "Consumption (in inventory)", category: "expense", inFormula: false, sign: "+" },
  { key: "productionBalance", label: "Production (in inventory)", category: "expense", inFormula: false, sign: "+" },
  { key: "openingStockValue", label: "Opening Stock Value", category: "asset", inFormula: false, sign: "+" },
];

export const CATEGORY_META = {
  asset: {
    label: "Assets",
    colorClass: "text-green-600 dark:text-green-400",
    bgClass: "bg-green-50 dark:bg-green-950/40",
    borderClass: "border-green-200 dark:border-green-800",
  },
  expense: {
    label: "Expenses",
    colorClass: "text-amber-600 dark:text-amber-400",
    bgClass: "bg-amber-50 dark:bg-amber-950/40",
    borderClass: "border-amber-200 dark:border-amber-800",
  },
  liability: {
    label: "Liabilities",
    colorClass: "text-red-600 dark:text-red-400",
    bgClass: "bg-red-50 dark:bg-red-950/40",
    borderClass: "border-red-200 dark:border-red-800",
  },
};
