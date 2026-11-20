import { Banknote, Download } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { UnifiedAccountPicker } from "@/components/accounts/UnifiedAccountPicker";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { exportWeeklyBonusPaymentsExcel } from "./weeklyBonusPaymentsExcel";
import {
  ProductionTargetWeeklyBonusPaymentsPanelSection,
  usd,
  useProductionTargetWeeklyBonusPaymentsPanelState,
} from "./useProductionTargetWeeklyBonusPaymentsPanelState";

/** Phase 15 financial surface: one immutable approved worker/week per cash payment. */
export function ProductionTargetWeeklyBonusPaymentsPanel(props: { initialDate: string }) {
  const {
    accountError,
    accountId,
    allSelected,
    audit,
    canPay,
    cashAccounts,
    chosen,
    confirmOpen,
    data,
    end,
    error,
    exporting,
    isLoading,
    payable,
    payment,
    paymentDate,
    reason,
    reconcile,
    recordChanges,
    reversal,
    reversalDate,
    reverseRow,
    rows,
    selected,
    setAccountId,
    setAudit,
    setConfirmOpen,
    setEnd,
    setExporting,
    setPaymentDate,
    setReason,
    setReversalDate,
    setReverseRow,
    setSelected,
    setStart,
    start,
    toast,
    total,
    valid,
  } = useProductionTargetWeeklyBonusPaymentsPanelState(props);
  async function download() {
    if (!data || !rows.length) return;
    setExporting(true);
    try {
      await exportWeeklyBonusPaymentsExcel(rows, start, end);
      toast({ title: "Weekly bonus Excel exported" });
    } catch (error) {
      toast({ title: "Excel export failed", description: (error as Error).message, variant: "destructive" });
    } finally {
      setExporting(false);
    }
  }
  return (
    <Card className="overflow-hidden shadow-none" data-testid="production-weekly-bonus-payments">
      <CardHeader className="border-b bg-muted/20">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Banknote className="h-5 w-5 text-primary" /> Weekly Flat Bonus Payments
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Pay approved weekly flat bonuses from an active USD Cash or Bank account. Every payment debits Payroll Deposit
          Expense, credits the selected account, and creates a Payment voucher plus Factory Daybook entry. Reversed
          bonuses stay locked.
        </p>
      </CardHeader>
      <CardContent className="space-y-4 pt-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="space-y-1 text-xs text-muted-foreground">
            From week (Monday)
            <Input
              type="date"
              aria-label="Weekly bonus from Monday"
              className="w-[168px]"
              value={start}
              onChange={(e) => {
                setStart(e.target.value);
                setSelected([]);
                setAudit(null);
              }}
            />
          </label>
          <label className="space-y-1 text-xs text-muted-foreground">
            To week (Monday)
            <Input
              type="date"
              aria-label="Weekly bonus to Monday"
              className="w-[168px]"
              value={end}
              onChange={(e) => {
                setEnd(e.target.value);
                setSelected([]);
                setAudit(null);
              }}
            />
          </label>
          <label className="space-y-1 text-xs text-muted-foreground">
            Payment date
            <Input
              type="date"
              aria-label="Weekly bonus payment date"
              className="w-[168px]"
              value={paymentDate}
              onChange={(e) => setPaymentDate(e.target.value)}
            />
          </label>
          <label className="min-w-[220px] flex-1 space-y-1 text-xs text-muted-foreground">
            Pay from Cash / Bank (USD)
            <UnifiedAccountPicker
                options={cashAccounts.map((account) => ({ value: String(account.id), name: account.name }))}
                value={accountId}
                onChange={setAccountId}
                placeholder={"Select Cash / Bank account"}
                ariaLabel={"Weekly bonus paying account"}
              />
          </label>
        </div>
        {!valid && (
          <p role="alert" className="text-sm text-destructive">
            Choose Monday start/end weeks, up to one year apart.
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {(error as Error).message}
          </p>
        )}
        {accountError && (
          <p role="alert" className="text-xs text-destructive">
            {(accountError as Error).message}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2 rounded-md border p-3 text-sm">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!payable.length}
            onClick={() => setSelected(allSelected ? [] : payable.map((r) => Number(r.reviewId)))}
          >
            {allSelected ? "Clear selection" : "Select all approved / unpaid"}
          </Button>
          <strong className="ml-auto tabular-nums">
            {chosen.length} selected · {usd(total)}
          </strong>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!data || !rows.length || exporting}
            onClick={() => {
              void download();
            }}
          >
            <Download className="mr-1 h-4 w-4" /> {exporting ? "Exporting…" : "Export Excel"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!valid || reconcile.isPending}
            onClick={() => reconcile.mutate()}
          >
            {reconcile.isPending ? "Checking ledger…" : "Verify accounting"}
          </Button>
          {recordChanges.allowed && (
            <Button type="button" disabled={!canPay || payment.isPending} onClick={() => setConfirmOpen(true)}>
              Review and Post
            </Button>
          )}
        </div>
        <ProductionTargetWeeklyBonusPaymentsPanelSection
          isLoading={isLoading}
          recordChanges={recordChanges}
          rows={rows}
          selected={selected}
          setConfirmOpen={setConfirmOpen}
          setReason={setReason}
          setReversalDate={setReversalDate}
          setReverseRow={setReverseRow}
          setSelected={setSelected}
        />
        {audit && (
          <div className="rounded-md border p-3 text-sm" data-testid="weekly-bonus-reconciliation">
            <p className="font-medium">
              Accounting reconciliation: {audit.passed} passed, {audit.failed} exceptions across {audit.paymentCount}{" "}
              posted/reversed claims.
            </p>
            {audit.paymentCount === 0 && (
              <p className="mt-1 text-xs text-muted-foreground">
                No payments exist in the selected weeks; a zero-claim check does not certify posting.
              </p>
            )}
            {audit.discrepancies.length > 0 && (
              <div className="mt-2 max-h-36 overflow-y-auto text-xs text-destructive">
                {audit.discrepancies.map((x) => (
                  <p key={x.paymentId}>
                    Payment #{x.paymentId} · worker #{x.workerId} · {x.weekStart}: {x.issues.join(", ")}
                  </p>
                ))}
              </div>
            )}
            <p className="mt-1 text-xs text-muted-foreground">
              Read-only validation; anomalies require manual investigation. CI and live database integration tests are
              separate certification requirements.
            </p>
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          Payment is a separate financial confirmation after immutable weekly approval. A reversed worker/week can never
          be automatically paid again.
        </p>
      </CardContent>
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm weekly flat bonus payment</AlertDialogTitle>
            <AlertDialogDescription>
              Pay {chosen.length} approved worker/week bonuses totaling {usd(total)} from{" "}
              {cashAccounts.find((a) => String(a.id) === accountId)?.name ?? "selected account"} on {paymentDate}. Each
              payment creates a balanced voucher: Debit Payroll Deposit Expense / Credit selected Cash or Bank. These
              payments are permanent claims; a reversal will not allow another automatic payout.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="max-h-56 space-y-2 overflow-y-auto rounded-md border p-3 text-sm">
            <p className="font-semibold">Approved weekly calculation</p>
            {chosen.map((r) => (
              <div key={String(r.reviewId)} className="border-t pt-2">
                <p className="font-medium">
                  {r.workerName} · {r.weekStart} – {r.weekEnd}
                </p>
                <p className="text-xs text-muted-foreground">
                  Weekly target {r.targetBales} · credited {r.creditedBales} · extra {r.extraBales}
                </p>
                <p className="text-xs text-muted-foreground">
                  {(r.snapshot?.categories ?? []).map((c) => c.categoryLabel + " " + c.creditedBales).join(" · ")}
                </p>
                <p className="font-semibold">Approved fixed weekly bonus: {usd(r.approvedAmount)}</p>
              </div>
            ))}
          </div>
          <label className="space-y-1 text-sm">
            Pay from Cash / Bank (USD)
            <UnifiedAccountPicker
                options={cashAccounts.map((account) => ({ value: String(account.id), name: account.name }))}
                value={accountId}
                onChange={setAccountId}
                placeholder={"Choose paying account"}
                ariaLabel={"Confirm weekly bonus paying account"}
              />
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={payment.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={!canPay || payment.isPending}
              onClick={(e) => {
                e.preventDefault();
                payment.mutate();
              }}
            >
              {payment.isPending ? "Posting…" : "Approve Payment & Pay"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Dialog
        open={reverseRow !== null}
        onOpenChange={(open) => {
          if (!open) setReverseRow(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reverse weekly bonus payment</DialogTitle>
            <DialogDescription>
              Creates a reversing Receipt voucher; the original claim remains locked.
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm">
            {reverseRow?.workerName} · {reverseRow?.weekStart} · {usd(reverseRow?.approvedAmount ?? "0")}
          </p>
          <label className="space-y-1 text-sm">
            Reversal date
            <Input type="date" value={reversalDate} onChange={(e) => setReversalDate(e.target.value)} />
          </label>
          <label className="space-y-1 text-sm">
            Reason (required)
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Explain the correction"
              maxLength={400}
            />
          </label>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={reversal.isPending} onClick={() => setReverseRow(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={reversal.isPending || !reason.trim() || !reversalDate}
              onClick={() => reversal.mutate()}
            >
              {reversal.isPending ? "Reversing…" : "Confirm Reversal"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
