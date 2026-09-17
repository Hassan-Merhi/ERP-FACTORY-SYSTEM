/**
 * BulkAdvanceDialog — extracted from AdvancesView.tsx during the Phase 4 split.
 *
 * Props are the parent-scope bindings the block referenced; they were
 * discovered from compiler errors rather than guessed.
 */
import { useQuery } from "@tanstack/react-query";
import { Info } from "lucide-react";
import type { useAdvancesModel } from "../advances/useAdvancesModel";

type AdvancesModel = ReturnType<typeof useAdvancesModel>;
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmt } from "../utils";

type AmountDueRecord = Record<
  number,
  {
    periodStart: string;
    periodEnd: string;
    base: number;
    transport: number;
    absenceDays?: number;
    absenceDeducted: number;
    advanceDeducted: number;
    net: number;
    lastPaidThrough: string | null;
  }
>;

export function BulkAdvanceDialog({
  bulkAmounts,
  bulkForm,
  bulkMutation,
  bulkOpen,
  bulkSelected,
  cashAccounts,
  setBulkAmounts,
  setBulkForm,
  setBulkOpen,
  setBulkSelected,
  workers,
}: {
  bulkAmounts: AdvancesModel["bulkAmounts"];
  bulkForm: AdvancesModel["bulkForm"];
  bulkMutation: AdvancesModel["bulkMutation"];
  bulkOpen: AdvancesModel["bulkOpen"];
  bulkSelected: AdvancesModel["bulkSelected"];
  cashAccounts: AdvancesModel["cashAccounts"];
  setBulkAmounts: AdvancesModel["setBulkAmounts"];
  setBulkForm: AdvancesModel["setBulkForm"];
  setBulkOpen: AdvancesModel["setBulkOpen"];
  setBulkSelected: AdvancesModel["setBulkSelected"];
  workers: AdvancesModel["workers"];
}) {
  const { data: amountDue = {} } = useQuery<AmountDueRecord>({
    queryKey: ["/api/factory/workers/amount-due"],
    queryFn: async () => {
      const res = await fetch("/api/factory/workers/amount-due", { credentials: "include" });
      if (!res.ok) return {};
      return res.json();
    },
    enabled: bulkOpen,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });

  const fmtDue = (n: number) =>
    n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtDate = (s: string) =>
    new Date(s + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" });

  return (
    <Dialog
      open={bulkOpen}
      onOpenChange={(open) => {
        if (!open) {
          setBulkOpen(false);
          setBulkAmounts({});
          setBulkSelected(new Set());
        }
      }}
    >
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Bulk Advance</DialogTitle>
          <DialogDescription>Record advances for multiple workers at once</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          {/* Shared fields */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Date</Label>
              <Input
                type="date"
                value={bulkForm.advanceDate}
                onChange={(e) => setBulkForm((p) => ({ ...p, advanceDate: e.target.value }))}
                data-testid="input-bulk-advance-date"
              />
            </div>
            <div className="space-y-2">
              <Label>Cash Account</Label>
              <Select
                value={bulkForm.cashAccountId}
                onValueChange={(v) => setBulkForm((p) => ({ ...p, cashAccountId: v }))}
              >
                <SelectTrigger data-testid="select-bulk-cash-account">
                  <SelectValue placeholder="Optional" />
                </SelectTrigger>
                <SelectContent>
                  {(cashAccounts || []).map((a) => (
                    <SelectItem key={a.id} value={String(a.id)}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Repayment Type</Label>
              <Select
                value={bulkForm.repaymentType}
                onValueChange={(v) => setBulkForm((p) => ({ ...p, repaymentType: v }))}
              >
                <SelectTrigger data-testid="select-bulk-repayment-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="salary_deduction">Deduct from Salary</SelectItem>
                  <SelectItem value="manual_repayment">Manual Repayment (Loan)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Notes</Label>
              <Input
                placeholder="Optional notes for all"
                value={bulkForm.notes}
                onChange={(e) => setBulkForm((p) => ({ ...p, notes: e.target.value }))}
                data-testid="input-bulk-notes"
              />
            </div>
          </div>

          {/* Worker table */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Workers & Amounts</Label>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setBulkSelected(new Set((workers || []).map((w) => w.id)))}
                  data-testid="button-bulk-select-all"
                >
                  Select All
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setBulkSelected(new Set())}
                  data-testid="button-bulk-deselect-all"
                >
                  Clear
                </Button>
              </div>
            </div>
            <div className="border rounded-md overflow-x-auto">
              <Table>
                <TableHeader className="sticky top-0 z-30 bg-background">
                  <TableRow>
                    <TableHead className="w-10"></TableHead>
                    <TableHead>Worker</TableHead>
                    <TableHead className="w-36 text-right">Net Due</TableHead>
                    <TableHead className="w-40">Amount ($)</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(workers || []).length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={4} className="text-center text-muted-foreground py-6">
                        No workers found
                      </TableCell>
                    </TableRow>
                  ) : (
                    (workers || []).map((w) => {
                      const selected = bulkSelected.has(w.id);
                      const due = amountDue[w.id];
                      const absenceDays = due?.absenceDays ?? 0;
                      return (
                        <TableRow
                          key={w.id}
                          className={`cursor-pointer hover-elevate ${selected ? "bg-primary/5" : ""}`}
                          onClick={() =>
                            setBulkSelected((prev) => {
                              const next = new Set(prev);
                              if (next.has(w.id)) next.delete(w.id);
                              else next.add(w.id);
                              return next;
                            })
                          }
                          data-testid={`row-bulk-worker-${w.id}`}
                        >
                          <TableCell onClick={(e) => e.stopPropagation()}>
                            <Checkbox
                              checked={selected}
                              onCheckedChange={() =>
                                setBulkSelected((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(w.id)) next.delete(w.id);
                                  else next.add(w.id);
                                  return next;
                                })
                              }
                              data-testid={`checkbox-bulk-worker-${w.id}`}
                            />
                          </TableCell>
                          <TableCell className="font-medium">{w.fullName}</TableCell>
                          <TableCell className="text-right font-mono text-sm" onClick={(e) => e.stopPropagation()}>
                            {!due ? (
                              <span className="text-muted-foreground/40">—</span>
                            ) : (
                              <Popover>
                                <PopoverTrigger asChild>
                                  <button
                                    className={[
                                      "flex items-center gap-1 ml-auto rounded px-1.5 py-0.5 transition-colors",
                                      "hover:bg-muted/60 cursor-pointer select-none",
                                      due.net > 0
                                        ? "text-emerald-600 dark:text-emerald-400"
                                        : "text-muted-foreground/50",
                                    ].join(" ")}
                                    data-testid={`button-bulk-net-due-${w.id}`}
                                  >
                                    {due.net > 0 ? fmtDue(due.net) : "Paid up"}
                                    <Info className="h-3 w-3 opacity-50 shrink-0" />
                                  </button>
                                </PopoverTrigger>
                                <PopoverContent className="w-64 p-3 text-sm" align="end" side="left">
                                  <p className="font-semibold text-foreground mb-1">Due Today</p>
                                  <p className="text-[11px] text-muted-foreground mb-3 leading-relaxed">
                                    Period: {fmtDate(due.periodStart)} → {fmtDate(due.periodEnd)}
                                    {due.lastPaidThrough && (
                                      <span className="block">Last paid through {fmtDate(due.lastPaidThrough)}</span>
                                    )}
                                  </p>
                                  <div className="space-y-1.5">
                                    <div className="flex justify-between">
                                      <span className="text-muted-foreground">Base salary</span>
                                      <span className="font-mono">{fmtDue(due.base)}</span>
                                    </div>
                                    {due.transport > 0 && (
                                      <div className="flex justify-between">
                                        <span className="text-muted-foreground">Transport</span>
                                        <span className="font-mono">+{fmtDue(due.transport)}</span>
                                      </div>
                                    )}
                                    {(due.absenceDeducted ?? 0) > 0 && (
                                      <div className="flex justify-between text-rose-600 dark:text-rose-400">
                                        <span>
                                          Absences deducted ({absenceDays} {absenceDays === 1 ? "day" : "days"})
                                        </span>
                                        <span className="font-mono">−{fmtDue(due.absenceDeducted)}</span>
                                      </div>
                                    )}
                                    {due.advanceDeducted > 0 && (
                                      <div className="flex justify-between text-amber-600 dark:text-amber-400">
                                        <span>Advance deducted</span>
                                        <span className="font-mono">−{fmtDue(due.advanceDeducted)}</span>
                                      </div>
                                    )}
                                    <div className="flex justify-between border-t pt-1.5 font-semibold">
                                      <span>Net due</span>
                                      <span
                                        className={`font-mono ${
                                          due.net > 0
                                            ? "text-emerald-600 dark:text-emerald-400"
                                            : "text-muted-foreground"
                                        }`}
                                      >
                                        {fmtDue(due.net)}
                                      </span>
                                    </div>
                                  </div>
                                  <p className="text-[10px] text-muted-foreground/50 mt-2 leading-relaxed">
                                    Calendar-day proration · Absences &amp; advances deducted
                                  </p>
                                </PopoverContent>
                              </Popover>
                            )}
                          </TableCell>
                          <TableCell onClick={(e) => e.stopPropagation()}>
                            <Input
                              type="number"
                              min="0"
                              step="0.01"
                              placeholder="0.00"
                              className="h-8 text-sm"
                              value={bulkAmounts[w.id] || ""}
                              onChange={(e) => {
                                const val = e.target.value;
                                setBulkAmounts((prev) => ({ ...prev, [w.id]: val }));
                                if (val && parseFloat(val) > 0) {
                                  setBulkSelected((prev) => {
                                    const n = new Set(prev);
                                    n.add(w.id);
                                    return n;
                                  });
                                }
                              }}
                              data-testid={`input-bulk-amount-${w.id}`}
                            />
                          </TableCell>
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            </div>
            {bulkSelected.size > 0 && (
              <p className="text-xs text-muted-foreground text-right">
                {Array.from(bulkSelected).filter((wid) => parseFloat(bulkAmounts[wid] || "0") > 0).length} worker(s)
                with valid amounts
                {" — "}Total:{" "}
                {fmt(Array.from(bulkSelected).reduce((s: number, wid) => s + parseFloat(bulkAmounts[wid] || "0"), 0))}
              </p>
            )}
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => setBulkOpen(false)} data-testid="button-cancel-bulk-advance">
            Cancel
          </Button>
          <Button
            onClick={() => bulkMutation.mutate()}
            disabled={
              bulkMutation.isPending ||
              Array.from(bulkSelected).filter((wid) => parseFloat(bulkAmounts[wid] || "0") > 0).length === 0
            }
            data-testid="button-submit-bulk-advance"
          >
            {bulkMutation.isPending
              ? "Saving..."
              : `Record ${Array.from(bulkSelected).filter((wid) => parseFloat(bulkAmounts[wid] || "0") > 0).length || ""} Advance(s)`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
