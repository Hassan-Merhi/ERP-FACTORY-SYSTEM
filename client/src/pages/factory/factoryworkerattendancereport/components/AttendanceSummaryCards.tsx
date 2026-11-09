/**
 * AttendanceSummaryCards — extracted presentational sub-component.
 *
 * Extracted from FactoryWorkerAttendanceReport.tsx during the god-file split.
 */
import { Card, CardContent } from "@/components/ui/card";
import { CalendarCheck2, Coins, HandCoins, UsersRound, Wallet } from "lucide-react";
import { cn } from "@/lib/utils";
import type { WorkerReportRow } from "../types";
import { fmtCurrency } from "../utils";

export type AttendanceSalaryKpi = {
  totalExpected: number;
  totalPaid: number;
  totalRemaining: number;
};

export function AttendanceSummaryCards({
  filteredWorkers,
  overallPct,
  salaryKpi,
}: {
  filteredWorkers: WorkerReportRow[];
  overallPct: number | null;
  salaryKpi: AttendanceSalaryKpi | null;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5 print:grid-cols-5">
      <Card className="relative min-w-0 overflow-hidden rounded-2xl border shadow-sm dark:shadow-[0_12px_25px_rgba(0,0,0,0.22)] print:rounded-none print:border-gray-300 print:bg-white print:bg-none print:shadow-none border-blue-300/70 dark:border-blue-500/60 bg-gradient-to-br from-blue-50 via-blue-50/70 to-white dark:from-[#1a3866] dark:via-[#112848] dark:to-[#0d1b32]">
        <CardContent className="flex min-h-[106px] items-center gap-3 p-4">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl print:hidden bg-blue-100 text-blue-600 dark:bg-blue-500/25 dark:text-blue-300">
            <UsersRound className="h-6 w-6" />
          </div>
          <div className="min-w-0">
            <p className="mb-1 text-xs font-medium text-muted-foreground">Workers</p>
            <p className="text-2xl font-bold tabular-nums tracking-tight" data-testid="stat-total-workers">
              {filteredWorkers.length}
            </p>
            {filteredWorkers.some((worker) => worker.active === false) && (
              <p className="mt-1 text-[10px] text-muted-foreground" data-testid="stat-worker-status-breakdown">
                {filteredWorkers.filter((worker) => worker.active !== false).length} active ·{" "}
                {filteredWorkers.filter((worker) => worker.active === false).length} inactive
              </p>
            )}
          </div>
        </CardContent>
      </Card>
      <Card className="relative min-w-0 overflow-hidden rounded-2xl border shadow-sm dark:shadow-[0_12px_25px_rgba(0,0,0,0.22)] print:rounded-none print:border-gray-300 print:bg-white print:bg-none print:shadow-none border-emerald-300/70 dark:border-emerald-500/60 bg-gradient-to-br from-emerald-50 via-emerald-50/70 to-white dark:from-[#104e44] dark:via-[#0b382f] dark:to-[#0a2527]">
        <CardContent className="flex min-h-[106px] items-center gap-3 p-4">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl print:hidden bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300">
            <CalendarCheck2 className="h-6 w-6" />
          </div>
          <div className="min-w-0">
            <p className="mb-1 text-xs font-medium text-muted-foreground">Attendance Rate</p>
            <p
              className={cn(
                "text-2xl font-bold tabular-nums tracking-tight",
                overallPct === null
                  ? "text-muted-foreground"
                  : overallPct >= 90
                    ? "text-emerald-600 dark:text-emerald-400"
                    : overallPct >= 75
                      ? "text-amber-600 dark:text-amber-400"
                      : "text-red-500 dark:text-red-400"
              )}
              data-testid="stat-attendance-pct"
            >
              {overallPct !== null ? `${overallPct}%` : "—"}
            </p>
          </div>
        </CardContent>
      </Card>
      <Card className="relative min-w-0 overflow-hidden rounded-2xl border shadow-sm dark:shadow-[0_12px_25px_rgba(0,0,0,0.22)] print:rounded-none print:border-gray-300 print:bg-white print:bg-none print:shadow-none border-violet-300/70 dark:border-violet-500/60 bg-gradient-to-br from-violet-50 via-violet-50/70 to-white dark:from-[#403061] dark:via-[#302448] dark:to-[#1b1a38]">
        <CardContent className="flex min-h-[106px] items-center gap-3 p-4">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl print:hidden bg-violet-100 text-violet-700 dark:bg-violet-500/25 dark:text-violet-300">
            <Coins className="h-6 w-6" />
          </div>
          <div className="min-w-0">
            <p className="mb-1 text-xs font-medium text-muted-foreground">Expected Salary</p>
            <p
              className="break-words text-xl font-bold tabular-nums tracking-tight text-foreground"
              data-testid="stat-expected-salary"
            >
              {salaryKpi ? fmtCurrency(salaryKpi.totalExpected) : "—"}
            </p>
          </div>
        </CardContent>
      </Card>
      <Card className="relative min-w-0 overflow-hidden rounded-2xl border shadow-sm dark:shadow-[0_12px_25px_rgba(0,0,0,0.22)] print:rounded-none print:border-gray-300 print:bg-white print:bg-none print:shadow-none border-cyan-300/70 dark:border-cyan-500/60 bg-gradient-to-br from-cyan-50 via-cyan-50/70 to-white dark:from-[#0f4654] dark:via-[#103440] dark:to-[#0b2534]">
        <CardContent className="flex min-h-[106px] items-center gap-3 p-4">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl print:hidden bg-cyan-100 text-cyan-700 dark:bg-cyan-500/20 dark:text-cyan-300">
            <HandCoins className="h-6 w-6" />
          </div>
          <div className="min-w-0">
            <p className="mb-1 text-xs font-medium text-muted-foreground">Paid Salary</p>
            <p
              className="break-words text-xl font-bold tabular-nums tracking-tight text-emerald-600 dark:text-emerald-400"
              data-testid="stat-paid-salary"
            >
              {salaryKpi ? fmtCurrency(salaryKpi.totalPaid) : "—"}
            </p>
          </div>
        </CardContent>
      </Card>
      <Card className="relative min-w-0 overflow-hidden rounded-2xl border shadow-sm dark:shadow-[0_12px_25px_rgba(0,0,0,0.22)] print:rounded-none print:border-gray-300 print:bg-white print:bg-none print:shadow-none border-amber-300/80 dark:border-amber-500/70 bg-gradient-to-br from-amber-50 via-amber-50/70 to-white dark:from-[#54411e] dark:via-[#3c301c] dark:to-[#29241b]">
        <CardContent className="flex min-h-[106px] items-center gap-3 p-4">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl print:hidden bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">
            <Wallet className="h-6 w-6" />
          </div>
          <div className="min-w-0">
            <p className="mb-1 text-xs font-medium text-muted-foreground">Remaining Salary</p>
            <p
              className={cn(
                "break-words text-xl font-bold tabular-nums tracking-tight",
                !salaryKpi
                  ? "text-muted-foreground"
                  : salaryKpi.totalRemaining < 0
                    ? "text-blue-600 dark:text-blue-400"
                    : salaryKpi.totalRemaining === 0
                      ? "text-emerald-600 dark:text-emerald-400"
                      : "text-amber-600 dark:text-amber-400"
              )}
              data-testid="stat-remaining-salary"
            >
              {salaryKpi
                ? salaryKpi.totalRemaining < 0
                  ? `Overpaid ${fmtCurrency(Math.abs(salaryKpi.totalRemaining))}`
                  : fmtCurrency(salaryKpi.totalRemaining)
                : "—"}
            </p>
            {salaryKpi && salaryKpi.totalRemaining < 0 && (
              <p className="text-[11px] text-blue-500 dark:text-blue-400 mt-0.5">Overpaid</p>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
