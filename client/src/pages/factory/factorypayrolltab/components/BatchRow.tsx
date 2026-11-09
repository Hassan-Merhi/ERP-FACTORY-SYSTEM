/**
 * BatchRow — payroll batch and worker rows.
 */
import { useState } from "react";
import { CalendarDays, ChevronDown, ChevronRight, RotateCcw, Target, Trash2, Users, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { queryClient } from "@/lib/queryClient";
import { ProductionBonusDecisionPanel } from "../../factorypayroll/ProductionBonusDecisionPanel";
import type { BatchRowProps, PayrollRecord } from "../types";
import { STATUS_CONFIG, fmt, fmtDate } from "../utils";

function pendingProductionBonus(payroll: PayrollRecord): number {
  const value = Number(payroll.pendingProductionBonus ?? 0);
  return Number.isFinite(value) ? value : 0;
}

export function BatchRow({
  group,
  expanded,
  toggleGroup,
  selectedIds,
  setSelectedIds,
  setPayTargetId,
  setPayCashAccountId,
  setPayOpen,
  setFixAcctTargetId,
  setFixAcctCashId,
  setFixAcctOpen,
  setUndoTargetId,
  setDeleteTargetId,
  setDeleteBatchGroup,
  formatDisplayDate,
  condensed,
  isDeveloper,
  canChangeExistingRecords,
}: BatchRowProps) {
  const [bonusPayrollId, setBonusPayrollId] = useState<number | null>(null);
  const isExpanded = expanded.has(group.key);
  const total = group.records.reduce((sum, payroll) => sum + parseFloat(payroll.netSalary || "0"), 0);
  const paidCount = group.records.filter((payroll) => payroll.status === "PAID").length;
  const unpaidCount = group.records.length - paidCount;
  const groupPayable = group.records.filter(
    (payroll) => payroll.status !== "PAID" && pendingProductionBonus(payroll) <= 0
  );
  const allGroupSelected = groupPayable.length > 0 && groupPayable.every((payroll) => selectedIds.has(payroll.id));
  const bonusPayroll = group.records.find((payroll) => payroll.id === bonusPayrollId) ?? null;

  return (
    <div>
      <div
        className={`group flex cursor-pointer items-center gap-3 px-4 py-3.5 transition-colors hover:bg-muted/40 ${isExpanded ? "bg-muted/20" : ""}`}
        onClick={() => toggleGroup(group.key)}
        data-testid={`group-${group.key}`}
      >
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted/70 text-muted-foreground transition-colors group-hover:bg-blue-500/10 group-hover:text-blue-600 dark:group-hover:text-blue-400">
            {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </span>
          <div className="min-w-0">
            <p
              className={`flex flex-wrap items-center gap-2 font-semibold tracking-tight ${condensed ? "text-xs" : "text-sm"}`}
            >
              <CalendarDays className="h-4 w-4 shrink-0 text-muted-foreground" />
              {fmtDate(group.periodStart, formatDisplayDate)} – {fmtDate(group.periodEnd, formatDisplayDate)}
            </p>
            <p className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
              <Users className="h-3.5 w-3.5" />
              {group.records.length} worker{group.records.length !== 1 ? "s" : ""}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2 sm:gap-3">
          <div className="text-right">
            <p className={`font-mono font-bold tabular-nums ${condensed ? "text-xs" : "text-sm"}`}>
              ${total.toFixed(2)}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {paidCount > 0 && (
                <span className="font-medium text-emerald-600 dark:text-emerald-400">{paidCount} paid</span>
              )}
              {paidCount > 0 && unpaidCount > 0 && " · "}
              {unpaidCount > 0 && (
                <span className="font-medium text-amber-600 dark:text-amber-400">{unpaidCount} pending</span>
              )}
            </p>
          </div>
          {canChangeExistingRecords && groupPayable.length > 0 && (
            <Checkbox
              checked={allGroupSelected}
              onCheckedChange={(checked) => {
                setSelectedIds((previous) => {
                  const next = new Set(previous);
                  groupPayable.forEach((payroll) => (checked ? next.add(payroll.id) : next.delete(payroll.id)));
                  return next;
                });
              }}
              onClick={(event) => event.stopPropagation()}
              data-testid={`checkbox-group-${group.key}`}
              aria-label="Select all payable workers in batch"
            />
          )}
          {canChangeExistingRecords && (
            <Button
              size="icon"
              variant="ghost"
              className="h-9 w-9 rounded-lg text-muted-foreground hover:text-destructive"
              onClick={(event) => {
                event.stopPropagation();
                setDeleteBatchGroup(group);
              }}
              data-testid={`button-delete-batch-${group.key}`}
              title="Delete batch — reverses all payments and accounting entries"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {isExpanded && (
        <div className="overflow-x-auto border-t border-border/60 bg-background/50">
          <Table mobileLayout="cards" minimumWidth="76rem" scrollLabel="Payroll batch workers">
            <TableHeader>
              <TableRow className="bg-muted/30 hover:bg-muted/30 dark:bg-white/[0.04] dark:hover:bg-white/[0.04]">
                <TableHead className="h-9 w-10 pl-8 text-xs font-semibold" />
                <TableHead className="h-9 text-xs font-semibold">Worker</TableHead>
                <TableHead className="h-9 text-center text-xs font-semibold">Present</TableHead>
                <TableHead className="h-9 text-center text-xs font-semibold">Absent</TableHead>
                <TableHead className="h-9 text-right text-xs font-semibold">Production Bonus</TableHead>
                <TableHead className="h-9 text-right text-xs font-semibold">Other Bonus</TableHead>
                <TableHead className="h-9 text-right text-xs font-semibold">Deductions</TableHead>
                <TableHead className="h-9 text-right text-xs font-semibold">Advances</TableHead>
                <TableHead className="h-9 text-right text-xs font-semibold">Net</TableHead>
                <TableHead className="h-9 text-xs font-semibold">Status</TableHead>
                <TableHead className="h-9 text-xs font-semibold">Paid On</TableHead>
                <TableHead className="h-9 text-xs" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {group.records.map((payroll) => {
                const cfg = STATUS_CONFIG[payroll.status] || STATUS_CONFIG.DRAFT;
                const pendingBonus = pendingProductionBonus(payroll);
                const canPay = payroll.status !== "PAID" && pendingBonus <= 0;
                const hasProductionBonusActivity =
                  Number(payroll.suggestedProductionBonus || 0) > 0 ||
                  Number(payroll.productionBonus || 0) > 0 ||
                  pendingBonus > 0 ||
                  Number(payroll.rejectedProductionBonus || 0) > 0;
                return (
                  <TableRow
                    key={payroll.id}
                    className="transition-colors hover:bg-muted/30"
                    data-testid={`row-payroll-${payroll.id}`}
                  >
                    <TableCell className="pl-8">
                      {canChangeExistingRecords && canPay && (
                        <Checkbox
                          checked={selectedIds.has(payroll.id)}
                          onCheckedChange={() =>
                            setSelectedIds((previous) => {
                              const next = new Set(previous);
                              if (next.has(payroll.id)) next.delete(payroll.id);
                              else next.add(payroll.id);
                              return next;
                            })
                          }
                          data-testid={`checkbox-payroll-${payroll.id}`}
                        />
                      )}
                    </TableCell>
                    <TableCell>
                      <div>
                        <p className="text-sm font-medium">
                          {payroll.worker?.fullName || `Worker #${payroll.workerId}`}
                        </p>
                        {payroll.worker?.position && (
                          <p className="text-xs text-muted-foreground">{payroll.worker.position}</p>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-center font-mono text-sm" data-testid={`text-present-${payroll.id}`}>
                      {payroll.presentDays != null
                        ? Number(payroll.presentDays) % 1 === 0
                          ? Number(payroll.presentDays).toFixed(0)
                          : payroll.presentDays
                        : "—"}
                    </TableCell>
                    <TableCell className="text-center font-mono text-sm" data-testid={`text-absent-${payroll.id}`}>
                      {payroll.absentDays != null
                        ? Number(payroll.absentDays) % 1 === 0
                          ? Number(payroll.absentDays).toFixed(0)
                          : payroll.absentDays
                        : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="font-mono text-sm font-semibold">${fmt(payroll.productionBonus || "0")}</div>
                      {pendingBonus > 0 && (
                        <button
                          type="button"
                          className="mt-1 text-[11px] font-medium text-amber-600 underline-offset-2 hover:underline dark:text-amber-400"
                          onClick={() => setBonusPayrollId(payroll.id)}
                          data-testid={`button-pending-production-bonus-${payroll.id}`}
                        >
                          +${pendingBonus.toFixed(2)} pending
                        </button>
                      )}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">${fmt(payroll.otherBonuses || "0")}</TableCell>
                    <TableCell className="text-right font-mono text-sm" data-testid={`text-deductions-${payroll.id}`}>
                      {parseFloat(payroll.deductions || "0") > 0 ? (
                        <span className="text-destructive">-${fmt(payroll.deductions)}</span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm" data-testid={`text-advances-${payroll.id}`}>
                      {parseFloat(payroll.advances || "0") > 0 ? (
                        <span className="text-amber-600 dark:text-amber-400">-${fmt(payroll.advances)}</span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm font-semibold">
                      ${fmt(payroll.netSalary)}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary" className={`no-default-active-elevate text-xs ${cfg.className}`}>
                        {cfg.label}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {payroll.paidAt ? fmtDate(payroll.paidAt, formatDisplayDate) : "—"}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        {(hasProductionBonusActivity || payroll.status === "DRAFT") && (
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => setBonusPayrollId(payroll.id)}
                            data-testid={`button-review-production-bonus-${payroll.id}`}
                            title="Review production bonus"
                          >
                            <Target
                              className={`h-4 w-4 ${pendingBonus > 0 ? "text-amber-500" : "text-muted-foreground"}`}
                            />
                          </Button>
                        )}
                        {canChangeExistingRecords && canPay && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setPayTargetId(payroll.id);
                              setPayCashAccountId("");
                              setPayOpen(true);
                            }}
                            data-testid={`button-pay-${payroll.id}`}
                          >
                            Pay
                          </Button>
                        )}
                        {canChangeExistingRecords &&
                          isDeveloper &&
                          (payroll.status === "PAID" || payroll.status === "APPROVED") &&
                          !payroll.cashAccountId && (
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => {
                                setFixAcctTargetId(payroll.id);
                                setFixAcctCashId("");
                                setFixAcctOpen(true);
                              }}
                              data-testid={`button-fix-acct-${payroll.id}`}
                              title="Generate missing accounting entry"
                            >
                              <Wrench className="h-4 w-4 text-amber-500" />
                            </Button>
                          )}
                        {canChangeExistingRecords && (
                          <>
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => setUndoTargetId(payroll.id)}
                              data-testid={`button-undo-payroll-${payroll.id}`}
                              title="Undo — reverses all accounting entries"
                            >
                              <RotateCcw className="h-4 w-4 text-muted-foreground" />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => setDeleteTargetId(payroll.id)}
                              data-testid={`button-delete-payroll-${payroll.id}`}
                              title="Delete payroll — reverse payment and journal entries, then remove the record"
                              aria-label="Delete payroll and reverse accounting"
                            >
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          </>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={bonusPayrollId !== null} onOpenChange={(open) => !open && setBonusPayrollId(null)}>
        <DialogContent
          className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"
          data-testid="dialog-production-bonus-review"
        >
          <DialogHeader>
            <DialogTitle>Production Bonus Review</DialogTitle>
          </DialogHeader>
          {bonusPayroll && (
            <ProductionBonusDecisionPanel
              payrollId={bonusPayroll.id}
              payrollStatus={bonusPayroll.status}
              onChanged={() => queryClient.invalidateQueries({ queryKey: ["/api/factory/payrolls"] })}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
