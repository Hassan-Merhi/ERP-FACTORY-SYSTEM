import { getErrorDetails } from "@shared/errorUtils";
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/PageHeader";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { apiRequest } from "@/lib/queryClient";
import {
  Loader2,
  AlertTriangle,
  CheckCircle2,
  ScanSearch,
  Wrench,
  Undo2,
  Building2,
  ShieldCheck,
  Link2Off,
  FileX,
} from "lucide-react";
import { IssueBadge, MONTHS, ModuleBadge, fmt, useBalanceRepairState } from "./useBalanceRepairState";

// ── Main ───────────────────────────────────────────────────────────────────
export default function BalanceRepair() {
  const { applied, applyFixes, phase, runScan, scan, setApplied, setPhase, setScan, setSnapshot, snapshot, toast } =
    useBalanceRepairState();

  async function undoFixes() {
    if (!snapshot) return;
    setPhase("undoing");
    try {
      const res = await apiRequest("POST", "/api/admin/repair-balances/undo", { snapshot });
      if (!res.ok) {
        const e = await res.json();
        throw new Error(e.message);
      }
      setSnapshot(null);
      setApplied(null);
      setScan(null);
      setPhase("idle");
      toast({ title: "Undo complete", description: "All changes have been reverted." });
    } catch (e) {
      toast({ title: "Undo failed", description: getErrorDetails(e).message, variant: "destructive" });
      setPhase("applied");
    }
  }

  const busy = ["scanning", "applying", "undoing"].includes(phase);
  const total = scan?.totalDiscrepancies ?? 0;

  return (
    <div className="p-4 md:p-6 max-w-6xl mx-auto space-y-6">
      <PageHeader
        title="Balance Repair Tool"
        subtitle="Scans rent ledger amounts, voucher entries, inter-company transfer integrity, and deposit flags. Fixes drift with full undo support."
      />

      <Alert>
        <AlertTriangle className="h-4 w-4" />
        <AlertDescription>
          This tool checks four areas for the current company: <strong>rent ledger paid amounts</strong>,{" "}
          <strong>missing debit/credit entries on rent vouchers</strong>,{" "}
          <strong>orphaned inter-company transfer sides</strong>, and <strong>tenant guarantee deposit flags</strong>.
          Scan first to preview, then apply to fix.
        </AlertDescription>
      </Alert>

      {/* Actions */}
      <Card>
        <CardHeader>
          <CardTitle>Run Repair Audit</CardTitle>
          <CardDescription>
            Scan first to preview all issues, then apply fixes in one click. An undo snapshot is saved automatically.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          <Button variant="outline" onClick={runScan} disabled={busy} data-testid="button-scan-balances">
            {phase === "scanning" ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <ScanSearch className="mr-2 h-4 w-4" />
            )}
            Scan for Issues
          </Button>
          {phase === "scanned" && total > 0 && (
            <Button onClick={applyFixes} disabled={busy} data-testid="button-apply-fixes">
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Wrench className="mr-2 h-4 w-4" />}
              Apply {total} Fix{total !== 1 ? "es" : ""}
            </Button>
          )}
          {phase === "applied" && snapshot && (
            <Button variant="outline" onClick={undoFixes} disabled={busy} data-testid="button-undo-repair">
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Undo2 className="mr-2 h-4 w-4" />}
              Undo Repair
            </Button>
          )}
        </CardContent>
      </Card>

      {/* Applied summary */}
      {phase === "applied" && applied && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-400" />
              Repair Applied
            </CardTitle>
            <CardDescription>
              {applied.ledger} ledger row{applied.ledger !== 1 ? "s" : ""} &middot; {applied.vouchers} voucher
              {applied.vouchers !== 1 ? "s" : ""} re-posted &middot; {applied.orphans} orphaned transfer
              {applied.orphans !== 1 ? "s" : ""} cleaned &middot; {applied.deposits} deposit flag
              {applied.deposits !== 1 ? "s" : ""} fixed. Click <strong>Undo Repair</strong> to revert all changes.
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      {/* All clear */}
      {phase === "scanned" && scan && total === 0 && (
        <Card>
          <CardContent className="flex items-center gap-3 py-6">
            <CheckCircle2 className="h-6 w-6 text-green-600 dark:text-green-400 shrink-0" />
            <p className="text-sm">All checks passed. No discrepancies detected.</p>
          </CardContent>
        </Card>
      )}

      {/* Section 1: Ledger drift */}
      {phase === "scanned" && scan && scan.ledgerDrifts.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Building2 className="h-5 w-5" />
              Rent Ledger Drift
              <Badge variant="destructive" className="ml-1">
                {scan.ledgerDrifts.length}
              </Badge>
            </CardTitle>
            <CardDescription>
              The stored paid amount on these monthly rows doesn't match the sum of actual payment records. Fix will
              update the stored amount to match.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Module</TableHead>
                  <TableHead>Tenant</TableHead>
                  <TableHead>Unit</TableHead>
                  <TableHead>Period</TableHead>
                  <TableHead className="text-right">Stored Paid</TableHead>
                  <TableHead className="text-right">Actual Paid</TableHead>
                  <TableHead className="text-right">Drift</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {scan.ledgerDrifts.map((d) => (
                  <TableRow key={d.id} data-testid={`row-ledger-drift-${d.id}`}>
                    <TableCell>
                      <ModuleBadge module={d.module} />
                    </TableCell>
                    <TableCell className="font-medium">{d.tenantName}</TableCell>
                    <TableCell className="text-muted-foreground">{d.unitLabel}</TableCell>
                    <TableCell>
                      {MONTHS[d.month - 1]} {d.year}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground font-mono">{fmt(d.storedPaid)}</TableCell>
                    <TableCell className="text-right font-mono">{fmt(d.computedPaid)}</TableCell>
                    <TableCell className="text-right">
                      <Badge variant="destructive">{fmt(d.diff)}</Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Section 2: Missing voucher entries */}
      {phase === "scanned" && scan && scan.voucherEntryMissing.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileX className="h-5 w-5" />
              Missing Debit / Credit Entries
              <Badge variant="destructive" className="ml-1">
                {scan.voucherEntryMissing.length}
              </Badge>
            </CardTitle>
            <CardDescription>
              These rent payments have a voucher linked, but the voucher has no debit/credit entries (or the voucher was
              deleted). Fix will re-post the correct entries and restore the voucher if needed.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Module</TableHead>
                  <TableHead>Tenant</TableHead>
                  <TableHead>Unit</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Cash Account</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Issue</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {scan.voucherEntryMissing.map((d) => (
                  <TableRow key={d.voucherId} data-testid={`row-voucher-missing-${d.voucherId}`}>
                    <TableCell>
                      <ModuleBadge module={d.module} />
                    </TableCell>
                    <TableCell className="font-medium">{d.tenantName}</TableCell>
                    <TableCell className="text-muted-foreground">{d.unitLabel}</TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {d.unitType === "SHOP" ? "Shop (Expense)" : "Warehouse (Income)"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{d.paymentDate}</TableCell>
                    <TableCell className="text-muted-foreground">{d.cashAccountName}</TableCell>
                    <TableCell className="text-right font-mono">{fmt(d.amount)}</TableCell>
                    <TableCell>
                      <IssueBadge issue={d.issue} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Section 3: Orphaned transfer sides */}
      {phase === "scanned" && scan && scan.orphanedTransfers.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Link2Off className="h-5 w-5" />
              Orphaned Transfer Sides
              <Badge variant="destructive" className="ml-1">
                {scan.orphanedTransfers.length}
              </Badge>
            </CardTitle>
            <CardDescription>
              These inter-company transfers have one side that is missing or deleted while the other side still exists.
              Fix will delete the orphaned side and remove the broken transfer link.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>From</TableHead>
                  <TableHead>To</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Broken Side</TableHead>
                  <TableHead>Issue</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {scan.orphanedTransfers.map((d) => (
                  <TableRow key={d.transferId} data-testid={`row-orphan-${d.transferId}`}>
                    <TableCell className="font-medium">{d.fromCompanyName}</TableCell>
                    <TableCell className="font-medium">{d.toCompanyName}</TableCell>
                    <TableCell className="text-muted-foreground text-sm max-w-xs truncate">
                      {d.description || "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{d.transferDate}</TableCell>
                    <TableCell className="text-right font-mono">{fmt(d.amount)}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{d.orphanedSide === "FROM" ? "Source side" : "Destination side"}</Badge>
                    </TableCell>
                    <TableCell>
                      <IssueBadge issue={d.issue} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Section 4: Deposit flag mismatches */}
      {phase === "scanned" && scan && scan.depositFlagMismatches.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5" />
              Guarantee / Deposit Mismatches
              <Badge variant="destructive" className="ml-1">
                {scan.depositFlagMismatches.length}
              </Badge>
            </CardTitle>
            <CardDescription className="space-y-1">
              <span className="block">Three types of issues are detected:</span>
              <span className="block text-amber-600 dark:text-amber-400 font-medium">
                No ledger entry — guarantee shows green in the UI but no accounting voucher exists (posted without a
                cash account). Fix resets the flag so you can re-post it properly with a cash account.
              </span>
              <span className="block">
                Flag not set — a GUAR voucher exists in the ledger but the contract flag is still false. Fix sets the
                flag.
              </span>
              <span className="block">
                Amount mismatch — flag and voucher both exist but the recorded amount on the contract differs from the
                actual voucher. Fix syncs the contract to match the voucher.
              </span>
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Module</TableHead>
                  <TableHead>Tenant</TableHead>
                  <TableHead>Unit</TableHead>
                  <TableHead>Issue</TableHead>
                  <TableHead className="text-right">Contract Amount</TableHead>
                  <TableHead className="text-right">Voucher Amount</TableHead>
                  <TableHead className="text-right">Fix Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {scan.depositFlagMismatches.map((d) => (
                  <TableRow key={d.contractId} data-testid={`row-deposit-${d.contractId}`}>
                    <TableCell>
                      <ModuleBadge module={d.module} />
                    </TableCell>
                    <TableCell className="font-medium">{d.tenantName}</TableCell>
                    <TableCell className="text-muted-foreground">{d.unitLabel}</TableCell>
                    <TableCell>
                      <IssueBadge issue={d.issue} />
                    </TableCell>
                    <TableCell className="text-right font-mono">{fmt(d.guaranteeAmount)}</TableCell>
                    <TableCell className="text-right font-mono text-muted-foreground">
                      {d.issue === "AMOUNT_MISMATCH" ? (
                        fmt(d.voucherAmount ?? 0)
                      ) : d.issue === "STALE_FLAG" ? (
                        <span className="text-destructive">None</span>
                      ) : (
                        fmt(d.guaranteeAmount)
                      )}
                    </TableCell>
                    <TableCell className="text-right text-sm text-muted-foreground">
                      {d.issue === "STALE_FLAG" && (
                        <span className="text-amber-600 dark:text-amber-400 font-medium">
                          Reset to Unposted — re-post required
                        </span>
                      )}
                      {d.issue === "MISSING_FLAG" && (
                        <span className="text-green-600 dark:text-green-400">Set flag to Posted</span>
                      )}
                      {d.issue === "AMOUNT_MISMATCH" && (
                        <span>
                          Sync: {fmt(d.guaranteeAmount)} → {fmt(d.voucherAmount ?? 0)}
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
