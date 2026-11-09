import {
  Play,
  CheckCircle2,
  Clock,
  DollarSign,
  ChevronDown,
  ChevronRight,
  Users,
  CalendarDays,
  ShieldCheck,
  Layers,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { BatchRow } from "./BatchRow";
import type { FactoryPayrollState } from "../useFactoryPayroll";

export function PayrollOverview({ payroll }: { payroll: FactoryPayrollState }) {
  const {
    formatDisplayDate,
    setRunOpen,
    setPayOpen,
    setPayTargetId,
    setPayCashAccountId,
    selectedIds,
    setSelectedIds,
    setBulkPayOpen,
    setUndoTargetId,
    setDeleteTargetId,
    setDeleteBatchGroup,
    showCompletedBatches,
    setShowCompletedBatches,
    projectionPeriod,
    setProjectionPeriod,
    setRepairOpen,
    setRepairResult,
    setFixAcctOpen,
    setFixAcctTargetId,
    setFixAcctCashId,
    expandedGroups,
    isDeveloper,
    payrolls,
    isLoading,
    projectionRows,
    projectionTotal,
    payrollGroups,
    toggleGroup,
    stats,
    activeGroups,
    completedGroups,
    canChangeExistingRecords,
  } = payroll;
  return (
    <>
      {/* Presentation-only metrics: all values still come from the existing payroll model. */}
      <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5" data-testid="payroll-summary">
        {isLoading ? (
          Array.from({ length: 5 }).map((_, index) => <Skeleton key={index} className="h-28 rounded-2xl" />)
        ) : (
          <>
            <div className="flex min-h-28 min-w-0 items-center gap-3 rounded-2xl border border-indigo-200/60 bg-indigo-50/70 p-4 shadow-sm dark:border-indigo-400/20 dark:bg-gradient-to-br dark:from-indigo-500/20 dark:to-slate-950/60">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-indigo-100 text-indigo-600 dark:bg-indigo-400/15 dark:text-indigo-300">
                <Users className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <p className="text-xs font-medium text-muted-foreground">Workers on Payroll</p>
                <p className="mt-1 text-2xl font-bold tracking-tight tabular-nums" data-testid="stat-workers">
                  {stats.uniqueWorkers}
                </p>
              </div>
            </div>

            <div className="flex min-h-28 min-w-0 items-center gap-3 rounded-2xl border border-border/70 bg-card/80 p-4 shadow-sm dark:bg-slate-900/70">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground dark:bg-white/[0.07]">
                <Layers className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <p className="text-xs font-medium text-muted-foreground">Batches</p>
                <p className="mt-1 text-2xl font-bold tracking-tight tabular-nums">{payrollGroups.length}</p>
              </div>
            </div>

            <div className="flex min-h-28 min-w-0 items-center gap-3 rounded-2xl border border-amber-200/70 bg-amber-50/70 p-4 shadow-sm dark:border-amber-400/20 dark:bg-gradient-to-br dark:from-amber-500/15 dark:to-slate-950/60">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-amber-100 text-amber-700 dark:bg-amber-400/15 dark:text-amber-400">
                <Clock className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <p className="text-xs font-medium text-muted-foreground">Pending</p>
                <p
                  className="mt-1 font-mono text-xl font-bold tracking-tight tabular-nums text-amber-700 dark:text-amber-400"
                  data-testid="stat-pending"
                >
                  ${stats.pending.toFixed(2)}
                </p>
              </div>
            </div>

            <div className="flex min-h-28 min-w-0 items-center gap-3 rounded-2xl border border-emerald-200/70 bg-emerald-50/70 p-4 shadow-sm dark:border-emerald-400/20 dark:bg-gradient-to-br dark:from-emerald-500/15 dark:to-slate-950/60">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-100 text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-400">
                <CheckCircle2 className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <p className="text-xs font-medium text-muted-foreground">Total Paid</p>
                <p
                  className="mt-1 font-mono text-xl font-bold tracking-tight tabular-nums text-emerald-700 dark:text-emerald-400"
                  data-testid="stat-paid"
                >
                  ${stats.paid.toFixed(2)}
                </p>
              </div>
            </div>

            <div
              className="flex min-h-28 min-w-0 flex-col justify-center gap-2 rounded-2xl border border-border/70 bg-card/90 p-4 shadow-sm dark:border-blue-400/20 dark:bg-gradient-to-br dark:from-blue-500/10 dark:to-slate-900/80"
              data-testid="stat-projection"
            >
              <div className="flex min-w-0 items-center gap-2">
                <CalendarDays className="h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400" />
                <Select
                  value={projectionPeriod}
                  onValueChange={(v) => setProjectionPeriod(v as typeof projectionPeriod)}
                >
                  <SelectTrigger
                    className="h-8 min-w-0 w-auto max-w-full gap-2 rounded-lg border-border/60 bg-background/70 px-2 text-xs font-semibold shadow-none focus:ring-1"
                    data-testid="select-projection-period"
                    aria-label="Payroll projection period"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="daily">Daily</SelectItem>
                    <SelectItem value="weekly">Weekly</SelectItem>
                    <SelectItem value="biweekly">Bi-weekly</SelectItem>
                    <SelectItem value="monthly">Monthly</SelectItem>
                  </SelectContent>
                </Select>
                <span className="ml-auto text-xs text-muted-foreground">Total</span>
              </div>
              {/* Keep the previous valid amount visible during refetches, never replace it with flashing dots. */}
              <p
                className="min-h-7 truncate font-mono text-xl font-bold tracking-tight tabular-nums text-blue-700 dark:text-blue-300"
                data-testid="stat-projection-total"
                aria-live="polite"
              >
                {projectionRows === undefined
                  ? "—"
                  : `$${projectionTotal.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
              </p>
            </div>
          </>
        )}
      </div>

      {/* Filter / actions row */}
      <div className="flex items-center justify-between flex-wrap gap-3 rounded-xl px-0.5">
        <p className="text-xs text-muted-foreground">
          {payrolls?.length || 0} record{payrolls?.length !== 1 ? "s" : ""} · {payrollGroups.length} batch
          {payrollGroups.length !== 1 ? "es" : ""}
        </p>
        <div className="flex gap-2 flex-wrap">
          {canChangeExistingRecords && selectedIds.size > 0 && (
            <Button variant="outline" onClick={() => setBulkPayOpen(true)} data-testid="button-bulk-pay">
              <DollarSign className="h-4 w-4 mr-2" />
              Pay {selectedIds.size} Selected
            </Button>
          )}
          {canChangeExistingRecords && isDeveloper && (
            <Button
              size="icon"
              variant="ghost"
              onClick={() => {
                setRepairResult(null);
                setRepairOpen(true);
              }}
              data-testid="button-repair-ledger"
              title="Repair Ledger — remove stale entries from undone payrolls"
            >
              <ShieldCheck className="h-4 w-4 text-muted-foreground" />
            </Button>
          )}
          {canChangeExistingRecords && (
            <Button
              className="rounded-xl bg-blue-600 px-5 font-semibold shadow-sm shadow-blue-500/20 hover:bg-blue-700 dark:bg-blue-600 dark:hover:bg-blue-500"
              onClick={() => setRunOpen(true)}
              data-testid="button-run-payroll"
            >
              <Play className="h-4 w-4 mr-2" />
              Run Payroll
            </Button>
          )}
        </div>
      </div>

      {/* Records list */}
      <div className="overflow-hidden rounded-2xl border border-border/70 bg-card/75 shadow-sm dark:border-white/10 dark:bg-slate-950/30">
        {isLoading ? (
          <div className="p-4 space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full rounded-lg" />
            ))}
          </div>
        ) : payrollGroups.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-14 text-center">
            <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center">
              <DollarSign className="h-5 w-5 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium">No payroll records yet</p>
            <p className="text-xs text-muted-foreground">Click "Run Payroll" to generate records for your workers</p>
          </div>
        ) : (
          <div>
            {/* ── Active batches (any pending records) ── */}
            {activeGroups.length === 0 && completedGroups.length > 0 && (
              <div className="text-center py-10 text-muted-foreground text-sm">
                All batches are fully paid — see completed batches below.
              </div>
            )}
            <div className="divide-y divide-border/60">
              {activeGroups.map((group) => (
                <BatchRow
                  key={group.key}
                  group={group}
                  expanded={expandedGroups}
                  toggleGroup={toggleGroup}
                  selectedIds={selectedIds}
                  setSelectedIds={setSelectedIds}
                  setPayTargetId={setPayTargetId}
                  setPayCashAccountId={setPayCashAccountId}
                  setPayOpen={setPayOpen}
                  setFixAcctTargetId={setFixAcctTargetId}
                  setFixAcctCashId={setFixAcctCashId}
                  setFixAcctOpen={setFixAcctOpen}
                  setUndoTargetId={setUndoTargetId}
                  setDeleteTargetId={setDeleteTargetId}
                  setDeleteBatchGroup={setDeleteBatchGroup}
                  formatDisplayDate={formatDisplayDate}
                  isDeveloper={isDeveloper}
                  canChangeExistingRecords={canChangeExistingRecords}
                />
              ))}
            </div>

            {/* ── Completed batches (all paid) ── */}
            {completedGroups.length > 0 && (
              <div className={activeGroups.length > 0 ? "border-t border-border/60" : ""}>
                <button
                  className="flex w-full items-center gap-2 px-4 py-3 text-xs font-semibold text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
                  onClick={() => setShowCompletedBatches((v) => !v)}
                  data-testid="toggle-completed-batches"
                >
                  {showCompletedBatches ? (
                    <ChevronDown className="h-3.5 w-3.5" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5" />
                  )}
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                  {completedGroups.length} completed batch{completedGroups.length !== 1 ? "es" : ""}
                </button>
                {showCompletedBatches && (
                  <div className="divide-y divide-border/60 bg-muted/15">
                    {completedGroups.map((group) => (
                      <BatchRow
                        key={group.key}
                        group={group}
                        expanded={expandedGroups}
                        toggleGroup={toggleGroup}
                        selectedIds={selectedIds}
                        setSelectedIds={setSelectedIds}
                        setPayTargetId={setPayTargetId}
                        setPayCashAccountId={setPayCashAccountId}
                        setPayOpen={setPayOpen}
                        setFixAcctTargetId={setFixAcctTargetId}
                        setFixAcctCashId={setFixAcctCashId}
                        setFixAcctOpen={setFixAcctOpen}
                        setUndoTargetId={setUndoTargetId}
                        setDeleteTargetId={setDeleteTargetId}
                        setDeleteBatchGroup={setDeleteBatchGroup}
                        formatDisplayDate={formatDisplayDate}
                        condensed
                        isDeveloper={isDeveloper}
                        canChangeExistingRecords={canChangeExistingRecords}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
