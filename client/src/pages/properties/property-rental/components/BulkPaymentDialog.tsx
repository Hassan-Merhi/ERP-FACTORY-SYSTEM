import type { ClientErrorLike } from "@/lib/clientError";
/**
 * BulkPaymentDialog — extracted sub-component.
 *
 * Extracted from PropertyRentalPage.tsx during the Phase 4 god-file split.
 */
import { useState, useMemo } from "react";
import { useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { CreditCard } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import type { CashAccount, Unit } from "../types";
import { fmtMoney, fmtMoneyCurrency } from "../utils";
import { useApiBase } from "../shared";
import { AccountSearchSelect } from "./AccountSearchSelect";

export // ──────────────────────────────────────────────────────────
// BULK PAYMENT DIALOG
// ──────────────────────────────────────────────────────────
function BulkPaymentDialog({
  units,
  cashAccounts,
  testIdPrefix,
  onClose,
  onSuccess,
}: {
  units: Unit[];
  cashAccounts: CashAccount[];
  testIdPrefix: string;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const apiBase = useApiBase();
  const { toast } = useToast();

  const today = new Date().toISOString().slice(0, 10);
  const [paymentDate, setPaymentDate] = useState(today);
  const [scheduleFuturePayment, setScheduleFuturePayment] = useState(false);
  const [cashAccountId, setCashAccountId] = useState("");
  const [notes, setNotes] = useState("");
  // Per-unit amounts, defaulting to their outstanding (min 0)
  const [amounts, setAmounts] = useState<Record<number, string>>(() => {
    const init: Record<number, string> = {};
    units.forEach((u) => {
      const outstanding = u.outstanding ?? 0;
      init[u.contract!.id] = outstanding > 0 ? String(outstanding) : "";
    });
    return init;
  });

  const totalSelected = useMemo(() => {
    return Object.values(amounts).reduce((sum, v) => sum + (parseFloat(v) || 0), 0);
  }, [amounts]);

  const bulkPay = useMutation({
    mutationFn: () => {
      const items = units
        .filter((u) => u.contract && parseFloat(amounts[u.contract.id] || "0") > 0)
        .map((u) => ({
          contractId: u.contract!.id,
          cashAccountId: cashAccountId ? parseInt(cashAccountId) : null,
          amount: amounts[u.contract!.id],
          paymentDate,
          notes: notes || undefined,
          scheduleFuturePayment,
        }));
      if (items.length === 0) throw new Error("No valid amounts entered");
      return apiRequest("POST", apiBase + "/payments/bulk", items);
    },
    onSuccess: (_data) => {
      const isScheduled = paymentDate > new Date().toISOString().slice(0, 10);
      toast({
        title: isScheduled ? "Payments scheduled" : "Bulk payment recorded",
        description: isScheduled
          ? `Payments of ${units.length} tenant(s) scheduled for ${paymentDate}`
          : `${units.length} tenant(s) paid`,
      });
      queryClient.invalidateQueries({ queryKey: [apiBase + "/units"] });
      queryClient.invalidateQueries({ queryKey: [apiBase + "/payments/scheduled"] });
      onSuccess();
      onClose();
    },
    onError: (e: ClientErrorLike) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const canSubmit = Object.values(amounts).some((v) => parseFloat(v) > 0) && !bulkPay.isPending;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col" data-testid={`dialog-${testIdPrefix}-bulk-pay`}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CreditCard className="h-5 w-5" />
            Bulk Payment — {units.length} Unit{units.length !== 1 ? "s" : ""}
          </DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
          <div>
            <Label>Account</Label>
            <AccountSearchSelect
              accounts={cashAccounts}
              value={cashAccountId}
              onChange={setCashAccountId}
              placeholder="Choose account…"
              testId={`select-${testIdPrefix}-bulk-cash`}
            />
          </div>
          <div>
            <Label>Payment Date</Label>
            <Input
              type="date"
              value={paymentDate}
              onChange={(e) => setPaymentDate(e.target.value)}
              data-testid={`input-${testIdPrefix}-bulk-date`}
            />
          </div>
          <div className="sm:col-span-2">
            <Label>Notes (optional)</Label>
            <Input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. May 2026 bulk rent collection"
              data-testid={`input-${testIdPrefix}-bulk-notes`}
            />
          </div>
          {paymentDate > new Date().toISOString().slice(0, 10) && (
            <div className="sm:col-span-2 flex items-center gap-3">
              <Switch
                id={`${testIdPrefix}-bulk-schedule-future`}
                checked={scheduleFuturePayment}
                onCheckedChange={setScheduleFuturePayment}
                data-testid={`switch-${testIdPrefix}-bulk-schedule-future`}
              />
              <label htmlFor={`${testIdPrefix}-bulk-schedule-future`} className="text-sm cursor-pointer select-none">
                Schedule future payments{" "}
                <span className="text-muted-foreground text-xs">(hold as SCHEDULED until {paymentDate})</span>
              </label>
            </div>
          )}
        </div>

        <div className="overflow-auto flex-1 mt-3 rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 border-b sticky top-0">
              <tr>
                <th className="text-left px-3 py-2 font-semibold">Unit</th>
                <th className="text-left px-3 py-2 font-semibold">Tenant</th>
                <th className="text-right px-3 py-2 font-semibold">Monthly Rent</th>
                <th className="text-right px-3 py-2 font-semibold">Outstanding</th>
                <th className="text-right px-3 py-2 font-semibold">Amount to Pay</th>
              </tr>
            </thead>
            <tbody>
              {units.map((u, idx) => {
                const cId = u.contract!.id;
                const outstanding = u.outstanding ?? 0;
                return (
                  <tr key={u.id} className={`border-t ${idx % 2 === 0 ? "" : "bg-muted/30"}`}>
                    <td className="px-3 py-2 font-mono text-xs font-bold">{u.unitNumber}</td>
                    <td className="px-3 py-2">{u.contract!.tenantName}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                      {fmtMoneyCurrency(u.contract!.rentalAmount, u.contract!.currency)}
                    </td>
                    <td
                      className={`px-3 py-2 text-right tabular-nums font-semibold ${
                        outstanding > 0
                          ? "text-red-600 dark:text-red-400"
                          : outstanding < 0
                            ? "text-green-600 dark:text-green-400"
                            : "text-muted-foreground"
                      }`}
                    >
                      {outstanding !== null ? fmtMoneyCurrency(Math.abs(outstanding), u.contract?.currency) : "—"}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Input
                        type="number"
                        step="0.01"
                        min="0"
                        className="w-28 text-right ml-auto"
                        value={amounts[cId] ?? ""}
                        onChange={(e) => setAmounts((prev) => ({ ...prev, [cId]: e.target.value }))}
                        data-testid={`input-${testIdPrefix}-bulk-amount-${u.id}`}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot className="border-t bg-muted/50 sticky bottom-0">
              <tr>
                <td colSpan={4} className="px-3 py-2 font-semibold text-right">
                  Total Payment
                </td>
                <td className="px-3 py-2 text-right font-bold text-lg tabular-nums">${fmtMoney(totalSelected)}</td>
              </tr>
            </tfoot>
          </table>
        </div>

        <DialogFooter className="pt-3">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => bulkPay.mutate()}
            disabled={!canSubmit}
            data-testid={`button-${testIdPrefix}-bulk-pay-confirm`}
          >
            {bulkPay.isPending ? "Processing…" : `Confirm Bulk Payment`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ──────────────────────────────────────────────────────────
// TAB 1: PAYMENT
// ──────────────────────────────────────────────────────────
