// Extracted from ./FactoryInsurance.tsx to keep that module under the source-size cap.
import { searchAny } from "@shared/searchNormalization";
import { BookOpen, DollarSign, Loader2, Search, UserCheck, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useFactoryInsuranceState } from "./useFactoryInsuranceState";

export function FactoryInsuranceDialogSection({
  ecAmount,
  ecCrId,
  ecCrOpen,
  ecCrRef,
  ecCrSearch,
  ecDate,
  ecDrId,
  ecDrOpen,
  ecDrRef,
  ecDrSearch,
  ecNotes,
  extraChargesMutation,
  ledgerAccounts,
  setEcAmount,
  setEcCrId,
  setEcCrOpen,
  setEcCrSearch,
  setEcDate,
  setEcDrId,
  setEcDrOpen,
  setEcDrSearch,
  setEcNotes,
  setShowExtraCharges,
  showExtraCharges,
}: Pick<
  ReturnType<typeof useFactoryInsuranceState>,
  | "ecAmount"
  | "ecCrId"
  | "ecCrOpen"
  | "ecCrRef"
  | "ecCrSearch"
  | "ecDate"
  | "ecDrId"
  | "ecDrOpen"
  | "ecDrRef"
  | "ecDrSearch"
  | "ecNotes"
  | "extraChargesMutation"
  | "ledgerAccounts"
  | "setEcAmount"
  | "setEcCrId"
  | "setEcCrOpen"
  | "setEcCrSearch"
  | "setEcDate"
  | "setEcDrId"
  | "setEcDrOpen"
  | "setEcDrSearch"
  | "setEcNotes"
  | "setShowExtraCharges"
  | "showExtraCharges"
>) {
  return (
    <Dialog
      open={showExtraCharges}
      onOpenChange={(v) => {
        if (!v) setShowExtraCharges(false);
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add Extra Charges</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-1">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Date</Label>
              <Input type="date" value={ecDate} onChange={(e) => setEcDate(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Amount</Label>
              <Input
                type="number"
                min="0"
                step="0.01"
                placeholder="0.00"
                value={ecAmount}
                onChange={(e) => setEcAmount(e.target.value)}
              />
            </div>
          </div>
          {/* DR Account */}
          <div className="space-y-1" ref={ecDrRef}>
            <Label>Debit Account (Dr)</Label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
              <Input
                className="pl-8"
                placeholder="Search account name…"
                value={ecDrSearch}
                onFocus={() => setEcDrOpen(true)}
                onChange={(e) => {
                  setEcDrSearch(e.target.value);
                  setEcDrId(null);
                  setEcDrOpen(true);
                }}
              />
              {ecDrOpen && (
                <div className="absolute z-50 mt-1 w-full max-h-48 overflow-y-auto rounded-md border bg-popover shadow-md text-sm">
                  {ledgerAccounts
                    .filter((a) => a.name.toLowerCase().includes(ecDrSearch.toLowerCase()))
                    .slice(0, 60)
                    .map((a) => (
                      <div
                        key={a.id}
                        className="px-3 py-2 cursor-pointer hover:bg-muted"
                        onMouseDown={() => {
                          setEcDrId(a.id);
                          setEcDrSearch(a.name);
                          setEcDrOpen(false);
                        }}
                      >
                        {a.name}
                      </div>
                    ))}
                  {ledgerAccounts.filter((a) => searchAny(ecDrSearch, a.name, a.code)).length === 0 && (
                    <div className="px-3 py-2 text-muted-foreground italic">No accounts found</div>
                  )}
                </div>
              )}
            </div>
          </div>
          {/* CR Account */}
          <div className="space-y-1" ref={ecCrRef}>
            <Label>Credit Account (Cr)</Label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
              <Input
                className="pl-8"
                placeholder="Search account name…"
                value={ecCrSearch}
                onFocus={() => setEcCrOpen(true)}
                onChange={(e) => {
                  setEcCrSearch(e.target.value);
                  setEcCrId(null);
                  setEcCrOpen(true);
                }}
              />
              {ecCrOpen && (
                <div className="absolute z-50 mt-1 w-full max-h-48 overflow-y-auto rounded-md border bg-popover shadow-md text-sm">
                  {ledgerAccounts
                    .filter((a) => a.name.toLowerCase().includes(ecCrSearch.toLowerCase()))
                    .slice(0, 60)
                    .map((a) => (
                      <div
                        key={a.id}
                        className="px-3 py-2 cursor-pointer hover:bg-muted"
                        onMouseDown={() => {
                          setEcCrId(a.id);
                          setEcCrSearch(a.name);
                          setEcCrOpen(false);
                        }}
                      >
                        {a.name}
                      </div>
                    ))}
                  {ledgerAccounts.filter((a) => searchAny(ecCrSearch, a.name, a.code)).length === 0 && (
                    <div className="px-3 py-2 text-muted-foreground italic">No accounts found</div>
                  )}
                </div>
              )}
            </div>
          </div>
          {/* Notes */}
          <div className="space-y-1">
            <Label>
              Notes <span className="text-xs text-muted-foreground">(saved as voucher description)</span>
            </Label>
            <Textarea
              placeholder="e.g. Extra insurance charge — July 2026"
              value={ecNotes}
              onChange={(e) => setEcNotes(e.target.value)}
              rows={2}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setShowExtraCharges(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => extraChargesMutation.mutate()}
            disabled={extraChargesMutation.isPending || !ecDrId || !ecCrId || !ecAmount || ecDrId === ecCrId}
            data-testid="button-extra-charges-submit"
          >
            {extraChargesMutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
            Post Voucher
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function FactoryInsuranceSection({
  insExpenseBalance,
  insuranceExpenseAccount,
  stats,
}: Pick<ReturnType<typeof useFactoryInsuranceState>, "insExpenseBalance" | "insuranceExpenseAccount" | "stats">) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Card className="relative overflow-hidden rounded-2xl border-blue-200 bg-gradient-to-br from-blue-50 via-white to-blue-100/70 shadow-sm dark:border-blue-500/40 dark:from-[hsl(var(--factory-hue)_67%_23%)] dark:via-[hsl(var(--factory-hue)_70%_18%)] dark:to-[hsl(var(--factory-hue)_67%_13%)]">
        <CardContent className="p-5">
          <div className="flex items-center gap-3">
            <Users className="h-10 w-10 shrink-0 rounded-xl bg-blue-500/15 p-2 text-blue-600 dark:bg-blue-400/20 dark:text-sky-300" />
            <span className="text-sm font-medium text-slate-600 dark:text-slate-200">Total Members</span>
          </div>
          <div
            className="mt-2 text-3xl font-bold tracking-tight text-blue-900 dark:text-sky-100"
            data-testid="stat-total"
          >
            {stats.total}
          </div>
        </CardContent>
      </Card>
      <Card className="relative overflow-hidden rounded-2xl border-emerald-200 bg-gradient-to-br from-emerald-50 via-white to-emerald-100/70 shadow-sm dark:border-emerald-500/40 dark:from-[#0e443f] dark:via-[#0c3335] dark:to-[hsl(var(--factory-hue)_62%_11%)]">
        <CardContent className="p-5">
          <div className="flex items-center gap-3">
            <UserCheck className="h-10 w-10 shrink-0 rounded-xl bg-emerald-500/15 p-2 text-emerald-600 dark:bg-emerald-400/20 dark:text-emerald-300" />
            <span className="text-sm font-medium text-slate-600 dark:text-slate-200">Active</span>
          </div>
          <div
            className="mt-2 text-3xl font-bold tracking-tight text-emerald-700 dark:text-emerald-300"
            data-testid="stat-active"
          >
            {stats.active}
          </div>
        </CardContent>
      </Card>
      <Card className="relative overflow-hidden rounded-2xl border-violet-200 bg-gradient-to-br from-violet-50 via-white to-violet-100/70 shadow-sm dark:border-violet-500/40 dark:from-[hsl(var(--factory-hue)_42%_26%)] dark:via-[hsl(var(--factory-hue)_41%_21%)] dark:to-[hsl(var(--factory-hue)_44%_16%)]">
        <CardContent className="p-5">
          <div className="flex items-center gap-3">
            <DollarSign className="h-10 w-10 shrink-0 rounded-xl bg-violet-500/15 p-2 text-violet-600 dark:bg-violet-400/20 dark:text-violet-300" />
            <span className="text-sm font-medium text-slate-600 dark:text-slate-200">Monthly Total</span>
          </div>
          <div
            className="mt-2 text-3xl font-bold tracking-tight text-violet-900 dark:text-violet-100"
            data-testid="stat-amount"
          >
            ${stats.totalAmount % 1 === 0 ? stats.totalAmount.toFixed(0) : stats.totalAmount.toFixed(2)}
          </div>
        </CardContent>
      </Card>
      <Card
        className={`relative overflow-hidden rounded-2xl border-amber-200 bg-gradient-to-br from-amber-50 via-white to-amber-100/70 shadow-sm dark:border-amber-500/40 dark:from-[#573b1d] dark:via-[#3a2b24] dark:to-[hsl(var(--factory-hue)_20%_17%)] ${insuranceExpenseAccount ? "cursor-pointer transition-all hover:ring-2 hover:ring-amber-500/30" : ""}`}
        onClick={() =>
          insuranceExpenseAccount &&
          window.open(`/factory/accounts?accountId=${insuranceExpenseAccount.id}&accountType=ledger`, "_blank")
        }
      >
        <CardContent className="p-5">
          <div className="flex items-center gap-3">
            <BookOpen className="h-10 w-10 shrink-0 rounded-xl bg-amber-500/15 p-2 text-amber-600 dark:bg-amber-400/20 dark:text-amber-300" />
            <span className="text-sm font-medium text-slate-600 dark:text-slate-200">Insurance Expense</span>
          </div>
          <div
            className="mt-2 font-mono text-3xl font-bold tracking-tight text-amber-900 dark:text-amber-100"
            data-testid="stat-expense-balance"
          >
            {insExpenseBalance != null
              ? (() => {
                  const v = Math.abs(insExpenseBalance.balance);
                  return `${v % 1 === 0 ? v.toFixed(0) : v.toFixed(2)}`;
                })()
              : "—"}
          </div>
          {insExpenseBalance != null && (
            <div className="text-xs text-muted-foreground mt-0.5">
              {insExpenseBalance.balance <= 0 ? "Cr balance" : "Dr balance"}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
