import { searchAny } from "@shared/searchNormalization";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import type { ClientErrorLike } from "@/lib/clientError";
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  Plus,
  Search,
  Pencil,
  Users,
  UserX,
  UserCheck,
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
  Loader2,
  DollarSign,
  UserCheck2,
  UserMinus,
} from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { factoryApiRequest } from "@/lib/factoryApi";

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

const AVATAR_COLORS = [
  "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300",
  "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300",
  "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300",
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

const emptyForm = {
  firstName: "",
  lastName: "",
  code: "",
  department: "",
  phone: "",
  monthlySalary: "",
  joinDate: new Date().toLocaleDateString("en-CA"),
};

function fmt(val: string | number | null | undefined) {
  const n = parseFloat(String(val || 0));
  if (isNaN(n)) return "$0";
  return n % 1 === 0 ? `$${n.toLocaleString()}` : `$${n.toFixed(2)}`;
}

export default function FactoryEmployees() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const { selectedCompany } = useCompany();
  const recordChanges = useExistingRecordChangeAccess();

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("Active");
  const [createOpen, setCreateOpen] = useState(false);
  const [editingEmployee, setEditingEmployee] = useState<Employee | null>(null);
  const [endingContractEmployee, setEndingContractEmployee] = useState<Employee | null>(null);
  const [formData, setFormData] = useState({ ...emptyForm });
  const [recalcConfirmOpen, setRecalcConfirmOpen] = useState(false);
  const [recalcResultOpen, setRecalcResultOpen] = useState(false);
  const [recalcResult, setRecalcResult] = useState<{
    updated: number;
    employees: Array<{ id: number; name: string; oldBalance: number; newBalance: number }>;
  } | null>(null);

  const { data: employees = [], isLoading } = useQuery<Employee[]>({
    queryKey: companyQueryKey("/api/factory/employees", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
    queryFn: async () => {
      const res = await factoryApiRequest("GET", "/api/factory/employees");
      if (!res.ok) throw new Error("Failed to fetch employees");
      return res.json();
    },
  });

  const createMutation = useMutation({
    mutationFn: async (data: typeof formData) => {
      const res = await factoryApiRequest("POST", "/api/factory/employees", data);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed to create employee");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: companyQueryKey("/api/factory/employees", selectedCompany?.id) });
      toast({ title: "Employee created" });
      setCreateOpen(false);
      setFormData({ ...emptyForm });
    },
    onError: (e: ClientErrorLike) => {
      if (e?._handledGlobally) return;
      toast({ variant: "destructive", title: e.message });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: Partial<typeof formData> }) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const res = await factoryApiRequest("PATCH", `/api/factory/employees/${id}`, data);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed to update employee");
      }
      return res.json();
    },
    onSuccess: (emp: Employee) => {
      queryClient.invalidateQueries({ queryKey: companyQueryKey("/api/factory/employees", selectedCompany?.id) });
      queryClient.invalidateQueries({
        queryKey: companyQueryKey("/api/factory/employees", selectedCompany?.id, emp.id),
      });
      toast({ title: "Employee updated" });
      setEditingEmployee(null);
    },
    onError: (e: ClientErrorLike) => {
      if (e?._handledGlobally) return;
      toast({ variant: "destructive", title: e.message });
    },
  });

  const deactivateMutation = useMutation({
    mutationFn: async (id: number) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const res = await factoryApiRequest("PATCH", `/api/factory/employees/${id}`, { active: false });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || "Failed to end contract");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: companyQueryKey("/api/factory/employees", selectedCompany?.id) });
      toast({ title: "Contract ended", description: "Employee has been deactivated" });
      setEndingContractEmployee(null);
    },
    onError: (e: ClientErrorLike) => {
      if (e?._handledGlobally) return;
      toast({ variant: "destructive", title: e.message });
    },
  });

  const reactivateMutation = useMutation({
    mutationFn: async (id: number) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const res = await factoryApiRequest("PATCH", `/api/factory/employees/${id}`, { active: true });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || "Failed to reactivate employee");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: companyQueryKey("/api/factory/employees", selectedCompany?.id) });
      toast({ title: "Employee reactivated" });
    },
    onError: (e: ClientErrorLike) => {
      if (e?._handledGlobally) return;
      toast({ variant: "destructive", title: e.message });
    },
  });

  const recalcMutation = useMutation({
    mutationFn: async () => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const res = await factoryApiRequest("POST", "/api/factory/employees/recalculate-balances", {});
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || "Failed to recalculate balances");
      }
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: companyQueryKey("/api/factory/employees", selectedCompany?.id) });
      setRecalcConfirmOpen(false);
      setRecalcResult(data);
      setRecalcResultOpen(true);
    },
    onError: (e: ClientErrorLike) => {
      if (e?._handledGlobally) return;
      toast({ variant: "destructive", title: "Recalculation failed", description: e.message });
    },
  });

  function parseCodeNum(code: string | null | undefined) {
    if (!code) return Infinity;
    const m = code.match(/(\d+)$/);
    return m ? parseInt(m[1], 10) : Infinity;
  }

  const filtered = employees
    .filter((e) => {
      const matchesSearch = searchAny(search, `${e.firstName} ${e.lastName}`, e.code);
      const matchesStatus =
        statusFilter === "All" || (statusFilter === "Active" && e.active) || (statusFilter === "Inactive" && !e.active);
      return matchesSearch && matchesStatus;
    })
    .sort((a, b) => parseCodeNum(a.code) - parseCodeNum(b.code));

  // Stats
  const totalActive = employees.filter((e) => e.active).length;
  const totalInactive = employees.filter((e) => !e.active).length;
  const totalMonthlySalary = employees
    .filter((e) => e.active)
    .reduce((s, e) => s + parseFloat(e.monthlySalary || "0"), 0);

  function openCreate() {
    setFormData({ ...emptyForm });
    setCreateOpen(true);
  }

  function openEdit(emp: Employee) {
    setFormData({
      firstName: emp.firstName,
      lastName: emp.lastName,
      code: emp.code,
      department: emp.department || "",
      phone: emp.phone || "",
      monthlySalary: emp.monthlySalary || "",
      joinDate: emp.joinDate || "",
    });
    setEditingEmployee(emp);
  }

  function handleField(key: string, val: string) {
    setFormData((f) => ({ ...f, [key]: val }));
  }

  return (
    <div className="space-y-5 pb-6">
      {/* Visual summary only: all payroll amounts still come from the existing calculations. */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="employees-summary">
        {isLoading ? (
          <>
            {[0, 1, 2, 3].map((index) => (
              <Skeleton key={index} className="h-[88px] rounded-2xl" />
            ))}
          </>
        ) : (
          <>
            <div className="flex min-w-0 items-center gap-3 rounded-2xl border border-border/70 bg-gradient-to-br from-card to-muted/30 p-3.5 shadow-sm sm:p-4 dark:from-slate-900 dark:to-slate-800/70">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-muted/70 text-foreground shadow-inner">
                <Users className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <p className="text-xs font-medium text-muted-foreground sm:text-sm">Total</p>
                <p className="mt-0.5 text-xl font-bold tracking-tight tabular-nums sm:text-2xl">{employees.length}</p>
              </div>
            </div>
            <div className="flex min-w-0 items-center gap-3 rounded-2xl border border-emerald-500/25 bg-gradient-to-br from-emerald-50 to-card p-3.5 shadow-sm sm:p-4 dark:from-emerald-950/65 dark:to-slate-900">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                <UserCheck2 className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <p className="text-xs font-medium text-muted-foreground sm:text-sm">Active</p>
                <p className="mt-0.5 text-xl font-bold tracking-tight tabular-nums sm:text-2xl">{totalActive}</p>
              </div>
            </div>
            <div className="flex min-w-0 items-center gap-3 rounded-2xl border border-border/70 bg-gradient-to-br from-card to-muted/30 p-3.5 shadow-sm sm:p-4 dark:from-slate-900 dark:to-slate-800/70">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-muted/70 text-muted-foreground">
                <UserMinus className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <p className="text-xs font-medium text-muted-foreground sm:text-sm">Inactive</p>
                <p className="mt-0.5 text-xl font-bold tracking-tight tabular-nums sm:text-2xl">{totalInactive}</p>
              </div>
            </div>
            <div className="flex min-w-0 items-center gap-3 rounded-2xl border border-violet-500/25 bg-gradient-to-br from-violet-50 to-card p-3.5 shadow-sm sm:p-4 dark:from-violet-950/65 dark:to-slate-900">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-violet-500/15 text-violet-600 dark:text-violet-300">
                <DollarSign className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <p className="text-xs font-medium text-muted-foreground sm:text-sm">Monthly Payroll</p>
                <p
                  className="mt-0.5 truncate text-lg font-bold tracking-tight tabular-nums sm:text-2xl"
                  title={fmt(totalMonthlySalary)}
                >
                  {fmt(totalMonthlySalary)}
                </p>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Filter row */}
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
        <div className="relative min-w-[200px] flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search employees..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-11 rounded-xl border-border/70 bg-card/80 pl-10 shadow-sm focus-visible:ring-emerald-500/30"
            data-testid="input-employee-search"
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger
            className="h-11 w-full rounded-xl border-border/70 bg-card/80 shadow-sm sm:w-36"
            data-testid="select-employee-status"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="Active">Active</SelectItem>
            <SelectItem value="Inactive">Inactive</SelectItem>
            <SelectItem value="All">All</SelectItem>
          </SelectContent>
        </Select>
        {recordChanges.canCreate("POST", "/api/factory/employees") && (
          <Button
            onClick={openCreate}
            className="h-11 rounded-xl bg-emerald-600 px-5 font-semibold text-white shadow-sm hover:bg-emerald-700 dark:bg-emerald-600 dark:hover:bg-emerald-500"
            data-testid="button-create-employee"
          >
            <Plus className="mr-2 h-4 w-4" />
            New Employee
          </Button>
        )}
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-2xl border border-border/70 bg-card shadow-sm dark:border-slate-700/70 dark:bg-slate-950/40">
        <Table mobileLayout="cards" className="w-full md:min-w-[720px]">
          <TableHeader className="sticky top-0 z-30">
            <TableRow className="border-b border-border/70 bg-muted/65 hover:bg-muted/65 dark:bg-slate-800/70 dark:hover:bg-slate-800/70">
              <TableHead className="py-3.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Employee
              </TableHead>
              <TableHead className="text-right py-3.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Monthly Salary
              </TableHead>
              <TableHead className="text-right py-3.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Balance
              </TableHead>
              <TableHead className="py-3.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Status
              </TableHead>
              <TableHead className="w-[104px] py-3.5">
                <span className="sr-only">Employee actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              [...Array(6)].map((_, i) => (
                <TableRow key={i}>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <Skeleton className="h-8 w-8 rounded-full" />
                      <Skeleton className="h-4 w-36" />
                    </div>
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-4 w-20 ml-auto" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-4 w-20 ml-auto" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-5 w-16 rounded-full" />
                  </TableCell>
                  <TableCell></TableCell>
                </TableRow>
              ))
            ) : filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5}>
                  <div className="flex flex-col items-center gap-2 py-10 text-center">
                    <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center">
                      <Users className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <p className="text-sm font-medium">No employees found</p>
                    <p className="text-xs text-muted-foreground">
                      {search ? "Try a different search term" : "Add your first employee to get started"}
                    </p>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((emp) => {
                const fullName = `${emp.firstName} ${emp.lastName}`;
                const balance = parseFloat(emp.currentBalance || "0");
                const avatarColor = getAvatarColor(fullName);
                return (
                  <TableRow
                    key={emp.id}
                    className="group cursor-pointer border-b border-border/50 transition-colors hover:bg-emerald-500/[0.055] focus-within:bg-emerald-500/[0.055] dark:hover:bg-emerald-400/[0.08] dark:focus-within:bg-emerald-400/[0.08]"
                    onClick={() => navigate(`/factory/employees/${emp.id}`)}
                    data-testid={`row-employee-${emp.id}`}
                  >
                    <TableCell className="py-3">
                      <div className="flex items-center gap-3">
                        <Avatar className={`h-9 w-9 shrink-0 border border-border/40 shadow-sm ${avatarColor}`}>
                          <AvatarFallback className={`text-xs font-semibold ${avatarColor}`}>
                            {getInitials(fullName)}
                          </AvatarFallback>
                        </Avatar>
                        <span className="text-sm font-semibold tracking-tight text-foreground">{fullName}</span>
                      </div>
                    </TableCell>
                    <TableCell className="py-3 text-right font-mono text-sm font-medium tabular-nums text-muted-foreground">
                      {fmt(emp.monthlySalary)}
                    </TableCell>
                    <TableCell className="py-3 text-right">
                      <span
                        className={`font-mono font-bold text-sm tabular-nums ${
                          balance < 0 ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400"
                        }`}
                      >
                        {fmt(emp.currentBalance)}
                      </span>
                    </TableCell>
                    <TableCell className="py-3">
                      <Badge
                        variant="secondary"
                        className={`rounded-full border border-transparent px-2.5 py-0.5 text-xs font-semibold no-default-active-elevate ${
                          emp.active
                            ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300"
                            : "bg-muted text-muted-foreground"
                        }`}
                      >
                        {emp.active ? "Active" : "Inactive"}
                      </Badge>
                    </TableCell>
                    <TableCell className="py-3">
                      {recordChanges.allowed && (
                        <div
                          className="flex items-center justify-end gap-1 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 touch:opacity-100"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => openEdit(emp)}
                            data-testid={`button-edit-employee-${emp.id}`}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          {emp.active ? (
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => setEndingContractEmployee(emp)}
                              data-testid={`button-end-contract-${emp.id}`}
                              title="End Contract"
                            >
                              <UserX className="h-3.5 w-3.5 text-destructive" />
                            </Button>
                          ) : (
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => reactivateMutation.mutate(emp.id)}
                              disabled={reactivateMutation.isPending}
                              data-testid={`button-reactivate-${emp.id}`}
                              title="Reactivate"
                            >
                              <UserCheck className="h-3.5 w-3.5 text-emerald-600" />
                            </Button>
                          )}
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      {/* Create / Edit Dialog */}
      <Dialog
        open={createOpen || !!editingEmployee}
        onOpenChange={(open) => {
          if (!open) {
            setCreateOpen(false);
            setEditingEmployee(null);
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editingEmployee ? "Edit Employee" : "New Employee"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label>First Name *</Label>
                <Input
                  value={formData.firstName}
                  onChange={(e) => handleField("firstName", e.target.value)}
                  placeholder="First name"
                  data-testid="input-first-name"
                />
              </div>
              <div className="space-y-1">
                <Label>Last Name *</Label>
                <Input
                  value={formData.lastName}
                  onChange={(e) => handleField("lastName", e.target.value)}
                  placeholder="Last name"
                  data-testid="input-last-name"
                />
              </div>
            </div>
            {!editingEmployee && (
              <div className="space-y-1">
                <Label>Code (optional)</Label>
                <Input
                  value={formData.code}
                  onChange={(e) => handleField("code", e.target.value)}
                  placeholder="Auto-generated if blank"
                  data-testid="input-code"
                />
              </div>
            )}
            <div className="space-y-1">
              <Label>Department</Label>
              <Input
                value={formData.department}
                onChange={(e) => handleField("department", e.target.value)}
                placeholder="e.g. Operations"
                data-testid="input-department"
              />
            </div>
            <div className="space-y-1">
              <Label>Phone</Label>
              <Input
                value={formData.phone}
                onChange={(e) => handleField("phone", e.target.value)}
                placeholder="+1 234 567 8900"
                data-testid="input-phone"
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label>Monthly Salary</Label>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={formData.monthlySalary}
                  onChange={(e) => handleField("monthlySalary", e.target.value)}
                  placeholder="0.00"
                  data-testid="input-monthly-salary"
                />
              </div>
              <div className="space-y-1">
                <Label>Join Date *</Label>
                <Input
                  type="date"
                  value={formData.joinDate}
                  onChange={(e) => handleField("joinDate", e.target.value)}
                  data-testid="input-join-date"
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setCreateOpen(false);
                setEditingEmployee(null);
              }}
              data-testid="button-cancel"
            >
              Cancel
            </Button>
            {(editingEmployee ? recordChanges.allowed : recordChanges.canCreate("POST", "/api/factory/employees")) && (
              <Button
                onClick={() => {
                  if (editingEmployee) {
                    updateMutation.mutate({ id: editingEmployee.id, data: formData });
                  } else {
                    createMutation.mutate(formData);
                  }
                }}
                disabled={createMutation.isPending || updateMutation.isPending}
                data-testid="button-save"
              >
                {createMutation.isPending || updateMutation.isPending ? "Saving..." : "Save"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* End Contract Confirmation Dialog */}
      <Dialog
        open={!!endingContractEmployee}
        onOpenChange={(open) => {
          if (!open) setEndingContractEmployee(null);
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>End Contract</DialogTitle>
          </DialogHeader>
          {endingContractEmployee &&
            (() => {
              const liveEmp = employees.find((e) => e.id === endingContractEmployee.id) ?? endingContractEmployee;
              const balance = parseFloat(liveEmp.currentBalance || "0");
              const fmtBal = (v: number) =>
                v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
              return (
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">
                    Ending contract for{" "}
                    <span className="font-semibold text-foreground">
                      {endingContractEmployee.firstName} {endingContractEmployee.lastName}
                    </span>
                    . They will be marked inactive but can be reactivated later.
                  </p>
                  {balance > 0 ? (
                    <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-700 p-3 space-y-1.5">
                      <div className="flex items-center gap-2 text-amber-700 dark:text-amber-400 font-medium text-sm">
                        <AlertTriangle className="h-4 w-4 shrink-0" />
                        Outstanding balance: ${fmtBal(balance)}
                      </div>
                      <p className="text-xs text-amber-700/80 dark:text-amber-400/80 leading-relaxed">
                        Running payroll records salary as <em>earned</em> — it doesn't mean cash was handed out. To
                        clear this balance, go to <strong>Withdrawals</strong> and record a cash payment of $
                        {fmtBal(balance)} before ending the contract.
                      </p>
                    </div>
                  ) : balance < 0 ? (
                    <div className="rounded-md border border-red-300 bg-red-50 dark:bg-red-900/20 dark:border-red-700 p-3 space-y-1.5">
                      <div className="flex items-center gap-2 text-red-700 dark:text-red-400 font-medium text-sm">
                        <AlertTriangle className="h-4 w-4 shrink-0" />
                        Employee owes: ${fmtBal(Math.abs(balance))}
                      </div>
                      <p className="text-xs text-red-700/80 dark:text-red-400/80">
                        This employee has a negative balance — they owe the company ${fmtBal(Math.abs(balance))}.
                        Collect this before ending the contract if needed.
                      </p>
                    </div>
                  ) : (
                    <div className="rounded-md border border-green-300 bg-green-50 dark:bg-green-900/20 dark:border-green-700 p-3 flex items-center gap-2 text-green-700 dark:text-green-400 text-sm font-medium">
                      <CheckCircle2 className="h-4 w-4 shrink-0" />
                      Balance is clear — safe to end contract
                    </div>
                  )}
                </div>
              );
            })()}
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => setEndingContractEmployee(null)}
              disabled={deactivateMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => endingContractEmployee && deactivateMutation.mutate(endingContractEmployee.id)}
              disabled={deactivateMutation.isPending}
              data-testid="button-confirm-end-contract"
            >
              {deactivateMutation.isPending ? "Ending..." : "End Contract Anyway"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Recalculate Balances — Confirmation */}
      <Dialog open={recalcConfirmOpen} onOpenChange={setRecalcConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Recalculate All Employee Balances</DialogTitle>
            <DialogDescription>
              This will rebuild every employee's current balance, total deposits, and total withdrawals from their
              actual accounting records. Use this to fix balances that were corrupted by deletions that didn't reverse
              properly.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-700 p-3 flex items-start gap-2 text-sm text-amber-800 dark:text-amber-300">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>
              This will overwrite the stored balances for <strong>all employees</strong> based on surviving voucher
              records.
            </span>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setRecalcConfirmOpen(false)} disabled={recalcMutation.isPending}>
              Cancel
            </Button>
            <Button
              onClick={() => recalcMutation.mutate()}
              disabled={recalcMutation.isPending}
              data-testid="button-confirm-recalculate"
            >
              {recalcMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Recalculating...
                </>
              ) : (
                <>
                  <RefreshCw className="h-4 w-4 mr-2" />
                  Recalculate Now
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Recalculate Balances — Results */}
      <Dialog open={recalcResultOpen} onOpenChange={setRecalcResultOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-emerald-600" />
              Balances Recalculated
            </DialogTitle>
            <DialogDescription>
              {recalcResult?.updated ?? 0} employee{recalcResult?.updated !== 1 ? "s" : ""} updated from voucher
              records.
            </DialogDescription>
          </DialogHeader>
          {recalcResult &&
          recalcResult.employees.filter((e) => Math.abs(e.oldBalance - e.newBalance) > 0.005).length > 0 ? (
            <div className="max-h-64 overflow-y-auto border rounded-xl overflow-hidden text-sm">
              <div className="grid grid-cols-3 px-3 py-2 bg-muted/40 text-xs font-semibold text-muted-foreground">
                <span>Employee</span>
                <span className="text-right">Old Balance</span>
                <span className="text-right">New Balance</span>
              </div>
              {recalcResult.employees
                .filter((e) => Math.abs(e.oldBalance - e.newBalance) > 0.005)
                .map((e) => (
                  <div key={e.id} className="grid grid-cols-3 px-3 py-2 border-t">
                    <span className="truncate">{e.name}</span>
                    <span className="text-right font-mono text-muted-foreground">${e.oldBalance.toFixed(2)}</span>
                    <span
                      className={`text-right font-mono font-medium ${e.newBalance >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}
                    >
                      ${e.newBalance.toFixed(2)}
                    </span>
                  </div>
                ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground text-center py-4">
              All balances were already correct — no changes needed.
            </p>
          )}
          <DialogFooter>
            <Button onClick={() => setRecalcResultOpen(false)} data-testid="button-close-recalc-result">
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
