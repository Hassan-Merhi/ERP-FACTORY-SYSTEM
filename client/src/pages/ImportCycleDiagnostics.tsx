import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/PageHeader";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  Info,
  TrendingUp,
  TrendingDown,
  Minus,
  Wrench,
  Database,
  Package,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { useCompany } from "@/contexts/CompanyContext";
import { useAppMode } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import { queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface ImportCycleData {
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

interface DiagnosticIssue {
  id: string;
  severity: "critical" | "warning" | "info";
  title: string;
  description: string;
  impact: number;
  howToFix: string;
  category: string;
}

interface BucketVariance {
  bucket: string;
  computed: number;
  fromAccounts: number;
  variance: number;
  accountsInBucket: number;
}

interface UncategorizedAccount {
  accountId: number;
  accountName: string;
  accountCode: string;
  parentType: string;
  bucket: string;
  balance: number;
}

interface ComponentAudit {
  key: string;
  label: string;
  value: number;
  source: "ledger" | "inventory" | "containers" | "sales" | "employees" | "calculated";
  ledgerVerified: boolean;
  ledgerSum?: number;
  variance?: number;
}

interface Reconciliation {
  buckets: BucketVariance[];
  uncategorizedAccounts: UncategorizedAccount[];
  totalUncategorized: number;
  significantVarianceCount: number;
  componentAudit?: ComponentAudit[];
}

interface ContainerAuditEntry {
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

interface DiagnosticsData {
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

interface ComponentInfo {
  key: string;
  label: string;
  category: "asset" | "expense" | "liability";
  inFormula: boolean;
  sign: "+" | "-";
}

const componentConfig: ComponentInfo[] = [
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

const CATEGORY_META = {
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

export default function ImportCycleDiagnostics() {
  const { formatAmount } = useCurrencyContext();
  const { selectedCompany } = useCompany();
  const appMode = useAppMode();
  const modeApiRequest = getApiRequest(appMode);
  const { toast } = useToast();

  const { data, isLoading, error, refetch } = useQuery<ImportCycleData>({
    queryKey: ["/api/stats/import-cycle-balance", selectedCompany?.id, appMode],
    queryFn: () =>
      modeApiRequest("GET", "/api/stats/import-cycle-balance").then((r) => {
        if (!r.ok) throw new Error("Failed to load import cycle balance");
        return r.json();
      }),
    enabled: !!selectedCompany,
  });

  const { data: diagnosticsData, isLoading: diagnosticsLoading } = useQuery<DiagnosticsData>({
    queryKey: ["/api/stats/import-cycle-diagnostics", selectedCompany?.id, appMode],
    queryFn: () =>
      modeApiRequest("GET", "/api/stats/import-cycle-diagnostics").then((r) => {
        if (!r.ok) throw new Error("Failed to load diagnostics");
        return r.json();
      }),
    enabled: !!selectedCompany,
  });

  const recalculateMutation = useMutation({
    mutationFn: () => {
      return modeApiRequest("POST", "/api/admin/recalculate-equity-adjustment").then((r) => {
        if (!r.ok) throw new Error("Recalculate failed");
        return r.json();
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/stats/import-cycle-balance"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats/import-cycle-diagnostics"] });
      toast({ title: "Recalculated", description: "Opening balance equity has been recalculated." });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  if (isLoading) {
    return (
      <div className="p-6 space-y-6">
        <Skeleton className="h-10 w-64" />
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <Card className="border-destructive">
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-destructive">
              <AlertCircle className="h-5 w-5" />
              <span>Failed to load data: {(error as Error).message}</span>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const netBalance = data?.netImportCycleBalance || 0;
  const isBalanced = Math.abs(netBalance) < 0.01;
  const components = data?.components || ({} as ImportCycleData["components"]);
  const issues = diagnosticsData?.issues || [];

  const activeComponents = componentConfig.filter(
    (c) => c.inFormula && (components[c.key as keyof typeof components] || 0) !== 0
  );
  const excludedComponents = componentConfig.filter(
    (c) => !c.inFormula && (components[c.key as keyof typeof components] || 0) !== 0
  );

  const assetComponents = activeComponents.filter((c) => c.category === "asset");
  const expenseComponents = activeComponents.filter((c) => c.category === "expense");
  const liabilityComponents = activeComponents.filter((c) => c.category === "liability");

  const assetTotal = assetComponents.reduce((s, c) => s + (components[c.key as keyof typeof components] || 0), 0);
  const expenseTotal = expenseComponents.reduce((s, c) => s + (components[c.key as keyof typeof components] || 0), 0);
  const liabilityTotal = liabilityComponents.reduce(
    (s, c) => s + (components[c.key as keyof typeof components] || 0),
    0
  );

  return (
    <div className="space-y-5 sm:p-4 md:p-6">
      {/* ── Header ── */}
      <PageHeader
        title="Import Cycle Balance"
        subtitle="Breakdown of what's driving your import cycle balance"
        backTarget="/settings"
        backButtonTestId="button-back-settings"
      >
        <Button onClick={() => refetch()} variant="outline" size="default" data-testid="button-refresh">
          <RefreshCw className="h-4 w-4 mr-1.5" />
          Refresh
        </Button>
        <Button
          onClick={() => recalculateMutation.mutate()}
          disabled={recalculateMutation.isPending}
          variant="outline"
          data-testid="button-recalculate-equity"
        >
          <RotateCcw className="h-4 w-4 mr-1.5" />
          {recalculateMutation.isPending ? "Recalculating…" : "Recalculate Equity"}
        </Button>
      </PageHeader>

      {/* ── Top summary: 3 buckets + net ── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {(["asset", "expense", "liability"] as const).map((cat) => {
          const meta = CATEGORY_META[cat];
          const total = cat === "asset" ? assetTotal : cat === "expense" ? expenseTotal : liabilityTotal;
          return (
            <Card key={cat} className={`border ${meta.borderClass}`}>
              <CardContent className="pt-4 pb-4">
                <div className={`text-xs font-medium uppercase tracking-wide mb-1 ${meta.colorClass}`}>
                  {meta.label}
                </div>
                <div className={`text-xl font-bold tabular-nums ${meta.colorClass}`}>{formatAmount(total)}</div>
              </CardContent>
            </Card>
          );
        })}

        <Card className={isBalanced ? "border-green-500 dark:border-green-600" : "border-destructive"}>
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center gap-1.5 mb-1">
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Net Balance</span>
              {isBalanced ? (
                <Badge variant="outline" className="status-success text-[10px] px-1 py-0">
                  <CheckCircle2 className="h-2.5 w-2.5 mr-0.5" />
                  Balanced
                </Badge>
              ) : (
                <Badge variant="destructive" className="text-[10px] px-1 py-0">
                  <AlertCircle className="h-2.5 w-2.5 mr-0.5" />
                  Off
                </Badge>
              )}
            </div>
            <div
              className={`text-xl font-bold tabular-nums ${isBalanced ? "text-green-600 dark:text-green-400" : "text-destructive"}`}
            >
              {formatAmount(netBalance)}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ── Diagnostics (only when imbalanced) ── */}
      {!isBalanced && (
        <Card data-testid="card-diagnostics">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Wrench className="h-4 w-4 text-amber-500" />
              Potential Issues
              {diagnosticsData?.summary && (
                <div className="flex gap-1.5 ml-1">
                  {diagnosticsData.summary.criticalCount > 0 && (
                    <Badge variant="destructive">{diagnosticsData.summary.criticalCount} Critical</Badge>
                  )}
                  {diagnosticsData.summary.warningCount > 0 && (
                    <Badge variant="outline" className="status-warning">
                      {diagnosticsData.summary.warningCount} Warning
                    </Badge>
                  )}
                </div>
              )}
            </CardTitle>
            <CardDescription>Automatically detected sources of imbalance</CardDescription>
          </CardHeader>
          <CardContent>
            {diagnosticsLoading ? (
              <div className="space-y-3">
                <Skeleton className="h-20" />
                <Skeleton className="h-20" />
              </div>
            ) : issues.length === 0 ? (
              <div className="text-sm text-muted-foreground p-4 bg-muted rounded-md">
                No specific issues detected. Review the component breakdown below to identify the source manually.
              </div>
            ) : (
              <div className="space-y-3">
                {issues.map((issue) => (
                  <div
                    key={issue.id}
                    className={`p-4 rounded-md border ${
                      issue.severity === "critical"
                        ? "border-destructive/40 bg-destructive/5"
                        : issue.severity === "warning"
                          ? "border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30"
                          : "border-border bg-muted/40"
                    }`}
                    data-testid={`issue-${issue.id}`}
                  >
                    <div className="flex items-start gap-3">
                      {issue.severity === "critical" ? (
                        <AlertCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
                      ) : issue.severity === "warning" ? (
                        <AlertTriangle className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
                      ) : (
                        <Info className="h-4 w-4 text-blue-500 mt-0.5 shrink-0" />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="flex flex-wrap items-center gap-2 mb-1">
                          <span className="font-semibold text-sm">{issue.title}</span>
                          {issue.impact > 0 && (
                            <Badge variant="outline" className="text-xs">
                              Impact: {formatAmount(issue.impact)}
                            </Badge>
                          )}
                        </div>
                        <p className="text-sm text-muted-foreground mb-2">{issue.description}</p>
                        <div className="flex items-start gap-1.5 text-xs text-muted-foreground">
                          <Wrench className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                          <span>{issue.howToFix}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── Components breakdown (grouped by category) ── */}
      <Card data-testid="card-components">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Balance Components</CardTitle>
          <CardDescription>All values included in the import cycle formula, grouped by category</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {(["asset", "expense", "liability"] as const).map((cat) => {
            const rows =
              cat === "asset" ? assetComponents : cat === "expense" ? expenseComponents : liabilityComponents;
            const catTotal = cat === "asset" ? assetTotal : cat === "expense" ? expenseTotal : liabilityTotal;
            const meta = CATEGORY_META[cat];
            if (rows.length === 0) return null;
            return (
              <div key={cat} className="border-b last:border-b-0">
                <div className={`px-4 py-2 flex items-center justify-between ${meta.bgClass}`}>
                  <span className={`text-xs font-semibold uppercase tracking-wide ${meta.colorClass}`}>
                    {meta.label}
                  </span>
                  <span className={`text-xs font-mono font-semibold ${meta.colorClass}`}>{formatAmount(catTotal)}</span>
                </div>
                <Table>
                  <TableBody>
                    {rows.map((config) => {
                      const value = components[config.key as keyof typeof components] || 0;
                      return (
                        <TableRow
                          key={config.key}
                          data-testid={`component-row-${config.key}`}
                          className="hover:bg-muted/30"
                        >
                          <TableCell className="w-6 pl-4">
                            {config.sign === "+" ? (
                              <TrendingUp className="h-3.5 w-3.5 text-green-500" />
                            ) : (
                              <TrendingDown className="h-3.5 w-3.5 text-red-500" />
                            )}
                          </TableCell>
                          <TableCell className="text-sm">{config.label}</TableCell>
                          <TableCell className={`text-right font-mono text-sm pr-4 ${meta.colorClass}`}>
                            {formatAmount(value)}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            );
          })}

          {/* Net total row */}
          <div
            className={`px-4 py-3 flex items-center justify-between ${isBalanced ? "bg-green-50 dark:bg-green-950/40" : "bg-destructive/5"}`}
          >
            <span className="text-sm font-bold">Net Import Cycle Balance</span>
            <span
              className={`font-mono font-bold text-sm ${isBalanced ? "text-green-600 dark:text-green-400" : "text-destructive"}`}
            >
              {formatAmount(netBalance)}
            </span>
          </div>
        </CardContent>
      </Card>

      {/* ── Reference values (excluded from formula) ── */}
      {excludedComponents.length > 0 && (
        <Card data-testid="card-excluded">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              Reference Values
              <Badge variant="outline" className="text-xs">
                Not in formula
              </Badge>
            </CardTitle>
            <CardDescription>
              Tracked but excluded from the balance calculation to avoid double-counting
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableBody>
                {excludedComponents.map((config) => {
                  const value = components[config.key as keyof typeof components] || 0;
                  return (
                    <TableRow key={config.key} className="opacity-60" data-testid={`excluded-row-${config.key}`}>
                      <TableCell className="w-6 pl-4">
                        <Minus className="h-3.5 w-3.5 text-muted-foreground" />
                      </TableCell>
                      <TableCell className="text-sm">{config.label}</TableCell>
                      <TableCell className="text-right font-mono text-sm text-muted-foreground pr-4">
                        {formatAmount(value)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* ── Reconciliation ── */}
      {diagnosticsData?.reconciliation && (
        <Card data-testid="card-reconciliation">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              Reconciliation Analysis
              {diagnosticsData.reconciliation.significantVarianceCount > 0 ? (
                <Badge variant="destructive">
                  {diagnosticsData.reconciliation.significantVarianceCount} Variance
                  {diagnosticsData.reconciliation.significantVarianceCount > 1 ? "s" : ""}
                </Badge>
              ) : (
                <Badge variant="outline" className="status-success">
                  All Matched
                </Badge>
              )}
            </CardTitle>
            <CardDescription>Computed totals vs account-level sums</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader className="sticky top-0 z-30 bg-background">
                <TableRow>
                  <TableHead className="pl-4">Bucket</TableHead>
                  <TableHead className="text-right">Computed</TableHead>
                  <TableHead className="text-right">From Accounts</TableHead>
                  <TableHead className="text-right">Variance</TableHead>
                  <TableHead className="text-right pr-4">Accounts</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {diagnosticsData.reconciliation.buckets
                  .filter((b) => b.computed !== 0 || b.fromAccounts !== 0 || b.variance !== 0)
                  .map((bucket) => (
                    <TableRow
                      key={bucket.bucket}
                      className={Math.abs(bucket.variance) > 1 ? "bg-amber-50 dark:bg-amber-950/30" : ""}
                      data-testid={`recon-row-${bucket.bucket}`}
                    >
                      <TableCell className="font-medium text-sm pl-4">{bucket.bucket}</TableCell>
                      <TableCell className="text-right font-mono text-sm">{formatAmount(bucket.computed)}</TableCell>
                      <TableCell className="text-right font-mono text-sm">
                        {formatAmount(bucket.fromAccounts)}
                      </TableCell>
                      <TableCell
                        className={`text-right font-mono text-sm ${Math.abs(bucket.variance) > 1 ? "text-destructive font-bold" : ""}`}
                      >
                        {formatAmount(bucket.variance)}
                      </TableCell>
                      <TableCell className="text-right text-sm pr-4">{bucket.accountsInBucket}</TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>

            {diagnosticsData.reconciliation.uncategorizedAccounts.length > 0 && (
              <div className="p-4 border-t space-y-2">
                <h4 className="text-sm font-semibold flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-amber-500" />
                  Uncategorised Accounts
                </h4>
                {diagnosticsData.reconciliation.uncategorizedAccounts.map((account) => (
                  <div
                    key={account.accountId}
                    className="flex items-center justify-between p-2 bg-muted rounded-md text-sm"
                  >
                    <span className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono text-xs text-muted-foreground">{account.accountCode}</span>
                      <span>{account.accountName}</span>
                      <Badge variant="outline" className="text-xs">
                        {account.parentType}
                      </Badge>
                    </span>
                    <span className={`font-mono ${account.balance < 0 ? "text-red-600" : "text-green-600"}`}>
                      {formatAmount(account.balance)}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {diagnosticsData.reconciliation.componentAudit &&
              diagnosticsData.reconciliation.componentAudit.length > 0 && (
                <div className="border-t">
                  <div className="px-4 py-2 bg-muted/40 flex items-center gap-2">
                    <Database className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm font-semibold">
                      Component Audit ({diagnosticsData.reconciliation.componentAudit.length} components)
                    </span>
                  </div>
                  <Table>
                    <TableHeader className="sticky top-0 z-30 bg-background">
                      <TableRow>
                        <TableHead className="pl-4">Component</TableHead>
                        <TableHead className="text-right">Value</TableHead>
                        <TableHead>Source</TableHead>
                        <TableHead className="text-right">Ledger Sum</TableHead>
                        <TableHead className="text-right pr-4">Variance</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {diagnosticsData.reconciliation.componentAudit.map((comp) => (
                        <TableRow
                          key={comp.key}
                          className={
                            comp.variance && Math.abs(comp.variance) > 0.5 ? "bg-red-50 dark:bg-red-950/30" : ""
                          }
                          data-testid={`audit-row-${comp.key}`}
                        >
                          <TableCell className="font-medium text-sm pl-4">{comp.label}</TableCell>
                          <TableCell className="text-right font-mono text-sm">{formatAmount(comp.value)}</TableCell>
                          <TableCell>
                            <Badge variant={comp.ledgerVerified ? "default" : "outline"} className="text-xs">
                              {comp.source}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm">
                            {comp.ledgerVerified ? formatAmount(comp.ledgerSum || 0) : "N/A"}
                          </TableCell>
                          <TableCell
                            className={`text-right font-mono text-sm pr-4 ${comp.variance && Math.abs(comp.variance) > 0.5 ? "text-destructive font-bold" : ""}`}
                          >
                            {comp.ledgerVerified ? formatAmount(comp.variance || 0) : "—"}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
          </CardContent>
        </Card>
      )}

      {/* ── Container Offload Audit ── */}
      {diagnosticsData?.containerAudit && diagnosticsData.containerAudit.length > 0 && (
        <Card data-testid="container-audit-card">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Package className="h-4 w-4" />
              Container Offload Audit
              {diagnosticsData.containerAudit.filter((c) => c.hasDiscrepancy).length > 0 ? (
                <Badge variant="destructive">
                  {diagnosticsData.containerAudit.filter((c) => c.hasDiscrepancy).length} Discrepanc
                  {diagnosticsData.containerAudit.filter((c) => c.hasDiscrepancy).length > 1 ? "ies" : "y"}
                </Badge>
              ) : (
                <Badge variant="outline" className="status-success">
                  All Balanced
                </Badge>
              )}
            </CardTitle>
            <CardDescription>Voucher debits vs credits per offloaded container</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader className="sticky top-0 z-30 bg-background">
                <TableRow>
                  <TableHead className="pl-4">Container</TableHead>
                  <TableHead>Supplier</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">Debits</TableHead>
                  <TableHead className="text-right">Credits</TableHead>
                  <TableHead className="text-right">Diff</TableHead>
                  <TableHead className="text-right pr-4">Entries</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {diagnosticsData.containerAudit.map((container) => (
                  <TableRow
                    key={container.containerId}
                    className={container.hasDiscrepancy ? "bg-red-50 dark:bg-red-950/30" : ""}
                    data-testid={`container-row-${container.containerId}`}
                  >
                    <TableCell className="font-medium text-sm pl-4">{container.containerNumber}</TableCell>
                    <TableCell className="text-sm">{container.supplierName}</TableCell>
                    <TableCell className="text-right font-mono text-sm">{formatAmount(container.grandTotal)}</TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      {formatAmount(container.voucherDebits)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      {formatAmount(container.voucherCredits)}
                    </TableCell>
                    <TableCell
                      className={`text-right font-mono text-sm ${container.hasDiscrepancy ? "text-destructive font-bold" : ""}`}
                    >
                      {formatAmount(container.difference)}
                    </TableCell>
                    <TableCell className="text-right text-sm pr-4">{container.voucherCount}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            <div className="p-4 border-t flex items-center justify-between">
              <span className="text-sm font-semibold text-muted-foreground">Total Discrepancy</span>
              <span
                className={`font-mono text-sm font-bold ${diagnosticsData.containerAudit.reduce((s, c) => s + c.difference, 0) !== 0 ? "text-destructive" : "text-green-600 dark:text-green-400"}`}
              >
                {formatAmount(diagnosticsData.containerAudit.reduce((s, c) => s + c.difference, 0))}
              </span>
            </div>
            {diagnosticsData.containerAudit.filter((c) => c.hasDiscrepancy).length > 0 && (
              <div className="px-4 pb-4">
                <p className="text-xs text-muted-foreground">
                  Containers in red have unbalanced voucher entries. A positive difference means debits exceed credits;
                  negative means credits exceed debits.
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
