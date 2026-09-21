import type { ClientErrorLike } from "@/lib/clientError";
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useAdminOverride } from "@/hooks/use-admin-override";
import { useRoute, useLocation } from "wouter";
import { useEscapeToParent } from "@/hooks/use-escape-to-parent";
import {
  ArrowLeft,
  DollarSign,
  Calendar,
  Phone,
  Loader2,
  Pencil,
  TrendingUp,
  TrendingDown,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { factoryApiRequest } from "@/lib/factoryApi";
import { useDateFormat } from "@/contexts/DateFormatContext";

interface Employee {
  id: number;
  code: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  department: string | null;
  monthlySalary: string;
  currentBalance: string;
  totalDeposits: string;
  totalWithdrawals: string;
  active: boolean;
  joinDate: string;
  employeeType: string;
}

interface StatementRow {
  id: number;
  voucherId: number;
  voucherNumber: string;
  voucherDate: string;
  voucherType: string;
  description: string;
  narration: string;
  credit: number;
  debit: number;
  balance: number;
}

interface LedgerAccount {
  id: number;
  name: string;
  code: string;
  accountType: string;
}

const AVATAR_COLORS = [
  "bg-blue-100 text-blue-700",
  "bg-purple-100 text-purple-700",
  "bg-emerald-100 text-emerald-700",
  "bg-amber-100 text-amber-700",
  "bg-rose-100 text-rose-700",
  "bg-cyan-100 text-cyan-700",
];

function getAvatarColor(name: string) {
  let hash = 0;
  for (const c of name) hash = c.charCodeAt(0) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function getInitials(name: string) {
  return name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((n) => n[0])
    .join("")
    .toUpperCase();
}

function fmt(val: string | number | null | undefined) {
  const n = parseFloat(String(val || 0));
  return isNaN(n) ? "$0.00" : `$${n.toFixed(2)}`;
}

export default function FactoryEmployeeDetail() {
  const { wrapAdminAction, AdminDialog } = useAdminOverride();
  const { data: currentUser } = useQuery<{ role?: string }>({ queryKey: ["/api/auth/me"] });
  const isDeveloper = currentUser?.role === "Developer";
  const [, navigate] = useLocation();
  useEscapeToParent("/factory/payroll-hub?tab=employees");
  const [, params] = useRoute("/factory/employees/:id");
  const employeeId = params?.id ? parseInt(params.id) : null;
  const { toast } = useToast();
  const { formatDisplayDate } = useDateFormat();

  const formatDate = (val: string | Date | null | undefined) => {
    if (!val) return "—";
    try {
      return formatDisplayDate(val instanceof Date ? val : new Date(val));
    } catch {
      return "—";
    }
  };

  // State for dialogs
  const [editOpen, setEditOpen] = useState(false);
  const [editForm, setEditForm] = useState({
    firstName: "",
    lastName: "",
    department: "",
    phone: "",
    monthlySalary: "",
  });

  // Deposit form
  const [depositOpen, setDepositOpen] = useState(false);
  const [depositAmount, setDepositAmount] = useState("");
  const [depositDate, setDepositDate] = useState(new Date().toLocaleDateString("en-CA"));
  const [depositNotes, setDepositNotes] = useState("");
  const [depositEffectiveDate, setDepositEffectiveDate] = useState("");

  // Withdrawal form
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [withdrawDate, setWithdrawDate] = useState(new Date().toLocaleDateString("en-CA"));
  const [withdrawNotes, setWithdrawNotes] = useState("");
  const [withdrawCashAccountId, setWithdrawCashAccountId] = useState("");

  // Payroll (bulk) state
  const [payrollDate, _setPayrollDate] = useState(new Date().toLocaleDateString("en-CA"));
  const [payrollNotes, setPayrollNotes] = useState("");
  const [payrollEffectiveDate, _setPayrollEffectiveDate] = useState("");

  // All employees for payroll tab
  const [selectedEmployees, setSelectedEmployees] = useState<Set<number>>(new Set());
  const [payrollAmounts, setPayrollAmounts] = useState<Record<number, string>>({});

  // Queries
  const {
    data: employee,
    isLoading: empLoading,
    error: empError,
  } = useQuery<Employee>({
    queryKey: ["/api/factory/employees", employeeId],
    queryFn: async () => {
      const res = await factoryApiRequest("GET", `/api/factory/employees/${employeeId}`);
      if (!res.ok) throw new Error("Employee not found");
      return res.json();
    },
    enabled: !!employeeId,
  });

  const { data: statement, isLoading: stmtLoading } = useQuery<{ employee: Employee; rows: StatementRow[] }>({
    queryKey: ["/api/factory/employees", employeeId, "statement"],
    queryFn: async () => {
      const res = await factoryApiRequest("GET", `/api/factory/employees/${employeeId}/statement`);
      if (!res.ok) throw new Error("Failed to fetch statement");
      return res.json();
    },
    enabled: !!employeeId,
  });

  const { data: allEmployees = [] } = useQuery<Employee[]>({
    queryKey: ["/api/factory/employees"],
    queryFn: async () => {
      const res = await factoryApiRequest("GET", "/api/factory/employees");
      if (!res.ok) throw new Error("Failed to fetch employees");
      return res.json();
    },
  });

  const { data: cashAccounts = [] } = useQuery<LedgerAccount[]>({
    queryKey: ["/api/ledger-accounts?includeHidden=true&profile=picker"],
    queryFn: async () => {
      const res = await fetch("/api/ledger-accounts?includeHidden=true&profile=picker", { credentials: "include" });
      if (!res.ok) return [];
      const data = await res.json();
      return (data || []).filter(
        (a: LedgerAccount) => a.accountType === "Cash" || a.accountType?.toLowerCase().includes("cash")
      );
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  // Mutations
  const updateMutation = useMutation({
    mutationFn: async (data: typeof editForm) => {
      const res = await factoryApiRequest("PATCH", `/api/factory/employees/${employeeId}`, data);
      if (!res.ok) {
        const e = await res.json();
        throw new Error(e.message);
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/employees", employeeId] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/employees"] });
      toast({ title: "Employee updated" });
      setEditOpen(false);
    },
    onError: (e: ClientErrorLike) => {
      if (e?._handledGlobally) return;
      toast({ variant: "destructive", title: e.message });
    },
  });

  const recalcMutation = useMutation({
    mutationFn: async () => {
      const res = await factoryApiRequest("POST", `/api/factory/employees/${employeeId}/recalculate-balance`);
      if (!res.ok) {
        const e = await res.json();
        throw new Error(e.message);
      }
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/employees", employeeId] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/employees"] });
      toast({ title: "Balance recalculated", description: `New balance: $${data.newBalance?.toFixed(2)}` });
    },
    onError: (e: ClientErrorLike) => {
      if (e?._handledGlobally) return;
      toast({ variant: "destructive", title: e.message });
    },
  });

  const depositMutation = useMutation({
    mutationFn: async () => {
      const res = await factoryApiRequest("POST", `/api/factory/employees/${employeeId}/deposit`, {
        amount: depositAmount,
        date: depositDate,
        notes: depositNotes,
        effectiveDate: depositEffectiveDate || null,
      });
      if (!res.ok) {
        const e = await res.json();
        throw new Error(e.message);
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/employees", employeeId] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/employees", employeeId, "statement"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/employees"] });
      toast({ title: "Deposit recorded" });
      setDepositOpen(false);
      setDepositAmount("");
      setDepositNotes("");
      setDepositEffectiveDate("");
    },
    onError: (e: ClientErrorLike) => {
      if (e?._handledGlobally) return;
      toast({ variant: "destructive", title: e.message });
    },
  });

  const withdrawMutation = useMutation({
    mutationFn: async () => {
      const res = await factoryApiRequest("POST", `/api/factory/employees/${employeeId}/withdraw`, {
        amount: withdrawAmount,
        date: withdrawDate,
        notes: withdrawNotes,
        cashAccountId: withdrawCashAccountId,
      });
      if (!res.ok) {
        const e = await res.json();
        throw new Error(e.message);
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/employees", employeeId] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/employees", employeeId, "statement"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/employees"] });
      toast({ title: "Withdrawal recorded" });
      setWithdrawOpen(false);
      setWithdrawAmount("");
      setWithdrawNotes("");
      setWithdrawCashAccountId("");
    },
    onError: (e: ClientErrorLike) => {
      if (e?._handledGlobally) return;
      toast({ variant: "destructive", title: e.message });
    },
  });

  const _bulkPayrollMutation = useMutation({
    mutationFn: async () => {
      const deposits = Array.from(selectedEmployees)
        .map((empId) => ({
          employeeId: empId,
          amount: payrollAmounts[empId] || allEmployees.find((e) => e.id === empId)?.monthlySalary || "0",
        }))
        .filter((d) => parseFloat(d.amount) > 0);

      const res = await factoryApiRequest("POST", "/api/factory/employees/bulk-payroll", {
        deposits,
        date: payrollDate,
        notes: payrollNotes,
        effectiveDate: payrollEffectiveDate || null,
      });
      if (!res.ok) {
        const e = await res.json();
        throw new Error(e.message);
      }
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/employees"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/employees", employeeId] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/employees", employeeId, "statement"] });
      toast({ title: "Payroll deposited", description: `${data.results?.length || 0} employees processed` });
      setSelectedEmployees(new Set());
      setPayrollAmounts({});
      setPayrollNotes("");
    },
    onError: (e: ClientErrorLike) => {
      if (e?._handledGlobally) return;
      toast({ variant: "destructive", title: e.message });
    },
  });

  if (!employeeId) return <div className="p-8 text-muted-foreground">Invalid employee ID</div>;

  if (empLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-32" />
        <div className="flex gap-6">
          <Skeleton className="w-64 h-80 shrink-0 rounded-md" />
          <Skeleton className="flex-1 h-80 rounded-md" />
        </div>
      </div>
    );
  }

  if (empError || !employee) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" size="icon" onClick={() => navigate("/factory/payroll-hub?tab=employees")}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex items-center justify-center py-20 text-muted-foreground">Employee not found</div>
      </div>
    );
  }

  const fullName = `${employee.firstName} ${employee.lastName}`;
  const avatarColor = getAvatarColor(fullName);
  const balance = parseFloat(employee.currentBalance || "0");

  const _infoRow = (label: string, value: string | number | null | undefined) => (
    <div className="flex justify-between py-1.5 border-b last:border-0 text-sm">
      <span className="text-muted-foreground shrink-0 mr-3">{label}</span>
      <span className="font-medium text-right">{value || "—"}</span>
    </div>
  );

  // Deposits and withdrawals from statement
  const _depositRows = (statement?.rows || []).filter((r) => r.credit > 0);
  const _withdrawRows = (statement?.rows || []).filter((r) => r.debit > 0);

  return (
    <div className="space-y-4">
      <Button
        variant="ghost"
        size="icon"
        onClick={() => navigate("/factory/payroll-hub?tab=employees")}
        data-testid="button-back"
      >
        <ArrowLeft className="h-4 w-4" />
      </Button>

      <div className="flex flex-col lg:flex-row gap-6 items-start">
        {/* Left Summary Card */}
        <div className="w-full lg:w-64 shrink-0 space-y-4">
          <Card>
            <CardContent className="p-5 space-y-4">
              <div className="flex flex-col items-center text-center gap-3">
                <Avatar className={`h-20 w-20 text-lg font-bold ${avatarColor}`}>
                  <AvatarFallback className={`text-lg font-bold ${avatarColor}`} data-testid="text-employee-avatar">
                    {getInitials(fullName)}
                  </AvatarFallback>
                </Avatar>
                <div>
                  <h2 className="font-bold text-lg leading-tight" data-testid="text-employee-name">
                    {fullName}
                  </h2>
                  {employee.department && <p className="text-sm text-muted-foreground mt-0.5">{employee.department}</p>}
                </div>
                <Badge
                  variant={employee.active ? "default" : "secondary"}
                  className="no-default-active-elevate"
                  data-testid="badge-employee-status"
                >
                  {employee.active ? "Active" : "Inactive"}
                </Badge>
              </div>

              <div className="border-t pt-3 space-y-1.5">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground text-xs">Code</span>
                  <span className="font-mono text-xs" data-testid="text-employee-code">
                    {employee.code}
                  </span>
                </div>
                {employee.phone && (
                  <div className="flex justify-between text-sm">
                    <Phone className="h-3 w-3 text-muted-foreground shrink-0 mt-0.5" />
                    <span className="text-xs" data-testid="text-employee-phone">
                      {employee.phone}
                    </span>
                  </div>
                )}
                {employee.joinDate && (
                  <div className="flex justify-between text-sm">
                    <Calendar className="h-3 w-3 text-muted-foreground shrink-0 mt-0.5" />
                    <span className="text-xs">Joined {formatDate(employee.joinDate)}</span>
                  </div>
                )}
                <div className="flex justify-between text-sm">
                  <DollarSign className="h-3 w-3 text-muted-foreground shrink-0 mt-0.5" />
                  <span className="text-xs font-mono">{fmt(employee.monthlySalary)} / mo</span>
                </div>
              </div>

              <div className="border-t pt-3 space-y-2">
                <div className="text-center">
                  <div className="text-xs text-muted-foreground mb-1">Current Balance</div>
                  <div
                    className={`text-xl font-bold font-mono ${balance < 0 ? "text-red-600 dark:text-red-400" : balance > 0 ? "text-green-600 dark:text-green-400" : ""}`}
                    data-testid="text-employee-balance"
                  >
                    {fmt(employee.currentBalance)}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs text-center">
                  <div>
                    <div className="text-muted-foreground">Deposits</div>
                    <div className="font-mono font-medium text-green-600 dark:text-green-400">
                      {fmt(employee.totalDeposits)}
                    </div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">Withdrawn</div>
                    <div className="font-mono font-medium text-red-600 dark:text-red-400">
                      {fmt(employee.totalWithdrawals)}
                    </div>
                  </div>
                </div>
              </div>

              <div className="border-t pt-3 space-y-2">
                <Button
                  variant="outline"
                  className="w-full"
                  size="sm"
                  onClick={() => {
                    setEditForm({
                      firstName: employee.firstName,
                      lastName: employee.lastName,
                      department: employee.department || "",
                      phone: employee.phone || "",
                      monthlySalary: employee.monthlySalary || "",
                    });
                    setEditOpen(true);
                  }}
                  data-testid="button-edit-employee"
                >
                  <Pencil className="h-3.5 w-3.5 mr-2" />
                  Edit
                </Button>
                {isDeveloper && (
                  <Button
                    variant="outline"
                    className="w-full"
                    size="sm"
                    onClick={() => wrapAdminAction(() => recalcMutation.mutate(), "Recalculate Balance")}
                    disabled={recalcMutation.isPending}
                    data-testid="button-recalculate-balance"
                  >
                    {recalcMutation.isPending ? (
                      <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />
                    ) : (
                      <RefreshCw className="h-3.5 w-3.5 mr-2" />
                    )}
                    Recalculate
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Statement */}
        <div className="flex-1 min-w-0">
          <Card>
            <CardHeader className="pb-2 pt-4 px-5">
              <CardTitle className="text-sm text-muted-foreground">Running Statement</CardTitle>
            </CardHeader>
            <CardContent className="px-5 pb-4 overflow-x-auto">
              {stmtLoading ? (
                <div className="space-y-2">
                  {[...Array(5)].map((_, i) => (
                    <Skeleton key={i} className="h-10 w-full" />
                  ))}
                </div>
              ) : !statement?.rows || statement.rows.length === 0 ? (
                <p className="text-sm text-muted-foreground py-8 text-center">No transactions yet</p>
              ) : (
                <Table>
                  <TableHeader className="sticky top-0 z-30 bg-background">
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Voucher</TableHead>
                      <TableHead>Description</TableHead>
                      <TableHead className="text-right">Deposit</TableHead>
                      <TableHead className="text-right">Withdrawal</TableHead>
                      <TableHead className="text-right">Balance</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {statement.rows.map((row) => (
                      <TableRow key={row.id} data-testid={`row-stmt-${row.id}`}>
                        <TableCell className="text-sm">{formatDate(row.voucherDate)}</TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">{row.voucherNumber}</TableCell>
                        <TableCell className="text-sm" dir="ltr">
                          {row.narration || row.description || "—"}
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm">
                          {row.credit > 0 ? (
                            <span className="text-green-600 dark:text-green-400">{fmt(row.credit)}</span>
                          ) : (
                            "—"
                          )}
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm">
                          {row.debit > 0 ? (
                            <span className="text-red-600 dark:text-red-400">{fmt(row.debit)}</span>
                          ) : (
                            "—"
                          )}
                        </TableCell>
                        <TableCell
                          className={`text-right font-mono text-sm font-semibold ${row.balance < 0 ? "text-red-600 dark:text-red-400" : ""}`}
                        >
                          {fmt(row.balance)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Edit Employee Dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Edit Employee</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label>First Name</Label>
                <Input
                  value={editForm.firstName}
                  onChange={(e) => setEditForm((f) => ({ ...f, firstName: e.target.value }))}
                  data-testid="input-edit-first-name"
                />
              </div>
              <div className="space-y-1">
                <Label>Last Name</Label>
                <Input
                  value={editForm.lastName}
                  onChange={(e) => setEditForm((f) => ({ ...f, lastName: e.target.value }))}
                  data-testid="input-edit-last-name"
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label>Department</Label>
              <Input
                value={editForm.department}
                onChange={(e) => setEditForm((f) => ({ ...f, department: e.target.value }))}
                data-testid="input-edit-department"
              />
            </div>
            <div className="space-y-1">
              <Label>Phone</Label>
              <Input
                value={editForm.phone}
                onChange={(e) => setEditForm((f) => ({ ...f, phone: e.target.value }))}
                data-testid="input-edit-phone"
              />
            </div>
            <div className="space-y-1">
              <Label>Monthly Salary</Label>
              <Input
                type="number"
                min="0"
                step="0.01"
                value={editForm.monthlySalary}
                onChange={(e) => setEditForm((f) => ({ ...f, monthlySalary: e.target.value }))}
                data-testid="input-edit-salary"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => wrapAdminAction(() => updateMutation.mutate(editForm), "Save Employee")}
              disabled={updateMutation.isPending}
              data-testid="button-save-edit"
            >
              {updateMutation.isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Deposit Dialog */}
      <Dialog open={depositOpen} onOpenChange={setDepositOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>New Deposit for {fullName}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1">
              <Label>Amount *</Label>
              <Input
                type="number"
                min="0.01"
                step="0.01"
                value={depositAmount}
                onChange={(e) => setDepositAmount(e.target.value)}
                placeholder="0.00"
                data-testid="input-deposit-amount"
              />
            </div>
            <div className="space-y-1">
              <Label>Entry Date *</Label>
              <Input
                type="date"
                value={depositDate}
                onChange={(e) => setDepositDate(e.target.value)}
                data-testid="input-deposit-date"
              />
            </div>
            <div className="space-y-1">
              <Label>
                Effective Date <span className="text-muted-foreground">(optional — period it belongs to)</span>
              </Label>
              <Input
                type="date"
                value={depositEffectiveDate}
                onChange={(e) => setDepositEffectiveDate(e.target.value)}
                data-testid="input-deposit-effective-date"
              />
            </div>
            <div className="space-y-1">
              <Label>Notes</Label>
              <Input
                value={depositNotes}
                onChange={(e) => setDepositNotes(e.target.value)}
                placeholder="Optional notes"
                data-testid="input-deposit-notes"
              />
            </div>
            <div className="bg-muted/50 rounded-md p-3 text-sm space-y-1">
              <div className="font-medium text-xs text-muted-foreground mb-1">Accounting Entry</div>
              <div className="flex justify-between">
                <span>DR: Payroll Expense</span>
                <span className="font-mono">{fmt(depositAmount || 0)}</span>
              </div>
              <div className="flex justify-between">
                <span>CR: Employee Account ({employee.code})</span>
                <span className="font-mono">{fmt(depositAmount || 0)}</span>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDepositOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => wrapAdminAction(() => depositMutation.mutate(), "Post Deposit")}
              disabled={depositMutation.isPending || !depositAmount}
              data-testid="button-confirm-deposit"
            >
              {depositMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Posting...
                </>
              ) : (
                <>
                  <TrendingUp className="h-4 w-4 mr-2" />
                  Post Deposit
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Withdrawal Dialog */}
      <Dialog open={withdrawOpen} onOpenChange={setWithdrawOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>New Withdrawal for {fullName}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1">
              <Label>Amount *</Label>
              <Input
                type="number"
                min="0.01"
                step="0.01"
                value={withdrawAmount}
                onChange={(e) => setWithdrawAmount(e.target.value)}
                placeholder="0.00"
                data-testid="input-withdraw-amount"
              />
            </div>
            <div className="space-y-1">
              <Label>Date *</Label>
              <Input
                type="date"
                value={withdrawDate}
                onChange={(e) => setWithdrawDate(e.target.value)}
                data-testid="input-withdraw-date"
              />
            </div>
            <div className="space-y-1">
              <Label>Cash Account *</Label>
              <Select value={withdrawCashAccountId} onValueChange={setWithdrawCashAccountId}>
                <SelectTrigger data-testid="select-cash-account">
                  <SelectValue placeholder="Select cash account" />
                </SelectTrigger>
                <SelectContent>
                  {cashAccounts.map((a) => (
                    <SelectItem key={a.id} value={String(a.id)} data-testid={`option-cash-${a.id}`}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Notes</Label>
              <Input
                value={withdrawNotes}
                onChange={(e) => setWithdrawNotes(e.target.value)}
                placeholder="Optional notes"
                data-testid="input-withdraw-notes"
              />
            </div>
            <div className="bg-muted/50 rounded-md p-3 text-sm space-y-1">
              <div className="font-medium text-xs text-muted-foreground mb-1">Accounting Entry</div>
              <div className="flex justify-between">
                <span>DR: Employee Account ({employee.code})</span>
                <span className="font-mono">{fmt(withdrawAmount || 0)}</span>
              </div>
              <div className="flex justify-between">
                <span>CR: Cash</span>
                <span className="font-mono">{fmt(withdrawAmount || 0)}</span>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Note: Withdrawals are allowed even if they result in a negative balance.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setWithdrawOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => wrapAdminAction(() => withdrawMutation.mutate(), "Post Withdrawal")}
              disabled={withdrawMutation.isPending || !withdrawAmount || !withdrawCashAccountId}
              data-testid="button-confirm-withdraw"
            >
              {withdrawMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Posting...
                </>
              ) : (
                <>
                  <TrendingDown className="h-4 w-4 mr-2" />
                  Post Withdrawal
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {AdminDialog}
    </div>
  );
}
