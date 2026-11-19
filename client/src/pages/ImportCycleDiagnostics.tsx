import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/PageHeader";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import {
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  Info,
  TrendingUp,
  TrendingDown,
  Minus,
  Wrench,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import { componentConfig, CATEGORY_META } from "./importCycleDiagnosticsTypes";
import type { ImportCycleData } from "./importCycleDiagnosticsTypes";
import { useImportCycleDiagnosticsModel } from "./ImportCycleDiagnosticsModel";
import { ImportCycleContainerAuditCard } from "./ImportCycleContainerAuditCard";
import { ImportCycleReconciliationCard } from "./ImportCycleReconciliationCard";

export default function ImportCycleDiagnostics() {
  const m = useImportCycleDiagnosticsModel();

  if (m.isLoading) {
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

  if (m.error) {
    return (
      <div className="p-6">
        <Card className="border-destructive">
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-destructive">
              <AlertCircle className="h-5 w-5" />
              <span>Failed to load data: {(m.error as Error).message}</span>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const netBalance = m.data?.netImportCycleBalance || 0;
  const isBalanced = Math.abs(netBalance) < 0.01;
  const components = m.data?.components || ({} as ImportCycleData["components"]);
  const issues = m.diagnosticsData?.issues || [];

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
        <Button onClick={() => m.refetch()} variant="outline" size="default" data-testid="button-refresh">
          <RefreshCw className="h-4 w-4 mr-1.5" />
          Refresh
        </Button>
        <Button
          onClick={() => m.recalculateMutation.mutate()}
          disabled={m.recalculateMutation.isPending}
          variant="outline"
          data-testid="button-recalculate-equity"
        >
          <RotateCcw className="h-4 w-4 mr-1.5" />
          {m.recalculateMutation.isPending ? "Recalculating…" : "Recalculate Equity"}
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
                <div className={`text-xl font-bold tabular-nums ${meta.colorClass}`}>{m.formatAmount(total)}</div>
              </CardContent>
            </Card>
          );
        })}

        <Card className={isBalanced ? "border-green-500 dark:border-green-600" : "border-destructive"}>
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center gap-1.5 mb-1">
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Net Balance</span>
              {isBalanced ? (
                <Badge variant="outline" className="status-success text-[11px] px-1 py-0">
                  <CheckCircle2 className="h-2.5 w-2.5 mr-0.5" />
                  Balanced
                </Badge>
              ) : (
                <Badge variant="destructive" className="text-[11px] px-1 py-0">
                  <AlertCircle className="h-2.5 w-2.5 mr-0.5" />
                  Off
                </Badge>
              )}
            </div>
            <div
              className={`text-xl font-bold tabular-nums ${isBalanced ? "text-green-600 dark:text-green-400" : "text-destructive"}`}
            >
              {m.formatAmount(netBalance)}
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
              {m.diagnosticsData?.summary && (
                <div className="flex gap-1.5 ml-1">
                  {m.diagnosticsData.summary.criticalCount > 0 && (
                    <Badge variant="destructive">{m.diagnosticsData.summary.criticalCount} Critical</Badge>
                  )}
                  {m.diagnosticsData.summary.warningCount > 0 && (
                    <Badge variant="outline" className="status-warning">
                      {m.diagnosticsData.summary.warningCount} Warning
                    </Badge>
                  )}
                </div>
              )}
            </CardTitle>
            <CardDescription>Automatically detected sources of imbalance</CardDescription>
          </CardHeader>
          <CardContent>
            {m.diagnosticsLoading ? (
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
                              Impact: {m.formatAmount(issue.impact)}
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
                  <span className={`text-xs font-mono font-semibold ${meta.colorClass}`}>
                    {m.formatAmount(catTotal)}
                  </span>
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
                            {m.formatAmount(value)}
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
              {m.formatAmount(netBalance)}
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
                        {m.formatAmount(value)}
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
      <ImportCycleReconciliationCard m={m} />

      {/* ── Container Offload Audit ── */}
      <ImportCycleContainerAuditCard m={m} />
    </div>
  );
}
