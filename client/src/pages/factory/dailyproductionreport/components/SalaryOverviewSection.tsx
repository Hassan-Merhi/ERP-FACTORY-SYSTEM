import { Card, CardContent } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronDown } from "lucide-react";

import { fmtSalary } from "../utils";
import type { DailyProductionReportState } from "../useDailyProductionReport";

export function SalaryOverviewSection({ report }: { report: DailyProductionReportState }) {
  const {
    salaryKpi,
    monthlySalarySummary,
    workerPayrollOpen,
    setWorkerPayrollOpen,
    empPayrollOpen,
    setEmpPayrollOpen,
    preset,
    presets,
    from,
    to,
  } = report;
  return (
    <>
      {/* ── Salary Overview ── */}
      {(() => {
        const ms = monthlySalarySummary;
        const workerTotal = salaryKpi ? salaryKpi.totalExpected : null;
        const workerRemaining = ms && workerTotal !== null ? workerTotal - ms.totalWorkerPaid : null;
        const attSalaryTotal = salaryKpi ? salaryKpi.totalExpected - (ms?.totalWorkerTransport ?? 0) : null;
        const attTransportTotal = ms ? ms.totalWorkerTransport : null;
        // Employee expected: total prorated salary for the period
        const empExpected = ms ? ms.employeeBreakdown.reduce((sum, e) => sum + e.expected, 0) : null;
        const presetLabel =
          presets.find((p) => p.key === preset)?.label ?? (from && to && from !== to ? `${from} → ${to}` : from || "");
        const dayRange = ms ? `Day ${ms.currentDay} / ${ms.daysInMonth}` : "";

        return (
          <div className="production-premium-payroll space-y-2">
            <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground/60 px-0.5">
              Payroll Overview — {presetLabel}
              {dayRange ? ` (${dayRange})` : ""}
            </p>

            {/* One responsive KPI row with four payroll cards. Calculations are unchanged. */}
            <div className="payroll-cards-grid grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
              {/* Combined: Worker Expected + Transport */}
              <Collapsible open={workerPayrollOpen} onOpenChange={setWorkerPayrollOpen}>
                <Card data-testid="card-worker-expected-salary">
                  <CollapsibleTrigger asChild>
                    <div className="py-3 px-4 cursor-pointer select-none" data-testid="trigger-worker-payroll">
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          Workers + Transport
                        </p>
                        <ChevronDown
                          className={`h-3.5 w-3.5 text-muted-foreground shrink-0 transition-transform duration-150 ${workerPayrollOpen ? "rotate-180" : ""}`}
                        />
                      </div>
                      <div className="flex items-baseline gap-3 mt-1 flex-wrap">
                        {workerTotal !== null ? (
                          <p
                            className="text-xl font-bold tabular-nums text-foreground"
                            data-testid="text-worker-expected-salary"
                          >
                            {fmtSalary(workerTotal)}
                          </p>
                        ) : (
                          <p className="text-xl font-bold tabular-nums text-muted-foreground">—</p>
                        )}
                        {workerTotal !== null && ms && ms.currentDay > 0 && (
                          <p className="text-sm font-semibold tabular-nums text-muted-foreground">
                            {fmtSalary(workerTotal / ms.currentDay)}
                            <span className="text-xs font-normal opacity-60 ml-1">/day</span>
                          </p>
                        )}
                      </div>
                      <div className="flex gap-3 mt-0.5 flex-wrap">
                        {attSalaryTotal !== null && (
                          <p className="text-xs text-muted-foreground">
                            {fmtSalary(attSalaryTotal)} <span className="opacity-60">salary</span>
                          </p>
                        )}
                        {attTransportTotal !== null && (
                          <p className="text-xs text-muted-foreground">
                            {fmtSalary(attTransportTotal)} <span className="opacity-60">transport</span>
                          </p>
                        )}
                      </div>
                    </div>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="border-t px-4 pb-3 pt-2 space-y-1">
                      {salaryKpi && salaryKpi.perWorker.length > 0 ? (
                        <>
                          <div className="grid grid-cols-4 gap-1 text-xs font-medium text-muted-foreground mb-1.5 px-0.5">
                            <span>Worker</span>
                            <span className="text-right">Salary</span>
                            <span className="text-right">Transport/d</span>
                            <span className="text-right">Daily</span>
                          </div>
                          {salaryKpi.perWorker.map((w) => {
                            const dailyTransport = ms && ms.daysInMonth > 0 ? w.transport / ms.daysInMonth : 0;
                            const daily = ms && ms.daysInMonth > 0 ? (w.baseSalary + w.transport) / ms.daysInMonth : 0;
                            return (
                              <div key={w.code} className="grid grid-cols-4 gap-1 text-xs py-0.5">
                                <span className="truncate text-foreground/90">{w.name}</span>
                                <span className="text-right tabular-nums text-foreground">
                                  {fmtSalary(w.attendanceSalary)}
                                </span>
                                <span className="text-right tabular-nums text-muted-foreground">
                                  {w.transport > 0 ? fmtSalary(dailyTransport) : <span className="opacity-40">—</span>}
                                </span>
                                <span className="text-right tabular-nums text-sky-600 dark:text-sky-400">
                                  {fmtSalary(daily)}
                                </span>
                              </div>
                            );
                          })}
                          <div className="grid grid-cols-4 gap-1 text-xs pt-1.5 border-t mt-1">
                            <span className="font-medium text-muted-foreground">Total</span>
                            <span className="text-right tabular-nums font-semibold text-foreground">
                              {fmtSalary(attSalaryTotal ?? 0)}
                            </span>
                            <span className="text-right tabular-nums font-semibold text-foreground">
                              {ms && ms.daysInMonth > 0 ? fmtSalary((attTransportTotal ?? 0) / ms.daysInMonth) : "—"}
                            </span>
                            <span className="text-right tabular-nums font-semibold text-sky-600 dark:text-sky-400">
                              {ms && ms.daysInMonth > 0
                                ? fmtSalary((ms.totalWorkerBaseSalary + ms.totalWorkerTransport) / ms.daysInMonth)
                                : "—"}
                            </span>
                          </div>
                        </>
                      ) : (
                        <p className="text-xs text-muted-foreground">No monthly workers found.</p>
                      )}
                    </div>
                  </CollapsibleContent>
                </Card>
              </Collapsible>

              {/* Worker Remaining */}
              <Card className="border-amber-300 dark:border-amber-700" data-testid="card-worker-remaining">
                <CardContent className="py-3 px-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">
                    Worker Remaining
                  </p>
                  {workerRemaining !== null ? (
                    <p
                      className={
                        workerRemaining < 0
                          ? "text-xl font-bold tabular-nums text-blue-600 dark:text-blue-400"
                          : workerRemaining === 0
                            ? "text-xl font-bold tabular-nums text-emerald-600 dark:text-emerald-400"
                            : "text-xl font-bold tabular-nums text-amber-600 dark:text-amber-400"
                      }
                      data-testid="text-worker-remaining"
                    >
                      {workerRemaining < 0
                        ? `Overpaid ${fmtSalary(Math.abs(workerRemaining))}`
                        : fmtSalary(workerRemaining)}
                    </p>
                  ) : (
                    <p className="text-xl font-bold tabular-nums text-muted-foreground">—</p>
                  )}
                  {ms && (
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {fmtSalary(ms.totalWorkerPaid)} <span className="opacity-60">paid this month</span>
                    </p>
                  )}
                </CardContent>
              </Card>

              {/* Total Payroll */}
              <Card data-testid="card-total-payroll">
                <CardContent className="py-3 px-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">
                    Total Payroll
                  </p>
                  {workerTotal !== null && empExpected !== null ? (
                    <>
                      <div className="flex items-baseline gap-3 flex-wrap">
                        <p className="text-xl font-bold tabular-nums text-foreground" data-testid="text-combined-total">
                          {fmtSalary(workerTotal + empExpected)}
                        </p>
                        {ms && ms.currentDay > 0 && ms.daysInMonth > 0 && (
                          <p className="text-sm font-semibold tabular-nums text-muted-foreground">
                            {fmtSalary(workerTotal / ms.currentDay + ms.totalEmployeeMonthlySalary / ms.daysInMonth)}
                            <span className="text-xs font-normal opacity-60 ml-1">/day</span>
                          </p>
                        )}
                      </div>
                      {ms && (
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {fmtSalary(ms.totalEmployeeMonthlySalary)}{" "}
                          <span className="opacity-60">employee monthly</span>
                        </p>
                      )}
                    </>
                  ) : (
                    <p className="text-xl font-bold tabular-nums text-muted-foreground">—</p>
                  )}
                </CardContent>
              </Card>

              {/* Employee Expected — collapsible */}
              <Collapsible open={empPayrollOpen} onOpenChange={setEmpPayrollOpen}>
                <Card data-testid="card-employee-expected-salary">
                  <CollapsibleTrigger asChild>
                    <div className="py-3 px-4 cursor-pointer select-none" data-testid="trigger-employee-payroll">
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          Employee Expected
                        </p>
                        <ChevronDown
                          className={`h-3.5 w-3.5 text-muted-foreground shrink-0 transition-transform duration-150 ${empPayrollOpen ? "rotate-180" : ""}`}
                        />
                      </div>
                      <div className="flex items-baseline gap-3 mt-1 flex-wrap">
                        {empExpected !== null ? (
                          <p
                            className="text-xl font-bold tabular-nums text-foreground"
                            data-testid="text-employee-expected-salary"
                          >
                            {fmtSalary(empExpected)}
                          </p>
                        ) : (
                          <p className="text-xl font-bold tabular-nums text-muted-foreground">—</p>
                        )}
                        {ms && ms.daysInMonth > 0 && (
                          <p className="text-sm font-semibold tabular-nums text-muted-foreground">
                            {fmtSalary(ms.totalEmployeeMonthlySalary / ms.daysInMonth)}
                            <span className="text-xs font-normal opacity-60 ml-1">/day</span>
                          </p>
                        )}
                      </div>
                      {ms && (
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {fmtSalary(ms.totalEmployeeMonthlySalary)} <span className="opacity-60">monthly total</span>
                        </p>
                      )}
                    </div>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="border-t px-4 pb-3 pt-2 space-y-1">
                      {ms?.employeeBreakdown && ms.employeeBreakdown.length > 0 ? (
                        <>
                          <div className="grid grid-cols-3 gap-1 text-xs font-medium text-muted-foreground mb-1.5 px-0.5">
                            <span>Employee</span>
                            <span className="text-right">Expected</span>
                            <span className="text-right">Daily</span>
                          </div>
                          {ms.employeeBreakdown.map((e) => {
                            const daily = ms.daysInMonth > 0 ? e.monthlySalary / ms.daysInMonth : 0;
                            return (
                              <div key={e.id} className="grid grid-cols-3 gap-1 text-xs py-0.5">
                                <span className="truncate text-foreground/90">{e.name}</span>
                                <span className="text-right tabular-nums text-foreground">{fmtSalary(e.expected)}</span>
                                <span className="text-right tabular-nums text-sky-600 dark:text-sky-400">
                                  {fmtSalary(daily)}
                                </span>
                              </div>
                            );
                          })}
                          <div className="grid grid-cols-3 gap-1 text-xs pt-1.5 border-t mt-1">
                            <span className="font-medium text-muted-foreground">Total</span>
                            <span className="text-right tabular-nums font-semibold text-foreground">
                              {fmtSalary(ms.employeeBreakdown.reduce((sum, e) => sum + e.expected, 0))}
                            </span>
                            <span className="text-right tabular-nums font-semibold text-sky-600 dark:text-sky-400">
                              {ms.daysInMonth > 0 ? fmtSalary(ms.totalEmployeeMonthlySalary / ms.daysInMonth) : "—"}
                            </span>
                          </div>
                        </>
                      ) : (
                        <p className="text-xs text-muted-foreground">No employees found.</p>
                      )}
                    </div>
                  </CollapsibleContent>
                </Card>
              </Collapsible>
            </div>
          </div>
        );
      })()}
    </>
  );
}
