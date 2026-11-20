import { Banknote, CheckCircle2, Loader2, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { UnifiedAccountPicker } from "@/components/accounts/UnifiedAccountPicker";
import { useProductionBonusManualPaymentPanelState, type Props } from "./useProductionBonusManualPaymentPanelState";
export type { ManualBonusPayment, ManualBonusHistory } from "./useProductionBonusManualPaymentPanelState";

const money = (amount: number | string) =>
  Number(amount).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

/** Optional manually agreed payout; it does not change the earned bonus calculation. */
export function ProductionBonusManualPaymentPanel({ rosterDate, workers, selected, amounts, onReset }: Props) {
  const {
    recordChanges,
    accountId,
    setAccountId,
    paymentDate,
    setPaymentDate,
    setConfirmOpen,
    confirmOpen,
    setReverseRow,
    reverseRow,
    setReverseReason,
    reverseReason,
    weekStart,
    accountError,
    historyError,
    history,
    accounts,
    chosen,
    allValid,
    total,
    canReview,
    hasExisting,
    post,
    reverse,
  } = useProductionBonusManualPaymentPanelState({ rosterDate, workers, selected, amounts, onReset });
  return (
    <Card className="border-primary/20 bg-card" data-testid="manual-production-bonus-pay">
      <CardContent className="space-y-4 p-4">
        <div className="flex items-center gap-2">
          <Banknote className="h-5 w-5 text-primary" />
          <div>
            <h3 className="font-semibold">Pay the amount you enter</h3>
            <p className="text-xs text-muted-foreground">
              Select a worker's checkbox above, type their USD payment, and choose a Cash/Bank account. One manual bonus
              payment per worker per week. Not an edit to the calculated bonus.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-4 rounded-lg border bg-muted/25 p-3 text-sm">
          <span>
            <strong>{chosen.length}</strong> selected
          </span>
          <span className="font-semibold tabular-nums">{money(total)} to pay</span>
          <span className="text-muted-foreground">Production week: {weekStart}</span>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="space-y-1 text-xs font-medium text-muted-foreground">
            Pay from USD Cash / Bank
            <UnifiedAccountPicker
                options={accounts.map((account) => ({ value: String(account.id), name: account.name }))}
                value={accountId}
                onChange={setAccountId}
                placeholder="Select paying account"
                ariaLabel="Manual bonus paying account"
                className="w-[245px]"
              />
          </label>
          <label className="space-y-1 text-xs font-medium text-muted-foreground">
            Payment date
            <Input
              className="w-[170px]"
              type="date"
              aria-label="Manual bonus payment date"
              value={paymentDate}
              onChange={(event) => setPaymentDate(event.target.value)}
            />
          </label>
          {recordChanges.allowed && (
            <Button disabled={!canReview || hasExisting || post.isPending} onClick={() => setConfirmOpen(true)}>
              <CheckCircle2 className="mr-2 h-4 w-4" /> Review and pay {money(total)}
            </Button>
          )}
        </div>
        {!!chosen.length && !allValid && (
          <p role="alert" className="text-xs text-amber-700 dark:text-amber-400">
            Enter a positive USD amount (maximum $1,000,000) with up to two decimal places for every selected worker.
          </p>
        )}
        {hasExisting && (
          <p role="alert" className="text-xs text-destructive">
            A selected worker was already paid a manual bonus for this week; reverse or reconcile before paying again.
          </p>
        )}
        {accountError && (
          <p role="alert" className="text-xs text-destructive">
            {(accountError as Error).message}
          </p>
        )}
        {historyError && (
          <p role="alert" className="text-xs text-destructive">
            {(historyError as Error).message}
          </p>
        )}
        <details className="hidden rounded-lg border" data-testid="manual-production-bonus-history">
          <summary className="cursor-pointer px-3 py-2 text-sm font-medium">
            Manual payment history ({history?.payments.length ?? 0})
          </summary>
          <div className="max-h-64 space-y-2 overflow-y-auto border-t p-3">
            {!history?.payments.length && (
              <p className="text-xs text-muted-foreground">No manual bonus payments for this week.</p>
            )}
            {history?.payments.map((item) => (
              <div
                key={item.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-background p-2 text-sm"
              >
                <div>
                  <strong dir="auto">{item.workerName}</strong>
                  <p className="text-xs text-muted-foreground">
                    {money(item.amount)} · {item.paymentDate} · Voucher #{item.voucherId}
                    {item.status === "REVERSED" && " · Reversed"}
                  </p>
                </div>
                {recordChanges.allowed && item.status === "POSTED" && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setReverseRow(item);
                      setReverseReason("");
                    }}
                  >
                    <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Reverse
                  </Button>
                )}
              </div>
            ))}
          </div>
        </details>
      </CardContent>
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Confirm manual bonus payment</DialogTitle>
            <DialogDescription>
              This immediately posts a balanced Payment voucher: debit Payroll Deposit Expense, credit your selected
              Cash/Bank account. The manually entered amounts do not alter production bonus calculations.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-64 space-y-2 overflow-y-auto">
            {chosen.map((item) => (
              <div key={item.workerId} className="flex justify-between gap-3 border-b py-2 text-sm">
                <span dir="auto">{item.workerName}</span>
                <strong className="tabular-nums">{money(item.amount)}</strong>
              </div>
            ))}
          </div>
          <div className="flex justify-between font-bold">
            <span>Total</span>
            <span>{money(total)}</span>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button disabled={!canReview || hasExisting || post.isPending} onClick={() => post.mutate()}>
              {post.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />} Post payment
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(reverseRow)}
        onOpenChange={(open) => {
          if (!open) setReverseRow(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reverse manual worker bonus</DialogTitle>
            <DialogDescription>
              Post a reversing Receipt voucher for {reverseRow?.workerName} ({money(reverseRow?.amount ?? 0)}).
            </DialogDescription>
          </DialogHeader>
          <label className="space-y-1 text-sm">
            Reason
            <Input
              value={reverseReason}
              onChange={(event) => setReverseReason(event.target.value)}
              placeholder="Reason for reversing this payment"
            />
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReverseRow(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={
                !reverseReason.trim() ||
                reverse.isPending ||
                Boolean(reverseRow && paymentDate < reverseRow.paymentDate)
              }
              onClick={() => reverse.mutate()}
            >
              Confirm reversal
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
