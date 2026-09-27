/**
 * PayrollDetailDialog — extracted from FactoryWorkerDetail.tsx during the Phase 4 split.
 *
 * Props are the parent-scope bindings the block referenced; they were
 * discovered from compiler errors rather than guessed.
 */
import type { useFactoryWorkerDetailModel } from "../../factoryworkerdetail/useFactoryWorkerDetailModel";

type FactoryWorkerDetailModel = ReturnType<typeof useFactoryWorkerDetailModel>;
import { DollarSign } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { fmtNum } from "../../factoryworkerdetail/utils";

export function PayrollDetailDialog({
  detailPayrollId,
  payrollDetail,
  payrollDetailLoading,
  setDetailPayrollId,
}: {
  detailPayrollId: FactoryWorkerDetailModel["detailPayrollId"];
  payrollDetail: FactoryWorkerDetailModel["payrollDetail"];
  payrollDetailLoading: FactoryWorkerDetailModel["payrollDetailLoading"];
  setDetailPayrollId: FactoryWorkerDetailModel["setDetailPayrollId"];
}) {
  return (
    <Dialog
      open={detailPayrollId !== null}
      onOpenChange={(open) => {
        if (!open) setDetailPayrollId(null);
      }}
    >
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <DollarSign className="h-4 w-4" />
            Payroll Detail
            {payrollDetail && (
              <span className="text-sm font-normal text-muted-foreground ml-1">
                {payrollDetail.payroll.periodStart?.slice(0, 10)} – {payrollDetail.payroll.periodEnd?.slice(0, 10)}
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        {payrollDetailLoading ? (
          <div className="space-y-2 py-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        ) : payrollDetail ? (
          <div className="space-y-5">
            {/* Pay Breakdown */}
            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Pay Breakdown</p>
              <div className="rounded-md border divide-y text-sm">
                {[
                  { label: "Base Salary", value: payrollDetail.payroll.baseSalary, className: "" },
                  {
                    label: "Transport Allowance",
                    value: payrollDetail.payroll.transport || "0",
                    className: "",
                  },
                  {
                    label: "Bonuses",
                    value: payrollDetail.payroll.bonuses,
                    className: "text-green-700 dark:text-green-400",
                  },
                  { label: "Overtime Pay", value: payrollDetail.payroll.overtimePay || "0", className: "" },
                  {
                    label: "Advances Deducted",
                    value: payrollDetail.payroll.advances,
                    className: "text-red-700 dark:text-red-400",
                  },
                  {
                    label: "Other Deductions",
                    value: payrollDetail.payroll.deductions || "0",
                    className: "text-red-700 dark:text-red-400",
                  },
                ].map(({ label, value, className }) => (
                  <div key={label} className="flex justify-between items-center px-3 py-2">
                    <span className="text-muted-foreground">{label}</span>
                    <span className={`font-mono font-medium ${className}`}>${fmtNum(value)}</span>
                  </div>
                ))}
                <div className="flex justify-between items-center px-3 py-2.5 bg-muted/40 font-semibold">
                  <span>Net Salary</span>
                  <span className="font-mono text-base">${fmtNum(payrollDetail.payroll.netSalary)}</span>
                </div>
              </div>
            </div>

            {/* Attendance Summary */}
            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                Attendance Summary
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {[
                  {
                    label: "Present Days",
                    value: parseFloat(payrollDetail.payroll.presentDays || "0"),
                    color: "text-green-700 dark:text-green-400",
                  },
                  {
                    label: "Absent Days",
                    value: parseFloat(payrollDetail.payroll.absentDays || "0"),
                    color: "text-red-700 dark:text-red-400",
                  },
                  { label: "Working Days", value: payrollDetail.payroll.totalWorkingDays || 0, color: "" },
                ].map(({ label, value, color }) => (
                  <Card key={label}>
                    <CardContent className="p-3 text-center">
                      <p className={`text-xl font-bold ${color}`}>{value}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">{label}</p>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>

            {/* Per-day Attendance */}
            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                Daily Attendance
                {payrollDetail.attendance.length > 0 && (
                  <span className="ml-2 normal-case font-normal">({payrollDetail.attendance.length} records)</span>
                )}
              </p>
              {payrollDetail.attendance.length === 0 ? (
                <div className="rounded-md border px-4 py-6 text-center text-sm text-muted-foreground">
                  No attendance records for this period. Salary was calculated by calendar days.
                </div>
              ) : (
                <div className="rounded-md border overflow-hidden">
                  <Table mobileLayout="cards">
                    <TableHeader className="sticky top-0 z-30 bg-background">
                      <TableRow>
                        <TableHead>Date</TableHead>
                        <TableHead>Day</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Shift</TableHead>
                        <TableHead>Notes</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {payrollDetail.attendance.map((att) => {
                        const d = new Date(att.attendanceDate + "T00:00:00");
                        const dayName = d.toLocaleDateString("en-US", { weekday: "short" });
                        const statusColors: Record<string, string> = {
                          Present: "text-green-700 dark:text-green-400",
                          Late: "text-amber-700 dark:text-amber-400",
                          "Half Day": "text-blue-700 dark:text-blue-400",
                          Absent: "text-red-700 dark:text-red-400",
                        };
                        return (
                          <TableRow key={att.id} data-testid={`row-detail-att-${att.id}`}>
                            <TableCell className="text-sm font-mono">{att.attendanceDate}</TableCell>
                            <TableCell className="text-sm text-muted-foreground">{dayName}</TableCell>
                            <TableCell>
                              <span className={`text-sm font-medium ${statusColors[att.status] || ""}`}>
                                {att.status}
                              </span>
                            </TableCell>
                            <TableCell className="text-sm text-muted-foreground">{att.shift || "—"}</TableCell>
                            <TableCell className="text-sm text-muted-foreground">{att.notes || "—"}</TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>

            {/* Extra stats (bales / kg / overtime) */}
            {(Number(payrollDetail.payroll.balesCount ?? 0) > 0 ||
              Number(payrollDetail.payroll.kgProcessed ?? 0) > 0 ||
              Number(payrollDetail.payroll.overtimeHours ?? 0) > 0) && (
              <div>
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Production</p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  {Number(payrollDetail.payroll.balesCount ?? 0) > 0 && (
                    <Card>
                      <CardContent className="p-3 text-center">
                        <p className="text-xl font-bold">{payrollDetail.payroll.balesCount}</p>
                        <p className="text-xs text-muted-foreground">Bales</p>
                      </CardContent>
                    </Card>
                  )}
                  {Number(payrollDetail.payroll.kgProcessed ?? 0) > 0 && (
                    <Card>
                      <CardContent className="p-3 text-center">
                        <p className="text-xl font-bold">{Number(payrollDetail.payroll.kgProcessed ?? 0).toFixed(1)}</p>
                        <p className="text-xs text-muted-foreground">KG</p>
                      </CardContent>
                    </Card>
                  )}
                  {Number(payrollDetail.payroll.overtimeHours ?? 0) > 0 && (
                    <Card>
                      <CardContent className="p-3 text-center">
                        <p className="text-xl font-bold">
                          {Number(payrollDetail.payroll.overtimeHours ?? 0).toFixed(1)}
                        </p>
                        <p className="text-xs text-muted-foreground">OT Hours</p>
                      </CardContent>
                    </Card>
                  )}
                </div>
              </div>
            )}

            {/* Notes */}
            {payrollDetail.payroll.notes && (
              <div className="rounded-md bg-muted/40 px-3 py-2 text-sm">
                <span className="text-muted-foreground text-xs font-medium">Notes: </span>
                {payrollDetail.payroll.notes}
              </div>
            )}
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => setDetailPayrollId(null)} data-testid="button-close-payroll-detail">
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
