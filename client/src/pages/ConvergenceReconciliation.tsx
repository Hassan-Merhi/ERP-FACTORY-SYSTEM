import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, RefreshCw, ShieldAlert } from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

interface ConvergenceDiscrepancy {
  domain: "accounting" | "inventory";
  identity: string;
  code: string;
  expected: string;
  actual: string;
}

interface ConvergenceReport {
  companyId: number;
  accountingSnapshots: number;
  stockSnapshots: number;
  discrepancies: ConvergenceDiscrepancy[];
  clean: boolean;
}

interface RejectedEvidence {
  code: string;
  message: string;
}

/**
 * The convergence report, for the active company.
 *
 * The active company comes from the session on the server; there is no company
 * selector here, because the endpoint takes no companyId and adding one would
 * be the first step towards pointing this at another tenant's books.
 *
 * The reconciler compares what each document claims against the evidence
 * behind it — voucher against ledger entries against the Daybook mirror, stock
 * documents against the canonical movement journal — and reports what
 * disagrees. It never repairs anything, and this screen offers no way to: a
 * discrepancy is a fact to investigate, and a correction belongs in the
 * posting or reversal service that leaves its own evidence.
 *
 * The endpoint fails closed on evidence it cannot trust — a duplicated Daybook
 * mirror, a row that crossed a company boundary — answering 409 rather than a
 * clean report with the bad rows dropped. That case is shown as its own state
 * below, because "we could not trust the evidence" and "everything agrees" must
 * never look alike.
 *
 * That last rule is why the report is gated on `!rejected` and not merely on
 * `data`. A rejected *refresh* leaves the previous successful report in the
 * query cache while setting the error, so rendering on `data` alone would put
 * "Everything agrees" directly underneath "Evidence could not be trusted" — the
 * two states side by side, with the reassuring one describing a reconciliation
 * that no longer holds.
 */
export default function ConvergenceReconciliation() {
  const { data, error, isFetching, refetch } = useQuery<ConvergenceReport>({
    queryKey: ["/api/admin/convergence-reconciliation"],
    retry: false,
    staleTime: 60_000,
  });

  const rejected = readRejectedEvidence(error);
  const discrepancies = data?.discrepancies ?? [];
  const accountingCount = discrepancies.filter((entry) => entry.domain === "accounting").length;
  const inventoryCount = discrepancies.filter((entry) => entry.domain === "inventory").length;

  return (
    <div className="space-y-4 sm:p-4" data-testid="page-convergence-reconciliation">
      <PageHeader title="Convergence Reconciliation" subtitle="Check documents against the evidence behind them">
        <Button variant="outline" onClick={() => refetch()} disabled={isFetching} data-testid="button-refresh">
          <RefreshCw className={`mr-2 h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </PageHeader>

      {rejected && (
        <Card className="border-destructive/40" data-testid="card-evidence-rejected">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-destructive">
              <ShieldAlert className="h-5 w-5" /> Evidence could not be trusted
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p className="text-muted-foreground">
              The reconciliation stopped instead of reporting a result. Nothing below is a clean bill of health.
            </p>
            <p>
              <span className="font-mono text-xs">{rejected.code}</span>
            </p>
            <p>{rejected.message}</p>
          </CardContent>
        </Card>
      )}

      {!rejected && data && (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <Card data-testid="card-status">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm text-muted-foreground">Status</CardTitle>
              </CardHeader>
              <CardContent>
                {data.clean ? (
                  <span className="flex items-center gap-2 font-medium text-emerald-600">
                    <CheckCircle2 className="h-5 w-5" /> Everything agrees
                  </span>
                ) : (
                  <span className="flex items-center gap-2 font-medium text-destructive">
                    <AlertTriangle className="h-5 w-5" />
                    <span>To investigate</span>
                    <span data-testid="text-discrepancy-count">{discrepancies.length}</span>
                  </span>
                )}
              </CardContent>
            </Card>

            <Card data-testid="card-accounting-snapshots">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm text-muted-foreground">Vouchers checked</CardTitle>
              </CardHeader>
              <CardContent className="text-2xl font-semibold">{data.accountingSnapshots}</CardContent>
            </Card>

            <Card data-testid="card-stock-snapshots">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm text-muted-foreground">Stock documents checked</CardTitle>
              </CardHeader>
              <CardContent className="text-2xl font-semibold">{data.stockSnapshots}</CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-3">
                Discrepancies
                {discrepancies.length > 0 && (
                  <>
                    <Badge variant="outline" data-testid="badge-accounting-count">
                      <span>Accounting</span>
                      <span className="ml-1">{accountingCount}</span>
                    </Badge>
                    <Badge variant="outline" data-testid="badge-inventory-count">
                      <span>Inventory</span>
                      <span className="ml-1">{inventoryCount}</span>
                    </Badge>
                  </>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {discrepancies.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground" data-testid="text-no-discrepancies">
                  Every document checked agrees with its evidence.
                </p>
              ) : (
                <Table data-testid="table-discrepancies">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Domain</TableHead>
                      <TableHead>Record</TableHead>
                      <TableHead>Finding</TableHead>
                      <TableHead className="text-right">Expected</TableHead>
                      <TableHead className="text-right">Recorded</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {discrepancies.map((entry) => (
                      <TableRow key={`${entry.identity}:${entry.code}`} data-testid={`row-${entry.identity}`}>
                        <TableCell>
                          <Badge variant={entry.domain === "accounting" ? "default" : "secondary"}>
                            {entry.domain === "accounting" ? "Accounting" : "Inventory"}
                          </Badge>
                        </TableCell>
                        <TableCell className="font-mono text-xs">{entry.identity}</TableCell>
                        <TableCell className="font-mono text-xs">{entry.code}</TableCell>
                        <TableCell className="text-right font-mono text-xs">{entry.expected}</TableCell>
                        <TableCell className="text-right font-mono text-xs">{entry.actual}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <p className="text-xs text-muted-foreground" data-testid="text-read-only-notice">
            This report never changes data.
          </p>
        </>
      )}
    </div>
  );
}

/**
 * The 409 the endpoint answers with when it refuses to trust what it read.
 * Anything else is left to the ordinary error path.
 */
function readRejectedEvidence(error: unknown): RejectedEvidence | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as { status?: number; code?: unknown; message?: unknown };
  if (candidate.status !== 409) return null;

  const code = typeof candidate.code === "string" ? candidate.code : "CONVERGENCE_EVIDENCE_REJECTED";
  const message = typeof candidate.message === "string" ? candidate.message : "";
  return { code, message };
}
