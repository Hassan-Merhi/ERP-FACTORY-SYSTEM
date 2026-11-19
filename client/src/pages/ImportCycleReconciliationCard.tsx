// Extracted from ./ImportCycleDiagnostics.tsx
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AlertTriangle, Database } from "lucide-react";
import type { ImportCycleDiagnosticsModel } from "./ImportCycleDiagnosticsModel";

export function ImportCycleReconciliationCard({ m }: { m: ImportCycleDiagnosticsModel }) {
  return (
    <>
      {m.diagnosticsData?.reconciliation && (
        <Card data-testid="card-reconciliation">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              Reconciliation Analysis
              {m.diagnosticsData.reconciliation.significantVarianceCount > 0 ? (
                <Badge variant="destructive">
                  {m.diagnosticsData.reconciliation.significantVarianceCount} Variance
                  {m.diagnosticsData.reconciliation.significantVarianceCount > 1 ? "s" : ""}
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
                {m.diagnosticsData.reconciliation.buckets
                  .filter((b) => b.computed !== 0 || b.fromAccounts !== 0 || b.variance !== 0)
                  .map((bucket) => (
                    <TableRow
                      key={bucket.bucket}
                      className={Math.abs(bucket.variance) > 1 ? "bg-amber-50 dark:bg-amber-950/30" : ""}
                      data-testid={`recon-row-${bucket.bucket}`}
                    >
                      <TableCell className="font-medium text-sm pl-4">{bucket.bucket}</TableCell>
                      <TableCell className="text-right font-mono text-sm">{m.formatAmount(bucket.computed)}</TableCell>
                      <TableCell className="text-right font-mono text-sm">
                        {m.formatAmount(bucket.fromAccounts)}
                      </TableCell>
                      <TableCell
                        className={`text-right font-mono text-sm ${Math.abs(bucket.variance) > 1 ? "text-destructive font-bold" : ""}`}
                      >
                        {m.formatAmount(bucket.variance)}
                      </TableCell>
                      <TableCell className="text-right text-sm pr-4">{bucket.accountsInBucket}</TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>

            {m.diagnosticsData.reconciliation.uncategorizedAccounts.length > 0 && (
              <div className="p-4 border-t space-y-2">
                <h4 className="text-sm font-semibold flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-amber-500" />
                  Uncategorised Accounts
                </h4>
                {m.diagnosticsData.reconciliation.uncategorizedAccounts.map((account) => (
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
                      {m.formatAmount(account.balance)}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {m.diagnosticsData.reconciliation.componentAudit &&
              m.diagnosticsData.reconciliation.componentAudit.length > 0 && (
                <div className="border-t">
                  <div className="px-4 py-2 bg-muted/40 flex items-center gap-2">
                    <Database className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm font-semibold">
                      Component Audit ({m.diagnosticsData.reconciliation.componentAudit.length} components)
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
                      {m.diagnosticsData.reconciliation.componentAudit.map((comp) => (
                        <TableRow
                          key={comp.key}
                          className={
                            comp.variance && Math.abs(comp.variance) > 0.5 ? "bg-red-50 dark:bg-red-950/30" : ""
                          }
                          data-testid={`audit-row-${comp.key}`}
                        >
                          <TableCell className="font-medium text-sm pl-4">{comp.label}</TableCell>
                          <TableCell className="text-right font-mono text-sm">{m.formatAmount(comp.value)}</TableCell>
                          <TableCell>
                            <Badge variant={comp.ledgerVerified ? "default" : "outline"} className="text-xs">
                              {comp.source}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm">
                            {comp.ledgerVerified ? m.formatAmount(comp.ledgerSum || 0) : "N/A"}
                          </TableCell>
                          <TableCell
                            className={`text-right font-mono text-sm pr-4 ${comp.variance && Math.abs(comp.variance) > 0.5 ? "text-destructive font-bold" : ""}`}
                          >
                            {comp.ledgerVerified ? m.formatAmount(comp.variance || 0) : "—"}
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
    </>
  );
}
