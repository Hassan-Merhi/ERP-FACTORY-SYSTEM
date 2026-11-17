import { searchAny } from "@shared/searchNormalization";
import { Plus, Pencil, Users, UserX, UserCheck, DollarSign, UserCheck2, UserMinus } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  emptyForm,
  fmt,
  getAvatarColor,
  getInitials,
  useFactoryEmployeesState,
  type Employee,
} from "./useFactoryEmployeesState";
import {
  FactoryEmployeesDialogFooterSection,
  FactoryEmployeesDialogSection,
  FactoryEmployeesDialogSection2,
  FactoryEmployeesDialogSection3,
} from "./FactoryEmployeesDialogSection";
import { SearchField } from "@/components/ui/search-field";

export default function FactoryEmployees() {
  const {
    createMutation,
    createOpen,
    deactivateMutation,
    editingEmployee,
    employees,
    endingContractEmployee,
    formData,
    isLoading,
    navigate,
    reactivateMutation,
    recalcConfirmOpen,
    recalcMutation,
    recalcResult,
    recalcResultOpen,
    recordChanges,
    search,
    setCreateOpen,
    setEditingEmployee,
    setEndingContractEmployee,
    setFormData,
    setRecalcConfirmOpen,
    setRecalcResultOpen,
    setSearch,
    setStatusFilter,
    statusFilter,
    updateMutation,
  } = useFactoryEmployeesState();

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
        <SearchField
          placeholder="Search employees..."
          value={search}
          onValueChange={setSearch}
          wrapperClassName="min-w-[200px] flex-1"
          className="h-11 rounded-xl border-border/70 bg-card/80 shadow-sm focus-visible:ring-emerald-500/30"
          data-testid="input-employee-search"
        />
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
          <FactoryEmployeesDialogFooterSection
            createMutation={createMutation}
            editingEmployee={editingEmployee}
            formData={formData}
            recordChanges={recordChanges}
            setCreateOpen={setCreateOpen}
            setEditingEmployee={setEditingEmployee}
            updateMutation={updateMutation}
          />
        </DialogContent>
      </Dialog>

      {/* End Contract Confirmation Dialog */}
      <FactoryEmployeesDialogSection
        deactivateMutation={deactivateMutation}
        employees={employees}
        endingContractEmployee={endingContractEmployee}
        setEndingContractEmployee={setEndingContractEmployee}
      />

      {/* Recalculate Balances — Confirmation */}
      <FactoryEmployeesDialogSection3
        recalcConfirmOpen={recalcConfirmOpen}
        recalcMutation={recalcMutation}
        setRecalcConfirmOpen={setRecalcConfirmOpen}
      />

      {/* Recalculate Balances — Results */}
      <FactoryEmployeesDialogSection2
        recalcResult={recalcResult}
        recalcResultOpen={recalcResultOpen}
        setRecalcResultOpen={setRecalcResultOpen}
      />
    </div>
  );
}
