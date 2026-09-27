import type { ClientErrorLike } from "@/lib/clientError";
import { useState, useMemo, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { Play, DollarSign, Users, Loader2, ChevronDown, ChevronRight, Minus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";

interface Employee {
  id: number;
  code: string;
  firstName: string;
  lastName: string;
  monthlySalary: string;
  currentBalance: string;
  department: string | null;
  active: boolean;
  employeeType: string;
}

interface PayrollPreview {
  employeeId: number;
  employeeName: string;
  department: string | null;
  monthlySalary: string;
  daysInMonth: number;
  presentDays: number;
  halfDays: number;
  absentDays: number;
  totalMarkedDays: number;
  calculatedPay: string;
  outstandingAdvance: string;
  deduction: string;
  netPay: string;
}

function fmt(val: string | number | null | undefined) {
  const n = parseFloat(String(val || 0));
  return isNaN(n) ? "0.00" : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const today = () => new Date().toLocaleDateString("en-CA");
const currentMonthStart = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
};
const currentMonthEnd = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()).padStart(2, "0")}`;
};

export default function FactoryEmployeePayrollTab() {
  const { toast } = useToast();
  const [payrollOpen, setPayrollOpen] = useState(false);
  const [payDate, setPayDate] = useState(today());
  const [payEffectiveDate, setPayEffectiveDate] = useState("");
  const [startDate, setStartDate] = useState(currentMonthStart());
  const [endDate, setEndDate] = useState(currentMonthEnd());
  const [payNotes, setPayNotes] = useState("");
  const [amounts, setAmounts] = useState<Record<number, string>>({});
  const [deductions, setDeductions] = useState<Record<number, string>>({});
  const [previewRows, setPreviewRows] = useState<Record<number, PayrollPreview>>({});
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);

  const { data: employees = [], isLoading } = useQuery<Employee[]>({
    queryKey: ["/api/factory/employees"],
    queryFn: async () => {
      const res = await fetch("/api/factory/employees", { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      const all = await res.json();
      return all.filter((e: Employee) => e.active);
    },
  });

  const { isLoading: previewLoading, refetch: refetchPreview } = useQuery<{ preview: PayrollPreview[] }>({
    queryKey: ["/api/factory/employee-payroll-preview", startDate, endDate],
    queryFn: async () => {
      const res = await fetch(`/api/factory/employee-payroll-preview?startDate=${startDate}&endDate=${endDate}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to load preview");
      return res.json();
    },
    enabled: false,
  });

  const loadPreview = async () => {
    const { data } = await refetchPreview();
    const preview = data?.preview || [];
    const initialAmounts: Record<number, string> = {};
    const initialDeductions: Record<number, string> = {};
    const rows: Record<number, PayrollPreview> = {};
    for (const p of preview) {
      rows[p.employeeId] = p;
      const pay = parseFloat(p.calculatedPay);
      const ded = parseFloat(p.deduction);
      initialAmounts[p.employeeId] = pay > 0 ? pay.toFixed(2) : "";
      initialDeductions[p.employeeId] = ded > 0 ? ded.toFixed(2) : "";
    }
    setPreviewRows(rows);
    setAmounts(initialAmounts);
    setDeductions(initialDeductions);
  };

  const openPayroll = async () => {
    await loadPreview();
    setPayrollOpen(true);
  };

  const getNet = useCallback(
    (empId: number) => {
      const sal = parseFloat(amounts[empId] || "0") || 0;
      const ded = parseFloat(deductions[empId] || "0") || 0;
      return Math.max(0, sal - ded);
    },
    [amounts, deductions]
  );

  const totalNet = useMemo(() => employees.reduce((s, e) => s + getNet(e.id), 0), [employees, getNet]);

  const payrollMutation = useMutation({
    mutationFn: async () => {
      const deposits = employees
        .map((e) => ({
          employeeId: e.id,
          amount: parseFloat(amounts[e.id] || "0") || 0,
          deduction: parseFloat(deductions[e.id] || "0") || 0,
        }))
        .filter((d) => d.amount > 0 || d.deduction > 0);
      if (deposits.length === 0) throw new Error("No amounts entered");
      const res = await fetch("/api/factory/employees/bulk-payroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          deposits,
          date: payDate,
          notes: payNotes || null,
          effectiveDate: payEffectiveDate || null,
        }),
      });
      if (!res.ok) {
        const e = await res.json();
        throw new Error(e.message);
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Payroll run complete", description: `Total paid: ${fmt(totalNet)}` });
      setPayrollOpen(false);
      setAmounts({});
      setDeductions({});
      setPayNotes("");
      setPayEffectiveDate("");
      queryClient.invalidateQueries({ queryKey: ["/api/factory/employees"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/employee-advances"] });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const grouped = useMemo(() => {
    const map: Record<string, Employee[]> = {};
    for (const e of employees) {
      const dept = e.department || "No Department";
      if (!map[dept]) map[dept] = [];
      map[dept].push(e);
    }
    return map;
  }, [employees]);

  const totalMonthlyBase = useMemo(
    () => employees.reduce((s, e) => s + parseFloat(e.monthlySalary || "0"), 0),
    [employees]
  );

  if (isLoading) {
    return (
      <div className="space-y-2">
        {[...Array(5)].map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3 items-center justify-between">
        <div className="flex gap-4 text-sm text-muted-foreground">
          <span>{employees.length} active employees</span>
          <span>
            Base payroll: <strong className="text-foreground">{fmt(totalMonthlyBase)}</strong>/mo
          </span>
        </div>
        <Button onClick={openPayroll} disabled={previewLoading} data-testid="button-run-payroll">
          {previewLoading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Play className="h-4 w-4 mr-2" />}
          Run Payroll
        </Button>
      </div>

      {employees.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <Users className="h-10 w-10 mx-auto mb-3 opacity-40" />
            <p>No active employees found.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {Object.entries(grouped).map(([dept, emps]) => {
            const deptTotal = emps.reduce((s, e) => s + parseFloat(e.monthlySalary || "0"), 0);
            const isExpanded = expandedGroup === dept;
            return (
              <Card key={dept}>
                <button
                  className="w-full text-left"
                  onClick={() => setExpandedGroup(isExpanded ? null : dept)}
                  data-testid={`button-toggle-dept-${dept}`}
                >
                  <CardHeader className="p-3 flex flex-row items-center justify-between gap-2">
                    <CardTitle className="text-sm font-medium flex items-center gap-2">
                      {isExpanded ? (
                        <ChevronDown className="h-4 w-4 shrink-0" />
                      ) : (
                        <ChevronRight className="h-4 w-4 shrink-0" />
                      )}
                      {dept}
                      <Badge variant="secondary" className="ml-1">
                        {emps.length}
                      </Badge>
                    </CardTitle>
                    <span className="text-sm font-mono text-muted-foreground">{fmt(deptTotal)}/mo</span>
                  </CardHeader>
                </button>
                {isExpanded && (
                  <CardContent className="p-0 pb-2">
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

      <Dialog open={payrollOpen} onOpenChange={setPayrollOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Run Employee Payroll</DialogTitle>
            <DialogDescription>
              Salary is auto-calculated from attendance. You can edit any values before paying.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-[1fr_1fr_1fr_auto] gap-3 items-end">
              <div>
                <Label>Period Start</Label>
                <Input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  data-testid="input-payroll-start"
                />
              </div>
              <div>
                <Label>Period End</Label>
                <Input
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  data-testid="input-payroll-end"
                />
              </div>
              <div>
                <Label>Payment Date</Label>
                <Input
                  type="date"
                  value={payDate}
                  onChange={(e) => setPayDate(e.target.value)}
                  data-testid="input-payroll-date"
                />
              </div>
              <Button
                variant="outline"
                onClick={loadPreview}
                disabled={previewLoading}
                data-testid="button-recalculate-payroll"
                title="Recalculate salaries for selected period"
              >
                {previewLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              </Button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>
                  Effective Date <span className="text-muted-foreground">(optional)</span>
                </Label>
                <Input
                  type="date"
                  value={payEffectiveDate}
                  onChange={(e) => setPayEffectiveDate(e.target.value)}
                  data-testid="input-payroll-effective-date"
                />
              </div>
              <div>
                <Label>Notes</Label>
                <Input
                  placeholder="e.g. March 2026..."
                  value={payNotes}
                  onChange={(e) => setPayNotes(e.target.value)}
                  data-testid="input-payroll-notes"
                />
              </div>
            </div>

            {/* Column headers */}
            <div className="grid grid-cols-[1fr_80px_80px_80px_24px_80px_80px] gap-x-2 items-center px-3 pb-1 text-xs text-muted-foreground font-medium border-b">
              <span>Employee</span>
              <span className="text-right">Days</span>
              <span className="text-right">Salary</span>
              <span className="text-right">Advance</span>
              <span />
              <span className="text-right">Deduct</span>
              <span className="text-right">Net</span>
            </div>

            <div className="rounded-md border divide-y">
              {employees.map((emp) => {
                const p = previewRows[emp.id];
                const sal = parseFloat(amounts[emp.id] || "0") || 0;
                const ded = parseFloat(deductions[emp.id] || "0") || 0;
                const net = Math.max(0, sal - ded);
                return (
                  <div
                    key={emp.id}
                    className="grid grid-cols-[1fr_80px_80px_80px_24px_80px_80px] gap-x-2 items-center px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">
                        {emp.firstName} {emp.lastName}
                      </p>
                      <p className="text-xs text-muted-foreground">{emp.code || emp.department || ""}</p>
                    </div>
                    <div className="text-right text-xs text-muted-foreground">
                      {p ? (
                        <span title={`Effective: ${p.presentDays}, Half: ${p.halfDays}, Absent: ${p.absentDays}`}>
                          {`${p.presentDays}/${p.daysInMonth}`}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </div>
                    <Input
                      type="number"
                      className="w-20 text-right text-sm"
                      placeholder="0.00"
                      value={amounts[emp.id] || ""}
                      onChange={(e) => setAmounts((a) => ({ ...a, [emp.id]: e.target.value }))}
                      data-testid={`input-payroll-amount-${emp.id}`}
                    />
                    <div className="text-right text-xs text-muted-foreground">
                      {p && parseFloat(p.outstandingAdvance) > 0 ? (
                        <span className="text-amber-600 dark:text-amber-400">{fmt(p.outstandingAdvance)}</span>
                      ) : (
                        <span>-</span>
                      )}
                    </div>
                    <Minus className="h-3.5 w-3.5 text-muted-foreground shrink-0 mx-auto" />
                    <Input
                      type="number"
                      className="w-20 text-right text-sm"
                      placeholder="0.00"
                      min="0"
                      value={deductions[emp.id] || ""}
                      onChange={(e) => setDeductions((d) => ({ ...d, [emp.id]: e.target.value }))}
                      data-testid={`input-payroll-deduction-${emp.id}`}
                    />
                    <div
                      className={`text-right font-mono text-sm font-semibold ${ded > 0 ? "text-amber-600 dark:text-amber-400" : ""}`}
                    >
                      {fmt(net)}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="flex justify-between text-sm font-medium pt-1 border-t">
              <span>Total Net Payroll</span>
              <span className="font-mono">{fmt(totalNet)}</span>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPayrollOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => payrollMutation.mutate()}
              disabled={payrollMutation.isPending || totalNet === 0}
              data-testid="button-confirm-payroll"
            >
              {payrollMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <DollarSign className="h-4 w-4 mr-2" />
              )}
              Pay {fmt(totalNet)}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
