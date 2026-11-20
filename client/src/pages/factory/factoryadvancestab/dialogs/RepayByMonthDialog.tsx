import { UnifiedAccountPicker } from "@/components/accounts/UnifiedAccountPicker";
/**
 * RepayByMonthDialog — extracted from AdvancesView.tsx during the Phase 4 split.
 *
 * Props are the parent-scope bindings the block referenced; they were
 * discovered from compiler errors rather than guessed.
 */
import type { useAdvancesModel } from "../advances/useAdvancesModel";

type AdvancesModel = ReturnType<typeof useAdvancesModel>;
import { Loader2, ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import type { AdvanceRecord } from "../types";
import { fmt } from "../utils";

export function RepayByMonthDialog({
  advances,
  cashAccounts,
  repayByMonthExpanded,
  repayByMonthForm,
  repayByMonthMutation,
  repayByMonthOpen,
  repayingMonth,
  setConfirmRepay,
  setRepayByMonthExpanded,
  setRepayByMonthForm,
  setRepayByMonthOpen,
  setRepayingMonth,
}: {
  advances: AdvancesModel["advances"];
  cashAccounts: AdvancesModel["cashAccounts"];
  repayByMonthExpanded: AdvancesModel["repayByMonthExpanded"];
  repayByMonthForm: AdvancesModel["repayByMonthForm"];
  repayByMonthMutation: AdvancesModel["repayByMonthMutation"];
  repayByMonthOpen: AdvancesModel["repayByMonthOpen"];
  repayingMonth: AdvancesModel["repayingMonth"];
  setConfirmRepay: AdvancesModel["setConfirmRepay"];
  setRepayByMonthExpanded: AdvancesModel["setRepayByMonthExpanded"];
  setRepayByMonthForm: AdvancesModel["setRepayByMonthForm"];
  setRepayByMonthOpen: AdvancesModel["setRepayByMonthOpen"];
  setRepayingMonth: AdvancesModel["setRepayingMonth"];
}) {
  return (
    <Dialog
      open={repayByMonthOpen}
      onOpenChange={(open) => {
        if (!open) {
          setRepayByMonthExpanded(new Set());
          setRepayingMonth(null);
        }
        setRepayByMonthOpen(open);
      }}
    >
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Repay by Month</DialogTitle>
          <DialogDescription>
            Bulk-repay all outstanding advances (Loans and Salary Deductions) grouped by the month they were given.
          </DialogDescription>
        </DialogHeader>

        {/* Shared repayment fields */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 py-2">
          <div className="space-y-2">
            <Label>Repayment Date</Label>
            <Input
              type="date"
              value={repayByMonthForm.repaymentDate}
              onChange={(e) => setRepayByMonthForm((p) => ({ ...p, repaymentDate: e.target.value }))}
              data-testid="input-rbm-repayment-date"
            />
          </div>
          <div className="space-y-2">
            <Label>
              Cash Account <span className="text-destructive">*</span>
            </Label>
            <UnifiedAccountPicker
                options={(cashAccounts || []).map((account) => ({ value: String(account.id), name: account.name }))}
                value={repayByMonthForm.cashAccountId}
                onChange={(v) => setRepayByMonthForm((p) => ({ ...p, cashAccountId: v }))}
                placeholder={"Select cash account"}
                testId={"select-rbm-cash-account"}
              />
          </div>
        </div>

        {/* Month groups derived from advances data */}
        {(() => {
          const allOutstanding = (advances || []).filter((a) => !a.fullyPaid);

          if (allOutstanding.length === 0) {
            return (
              <div className="py-8 text-center text-muted-foreground text-sm">No outstanding advances to repay.</div>
            );
          }

          // Group by YYYY-MM
          const groups = new Map<string, AdvanceRecord[]>();
          for (const a of allOutstanding) {
            const key = (a.advanceDate || "").substring(0, 7);
            if (!key) continue;
            const list = groups.get(key) || [];
            list.push(a);
            groups.set(key, list);
          }

          const sortedKeys = [...groups.keys()].sort().reverse();

          return (
            <div className="space-y-3">
              {sortedKeys.map((monthKey) => {
                const items = groups.get(monthKey)!;
                const total = items.reduce((s, a) => s + parseFloat(a.remainingBalance || "0"), 0);
                const [year, mon] = monthKey.split("-");
                const monthLabel = new Date(parseInt(year), parseInt(mon) - 1, 1).toLocaleString("default", {
                  month: "long",
                  year: "numeric",
                });
                const isExpanded = repayByMonthExpanded.has(monthKey);
                const isPending = repayingMonth === monthKey && repayByMonthMutation.isPending;

                return (
                  <div key={monthKey} className="border rounded-md overflow-hidden">
                    {/* Month header row */}
                    <div
                      className="flex items-center justify-between px-4 py-3 bg-muted/40 cursor-pointer hover-elevate"
                      onClick={() =>
                        setRepayByMonthExpanded((prev) => {
                          const next = new Set(prev);
                          if (next.has(monthKey)) next.delete(monthKey);
                          else next.add(monthKey);
                          return next;
                        })
                      }
                      data-testid={`row-rbm-month-${monthKey}`}
                    >
                      <div className="flex items-center gap-2">
                        {isExpanded ? (
                          <ChevronDown className="h-4 w-4 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="h-4 w-4 text-muted-foreground" />
                        )}
                        <span className="font-semibold">{monthLabel}</span>
                        <Badge variant="outline" className="text-xs">
                          {items.length} advance{items.length !== 1 ? "s" : ""}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="font-mono font-bold text-amber-700 dark:text-amber-400">{fmt(total)}</span>
                        <Button
                          size="sm"
                          disabled={
                            !repayByMonthForm.cashAccountId ||
                            !repayByMonthForm.repaymentDate ||
                            isPending ||
                            repayByMonthMutation.isPending
                          }
                          onClick={(e) => {
                            e.stopPropagation();
                            setConfirmRepay({ monthKey, monthLabel, items, total });
                          }}
                          data-testid={`button-rbm-repay-${monthKey}`}
                        >
                          {isPending ? (
                            <>
                              <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                              Repaying...
                            </>
                          ) : (
                            <>
                              Repay All in{" "}
                              {new Date(parseInt(year), parseInt(mon) - 1, 1).toLocaleString("default", {
                                month: "long",
                              })}
                            </>
                          )}
                        </Button>
                      </div>
                    </div>

                    {/* Expanded worker rows */}
                    {isExpanded && (
                      <div className="divide-y">
                        <div className="grid grid-cols-[1fr_auto_auto] gap-x-4 px-4 py-1 text-xs font-medium text-muted-foreground bg-muted/20">
                          <span>Worker</span>
                          <span className="text-right">Original</span>
                          <span className="text-right">Remaining</span>
                        </div>
                        {items.map((adv) => (
                          <div
                            key={adv.id}
                            className="grid grid-cols-[1fr_auto_auto] gap-x-4 px-4 py-2 text-sm"
                            data-testid={`row-rbm-advance-${adv.id}`}
                          >
                            <span className="font-medium">{adv.workerName}</span>
                            <span className="font-mono text-right text-muted-foreground">{fmt(adv.amount)}</span>
                            <span className="font-mono text-right font-semibold text-amber-700 dark:text-amber-400">
                              {fmt(adv.remainingBalance)}
                            </span>
                          </div>
                        ))}
                        <div className="grid grid-cols-[1fr_auto_auto] gap-x-4 px-4 py-2 text-sm bg-muted/20">
                          <span className="font-semibold text-muted-foreground">Total</span>
                          <span></span>
                          <span className="font-mono text-right font-bold">{fmt(total)}</span>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })()}

        {/* Hint when date or account not set */}
        {(!repayByMonthForm.repaymentDate || !repayByMonthForm.cashAccountId) && (
          <p className="text-xs text-muted-foreground text-center pb-1">
            {!repayByMonthForm.repaymentDate && !repayByMonthForm.cashAccountId
              ? "Set a repayment date and cash account to enable repayment."
              : !repayByMonthForm.repaymentDate
                ? "Set a repayment date to enable repayment."
                : "Select a cash account to enable repayment."}
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => setRepayByMonthOpen(false)} data-testid="button-rbm-close">
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
