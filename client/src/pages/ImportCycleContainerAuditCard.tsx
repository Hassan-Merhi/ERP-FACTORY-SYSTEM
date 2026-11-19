// Extracted from ./ImportCycleDiagnostics.tsx
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Package } from "lucide-react";
import type { ImportCycleDiagnosticsModel } from "./ImportCycleDiagnosticsModel";

export function ImportCycleContainerAuditCard({ m }: { m: ImportCycleDiagnosticsModel }) {
  return (
    <>
      {m.diagnosticsData?.containerAudit && m.diagnosticsData.containerAudit.length > 0 && (
        <Card data-testid="container-audit-card">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Package className="h-4 w-4" />
              Container Offload Audit
              {m.diagnosticsData.containerAudit.filter((c) => c.hasDiscrepancy).length > 0 ? (
                <Badge variant="destructive">
                  {m.diagnosticsData.containerAudit.filter((c) => c.hasDiscrepancy).length} Discrepanc
                  {m.diagnosticsData.containerAudit.filter((c) => c.hasDiscrepancy).length > 1 ? "ies" : "y"}
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
                {m.diagnosticsData.containerAudit.map((container) => (
                  <TableRow
                    key={container.containerId}
                    className={container.hasDiscrepancy ? "bg-red-50 dark:bg-red-950/30" : ""}
                    data-testid={`container-row-${container.containerId}`}
                  >
                    <TableCell className="font-medium text-sm pl-4">{container.containerNumber}</TableCell>
                    <TableCell className="text-sm">{container.supplierName}</TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      {m.formatAmount(container.grandTotal)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      {m.formatAmount(container.voucherDebits)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      {m.formatAmount(container.voucherCredits)}
                    </TableCell>
                    <TableCell
                      className={`text-right font-mono text-sm ${container.hasDiscrepancy ? "text-destructive font-bold" : ""}`}
                    >
                      {m.formatAmount(container.difference)}
                    </TableCell>
                    <TableCell className="text-right text-sm pr-4">{container.voucherCount}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            <div className="p-4 border-t flex items-center justify-between">
              <span className="text-sm font-semibold text-muted-foreground">Total Discrepancy</span>
              <span
                className={`font-mono text-sm font-bold ${m.diagnosticsData.containerAudit.reduce((s, c) => s + c.difference, 0) !== 0 ? "text-destructive" : "text-green-600 dark:text-green-400"}`}
              >
                {m.formatAmount(m.diagnosticsData.containerAudit.reduce((s, c) => s + c.difference, 0))}
              </span>
            </div>
            {m.diagnosticsData.containerAudit.filter((c) => c.hasDiscrepancy).length > 0 && (
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
    </>
  );
}
