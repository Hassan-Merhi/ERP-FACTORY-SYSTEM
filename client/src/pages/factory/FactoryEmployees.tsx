import { searchAny } from "@shared/searchNormalization";
import { Users, DollarSign, UserCheck2, UserMinus } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ErrorState } from "@/components/ui/page-state";
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
import { emptyForm, fmt, useFactoryEmployeesState, type Employee } from "./useFactoryEmployeesState";
import {
  FactoryEmployeesDialogSection,
  FactoryEmployeesDialogSection2,
  FactoryEmployeesDialogSection3,
} from "./FactoryEmployeesDialogSection";

export default function FactoryEmployees() {
  const {
    departmentFilter,
    exportBusy,
    filtersOpen,
    setDepartmentFilter,
    setExportBusy,
    setFiltersOpen,
    toast,
    refetch,
    isError,
    employeesData,
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
  const { formatDisplayDate } = useDateFormat();

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
