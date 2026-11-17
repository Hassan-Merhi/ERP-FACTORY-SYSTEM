import { searchAny } from "@shared/searchNormalization";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import type { ClientErrorLike } from "@/lib/clientError";
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  Users,
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
  Loader2,
  DollarSign,
  UserCheck2,
  UserMinus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { factoryApiRequest } from "@/lib/factoryApi";
import { ErrorState } from "@/components/ui/page-state";
import { formatUsd } from "@/lib/moneyDisplay";
import { useDateFormat } from "@/contexts/DateFormatContext";
import {
  PEOPLE_TABLE_HEAD_CLASS,
  PeopleEmptyRow,
  PeopleFilterButton,
  PeopleFilterChips,
  PeopleFilterPanel,
  PeopleFilterSelect,
  PeopleKpiCards,
  PeopleRosterToolbar,
  PeopleRowActions,
  PersonNameCell,
  PersonStatusBadge,
  matchesPeopleStatus,
} from "@/pages/factory/people/PeopleRoster";
import { PersonFormDialog } from "@/pages/factory/people/PersonFormDialog";
import { EmployeeFormFields, type EmployeeFormValues } from "@/pages/factory/people/EmployeeFormFields";
import {
  exportPeopleTableExcel,
  exportPeopleTablePdf,
  type PeopleExportColumn,
  type PeopleExportSpec,
} from "@/pages/factory/people/peopleExport";

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
  if (Number.isNaN(n)) return formatUsd(0, 0);
  return n % 1 === 0 ? formatUsd(n, 0) : formatUsd(n, 2);
}

