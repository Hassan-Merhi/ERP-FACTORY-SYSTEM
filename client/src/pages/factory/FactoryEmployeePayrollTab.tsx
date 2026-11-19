import { Play, Users, Building2, WalletCards, Loader2, ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { fmt, useFactoryEmployeePayrollTabState } from "./useFactoryEmployeePayrollTabState";
import { EmptyState, ErrorState } from "@/components/ui/page-state";
import { FactoryEmployeePayrollTabDialog } from "./FactoryEmployeePayrollTabDialog";

export default function FactoryEmployeePayrollTab() {
  const {
    refetch,
    isError,
    employeesData,
    amounts,
    deductions,
    employees,
    endDate,
    expandedGroup,
    grouped,
    isLoading,
    loadPreview,
    openPayroll,
    payDate,
    payEffectiveDate,
    payNotes,
    payrollMutation,
    payrollOpen,
    previewLoading,
    previewRows,
    recordChanges,
    setAmounts,
    setDeductions,
    setEndDate,
    setExpandedGroup,
    setPayDate,
    setPayEffectiveDate,
    setPayNotes,
    setPayrollOpen,
    setStartDate,
    startDate,
    totalMonthlyBase,
    totalNet,
  } = useFactoryEmployeePayrollTabState();

  if (isLoading) {
    return (
      <div className="space-y-2">
        {[...Array(5)].map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }
  if (isError && !employeesData) {
    return <ErrorState onAction={() => void refetch()} actionLabel="Try again" />;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-blue-500/15 bg-gradient-to-r from-blue-500/[0.07] via-card to-card px-4 py-4 shadow-sm dark:border-slate-700/80 dark:from-blue-950/40 sm:px-5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-3 text-sm">
          <span className="inline-flex items-center gap-2 text-muted-foreground">
            <Users className="h-4 w-4 text-blue-500 dark:text-sky-400" aria-hidden="true" />
            <strong className="font-semibold text-foreground tabular-nums">{employees.length}</strong> active employees
          </span>
          <span className="hidden h-7 w-px bg-border sm:block" aria-hidden="true" />
          <span className="inline-flex items-center gap-2 text-muted-foreground">
            <WalletCards className="h-4 w-4 text-blue-500 dark:text-sky-400" aria-hidden="true" />
            Base payroll:{" "}
            <strong className="font-semibold text-foreground tabular-nums">{fmt(totalMonthlyBase)}</strong>/mo
          </span>
        </div>
        {recordChanges.allowed && (
          <Button
            onClick={openPayroll}
            disabled={previewLoading}
            data-testid="button-run-payroll"
            className="h-11 rounded-xl bg-gradient-to-r from-blue-600 to-blue-500 px-5 font-semibold text-white shadow-md shadow-blue-500/20 transition-shadow hover:from-blue-700 hover:to-blue-600 hover:shadow-lg hover:shadow-blue-500/25"
          >
            {previewLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
            Run Payroll
          </Button>
        )}
      </div>

      {employees.length === 0 ? (
        <EmptyState icon={Users} title="No active employees found." />
      ) : (
        <div className="space-y-2.5">
          {Object.entries(grouped).map(([dept, emps]) => {
            const deptTotal = emps.reduce((s, e) => s + parseFloat(e.monthlySalary || "0"), 0);
            const isExpanded = expandedGroup === dept;
            return (
              <Card
                key={dept}
                className={`overflow-hidden rounded-2xl border bg-gradient-to-r from-card to-muted/20 shadow-sm transition-colors dark:from-slate-900/80 dark:to-slate-900/45 ${isExpanded ? "border-blue-500/45 ring-1 ring-blue-500/15" : "border-border/80 hover:border-blue-400/35"}`}
              >
                <button
                  type="button"
                  aria-expanded={isExpanded}
                  className="w-full rounded-2xl text-left outline-none transition-colors hover:bg-blue-500/[0.045] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500"
                  onClick={() => setExpandedGroup(isExpanded ? null : dept)}
                  data-testid={`button-toggle-dept-${dept}`}
                >
                  <CardHeader className="flex flex-row items-center justify-between gap-3 px-4 py-4 sm:px-5">
                    <CardTitle className="flex min-w-0 items-center gap-3 text-sm font-semibold sm:text-base">
                      {isExpanded ? (
                        <ChevronDown className="h-4 w-4 shrink-0" />
                      ) : (
                        <ChevronRight className="h-4 w-4 shrink-0" />
                      )}
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-blue-500/15 bg-blue-500/10 text-blue-600 dark:text-sky-300">
                        <Building2 className="h-4 w-4" aria-hidden="true" />
                      </span>
                      <span className="min-w-0 truncate" title={dept}>
                        {dept}
                      </span>
                      <Badge
                        variant="secondary"
                        className="ml-1 border border-border/60 bg-muted/80 px-2.5 py-0.5 font-semibold tabular-nums"
                      >
                        {emps.length}
                      </Badge>
                    </CardTitle>
                    <span className="shrink-0 text-right text-sm font-semibold tabular-nums text-foreground sm:text-base">
                      {fmt(deptTotal)}
                      <span className="ml-0.5 text-xs font-normal text-muted-foreground sm:text-sm">/mo</span>
                    </span>
                  </CardHeader>
                </button>
                {isExpanded && (
                  <CardContent className="border-t border-border/70 bg-background/60 p-0 pb-2">
                    <div className="overflow-x-auto">
                      <Table mobileLayout="cards">
                        <TableHeader className="sticky top-0 z-30 bg-background">
                          <TableRow>
                            <TableHead className="pl-6">Employee</TableHead>
                            <TableHead>Code</TableHead>
                            <TableHead className="text-right">Monthly Salary</TableHead>
                            <TableHead className="text-right">Balance</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {emps.map((emp) => (
                            <TableRow key={emp.id} data-testid={`row-employee-${emp.id}`}>
                              <TableCell className="pl-6 font-medium">
                                {emp.firstName} {emp.lastName}
                              </TableCell>
                              <TableCell className="text-muted-foreground text-sm">{emp.code || "—"}</TableCell>
                              <TableCell className="text-right font-mono">{fmt(emp.monthlySalary)}</TableCell>
                              <TableCell
                                className={`text-right font-mono ${parseFloat(emp.currentBalance) > 0 ? "text-emerald-600 dark:text-emerald-400" : ""}`}
                              >
                                {fmt(emp.currentBalance)}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </CardContent>
                )}
              </Card>
            );
          })}
        </div>
      )}

      <FactoryEmployeePayrollTabDialog
        amounts={amounts}
        deductions={deductions}
        employees={employees}
        endDate={endDate}
        loadPreview={loadPreview}
        payDate={payDate}
        payEffectiveDate={payEffectiveDate}
        payNotes={payNotes}
        payrollMutation={payrollMutation}
        payrollOpen={payrollOpen}
        previewLoading={previewLoading}
        previewRows={previewRows}
        setAmounts={setAmounts}
        setDeductions={setDeductions}
        setEndDate={setEndDate}
        setPayDate={setPayDate}
        setPayEffectiveDate={setPayEffectiveDate}
        setPayNotes={setPayNotes}
        setPayrollOpen={setPayrollOpen}
        setStartDate={setStartDate}
        startDate={startDate}
        totalNet={totalNet}
      />
    </div>
  );
}