export default function FactoryEmployees() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const { selectedCompany } = useCompany();
  const recordChanges = useExistingRecordChangeAccess();

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("Active");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [departmentFilter, setDepartmentFilter] = useState("all");
  const [exportBusy, setExportBusy] = useState(false);
  const { formatDisplayDate } = useDateFormat();
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

  const {
    data: employeesData,
    isLoading,
    isError,
    refetch,
  } = useQuery<Employee[]>({
    queryKey: companyQueryKey("/api/factory/employees", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
    queryFn: async () => {
      const res = await factoryApiRequest("GET", "/api/factory/employees");
      if (!res.ok) throw new Error("Failed to fetch employees");
      return res.json();
    },
  });
  const employees = employeesData ?? [];

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
      const matchesStatus = matchesPeopleStatus(statusFilter, e.active);
      const matchesDepartment = departmentFilter === "all" || (e.department || "") === departmentFilter;
      return matchesSearch && matchesStatus && matchesDepartment;
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

  const departments = Array.from(
    new Set(employees.map((e) => e.department || "").filter((department) => department.trim() !== ""))
  ).sort((left, right) => left.localeCompare(right));
  const activeFilterCount = departmentFilter !== "all" ? 1 : 0;
  const clearFilters = () => setDepartmentFilter("all");

  const exportSpec = (): PeopleExportSpec<Employee> => {
    const columns: PeopleExportColumn<Employee>[] = [
      { header: "#", type: "integer", width: 6, value: (_e, index) => index + 1 },
      { header: "Code", width: 14, value: (e) => e.code ?? "" },
      { header: "Name", width: 30, value: (e) => `${e.firstName} ${e.lastName}` },
      { header: "Department", value: (e) => e.department ?? "" },
      { header: "Phone", value: (e) => e.phone ?? "" },
      {
        header: "Join Date",
        width: 14,
        value: (e) => (e.joinDate ? formatDisplayDate(new Date(e.joinDate)) : ""),
      },
      { header: "Monthly Salary", type: "money", value: (e) => parseFloat(e.monthlySalary || "0") || 0 },
      { header: "Balance", type: "money", value: (e) => parseFloat(e.currentBalance || "0") || 0 },
      { header: "Status", width: 12, value: (e) => (e.active ? "Active" : "Inactive") },
    ];
    const salaryTotal = filtered.reduce((sum, e) => sum + (parseFloat(e.monthlySalary || "0") || 0), 0);
    const balanceTotal = filtered.reduce((sum, e) => sum + (parseFloat(e.currentBalance || "0") || 0), 0);
    return {
      title: "Factory Employees",
      fileStem: "factory employees",
      columns,
      rows: filtered,
      footer: [null, "", `Total Employees: ${filtered.length}`, "", "", "", salaryTotal, balanceTotal, ""],
    };
  };
  const runExport = async (format: "excel" | "pdf") => {
    setExportBusy(true);
    try {
      if (format === "excel") await exportPeopleTableExcel(exportSpec());
      else await exportPeopleTablePdf(exportSpec());
    } catch (error) {
      toast({
        title: "Export failed",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setExportBusy(false);
    }
  };

  const canCreateEmployee = recordChanges.canCreate("POST", "/api/factory/employees");
  const closeForm = () => {
    setCreateOpen(false);
    setEditingEmployee(null);
  };

  return (
    <div className="space-y-5 pb-6">
      {/* Visual summary only: all payroll amounts still come from the existing calculations. */}
      <PeopleKpiCards
        loading={isLoading}
        data-testid="employees-summary"
        cards={[
          { label: "Total", value: String(employees.length), icon: Users },
          { label: "Active", value: String(totalActive), icon: UserCheck2 },
          { label: "Inactive", value: String(totalInactive), icon: UserMinus },
          { label: "Monthly Payroll", value: fmt(totalMonthlySalary), icon: DollarSign, emphasis: true },
        ]}
      />

      <PeopleRosterToolbar
        searchPlaceholder="Search by name or code..."
        search={search}
        onSearchChange={setSearch}
        status={statusFilter}
        onStatusChange={setStatusFilter}
        exportOptions={[
          {
            id: "excel",
            label: "Excel",
            kind: "excel",
            onSelect: () => runExport("excel"),
            disabled: !filtered.length,
            testId: "button-export-employees-excel",
          },
          {
            id: "pdf",
            label: "PDF",
            kind: "pdf",
            onSelect: () => runExport("pdf"),
            disabled: !filtered.length,
            testId: "button-export-employees-pdf",
          },
        ]}
        exportBusy={exportBusy}
        addLabel="Add Employee"
        onAdd={canCreateEmployee ? openCreate : undefined}
        searchTestId="input-employee-search"
        statusTestId="select-employee-status"
        addTestId="button-create-employee"
      >
        <PeopleFilterButton
          open={filtersOpen}
          onToggle={() => setFiltersOpen((open) => !open)}
          activeCount={activeFilterCount}
          onClear={clearFilters}
        />
      </PeopleRosterToolbar>

      {filtersOpen && (
        <PeopleFilterPanel>
          <PeopleFilterSelect
            label="Department"
            value={departmentFilter}
            onChange={setDepartmentFilter}
            allLabel="All departments"
            options={departments.map((value) => ({ value, label: value }))}
            testId="select-employee-department"
          />
        </PeopleFilterPanel>
      )}

      <PeopleFilterChips
        chips={
          departmentFilter !== "all"
            ? [{ key: "department", label: "Department", value: departmentFilter, onRemove: clearFilters }]
            : []
        }
        resultCount={filtered.length}
      />

      {/* Table */}
      <div
        data-horizontal-scroll="true"
        className="overflow-x-auto rounded-xl border border-border/70 bg-card/70 shadow-sm"
      >
        <Table mobileLayout="cards" wrapperClassName="overflow-visible" className="w-full md:min-w-[52rem]">
          <TableHeader className="sticky top-0 z-30">
            <TableRow className="border-b border-border/70 bg-muted/65 hover:bg-muted/65">
              <TableHead className={`w-10 pl-3 pr-1 text-center ${PEOPLE_TABLE_HEAD_CLASS}`}>#</TableHead>
              <TableHead className={PEOPLE_TABLE_HEAD_CLASS}>Employee</TableHead>
              <TableHead className={PEOPLE_TABLE_HEAD_CLASS}>Department</TableHead>
              <TableHead className={PEOPLE_TABLE_HEAD_CLASS}>Phone</TableHead>
              <TableHead className={`text-right ${PEOPLE_TABLE_HEAD_CLASS}`}>Monthly Salary</TableHead>
              <TableHead className={`text-right ${PEOPLE_TABLE_HEAD_CLASS}`}>Balance</TableHead>
              <TableHead className={`w-[96px] ${PEOPLE_TABLE_HEAD_CLASS}`}>Status</TableHead>
              <TableHead className="w-[104px] py-2">
                <span className="sr-only">Employee actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              [...Array(6)].map((_, i) => (
                <TableRow key={i}>
                  <TableCell className="pl-3 pr-1">
                    <Skeleton className="mx-auto h-4 w-5" />
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <Skeleton className="h-8 w-8 rounded-full" />
                      <Skeleton className="h-4 w-36" />
                    </div>
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-4 w-20" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-4 w-20" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="ml-auto h-4 w-20" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="ml-auto h-4 w-20" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-5 w-16 rounded-full" />
                  </TableCell>
                  <TableCell></TableCell>
                </TableRow>
              ))
            ) : isError && !employeesData ? (
              <TableRow>
                <TableCell colSpan={8}>
                  <ErrorState onAction={() => void refetch()} actionLabel="Try again" className="border-0" />
                </TableCell>
              </TableRow>
            ) : filtered.length === 0 ? (
              <PeopleEmptyRow
                colSpan={8}
                title="No employees found"
                hint={
                  search || statusFilter !== "All" || activeFilterCount > 0
                    ? "Try adjusting your search or filters"
                    : "Add your first employee to get started"
                }
              />
            ) : (
              filtered.map((emp, idx) => {
                const fullName = `${emp.firstName} ${emp.lastName}`;
                const balance = parseFloat(emp.currentBalance || "0");
                return (
                  <TableRow
                    key={emp.id}
                    className="group cursor-pointer transition-colors hover:bg-primary/5"
                    onClick={() => navigate(`/factory/employees/${emp.id}`)}
                    data-testid={`row-employee-${emp.id}`}
                  >
                    <TableCell className="py-3 pl-3 pr-1 text-center font-mono text-xs tabular-nums text-muted-foreground">
                      {idx + 1}
                    </TableCell>
                    <TableCell className="py-3">
                      <PersonNameCell name={fullName} code={emp.code} testIdSuffix={`employee-${emp.id}`} />
                    </TableCell>
                    <TableCell className="py-3 text-sm text-muted-foreground">
                      {emp.department || <span className="text-muted-foreground/40">—</span>}
                    </TableCell>
                    <TableCell className="py-3 text-sm text-muted-foreground">
                      {emp.phone || <span className="text-muted-foreground/40">—</span>}
                    </TableCell>
                    <TableCell className="py-3 text-right font-mono text-sm tabular-nums text-muted-foreground">
                      {fmt(emp.monthlySalary)}
                    </TableCell>
                    <TableCell className="py-3 text-right">
                      <span
                        className={`font-mono text-sm font-semibold tabular-nums ${
                          balance < 0 ? "text-destructive" : "text-emerald-600 dark:text-emerald-400"
                        }`}
                      >
                        {fmt(emp.currentBalance)}
                      </span>
                    </TableCell>
                    <TableCell className="py-3">
                      <PersonStatusBadge active={emp.active} data-testid={`badge-status-employee-${emp.id}`} />
                    </TableCell>
                    <TableCell className="py-3">
                      {recordChanges.allowed && (
                        <PeopleRowActions
                          active={emp.active}
                          onEdit={() => openEdit(emp)}
                          onEndContract={() => setEndingContractEmployee(emp)}
                          onReactivate={() => reactivateMutation.mutate(emp.id)}
                          reactivating={reactivateMutation.isPending}
                          testIdSuffix={{
                            edit: `button-edit-employee-${emp.id}`,
                            end: `button-end-contract-${emp.id}`,
                            reactivate: `button-reactivate-${emp.id}`,
                          }}
                        />
                      )}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      <PersonFormDialog
        open={createOpen || !!editingEmployee}
        onOpenChange={(open) => {
          if (!open) closeForm();
        }}
        title={editingEmployee ? "Edit Employee" : "Add Employee"}
        description={editingEmployee ? "Update employee details" : "Fill in the employee details below"}
        onSave={() => {
          if (editingEmployee) {
            updateMutation.mutate({ id: editingEmployee.id, data: formData });
          } else {
            createMutation.mutate(formData);
          }
        }}
        saving={createMutation.isPending || updateMutation.isPending}
        canSave={editingEmployee ? recordChanges.allowed : canCreateEmployee}
        testIds={{ dialog: "dialog-employee-form", cancel: "button-cancel", save: "button-save" }}
      >
        {/* The code is set once on create; editing still sends the stored code unchanged. */}
        <EmployeeFormFields
          values={editingEmployee ? { ...formData, code: undefined } : formData}
          onChange={(key: keyof EmployeeFormValues, value: string) => handleField(key, value)}
        />
      </PersonFormDialog>

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
              const fmtBal = (v: number) => formatUsd(v, 2);
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
                        Outstanding balance: {fmtBal(balance)}
                      </div>
                      <p className="text-xs text-amber-700/80 dark:text-amber-400/80 leading-relaxed">
                        Running payroll records salary as <em>earned</em> — it doesn't mean cash was handed out. To
                        clear this balance, go to <strong>Withdrawals</strong> and record a cash payment of{" "}
                        {fmtBal(balance)} before ending the contract.
                      </p>
                    </div>
                  ) : balance < 0 ? (
                    <div className="rounded-md border border-red-300 bg-red-50 dark:bg-red-900/20 dark:border-red-700 p-3 space-y-1.5">
                      <div className="flex items-center gap-2 text-red-700 dark:text-red-400 font-medium text-sm">
                        <AlertTriangle className="h-4 w-4 shrink-0" />
                        Employee owes: {fmtBal(Math.abs(balance))}
                      </div>
                      <p className="text-xs text-red-700/80 dark:text-red-400/80">
                        This employee has a negative balance — they owe the company {fmtBal(Math.abs(balance))}. Collect
                        this before ending the contract if needed.
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
