// Extracted from ./usePayrollModel.tsx to keep that module under the source-size cap.
import { confirmAction } from "@/components/ConfirmHost";
import { useMutation } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import type { Employee } from "@shared/schema";
import { usePayrollGroupMutations } from "./usePayrollGroupMutations";
import { usePayrollWorkerMutations } from "./usePayrollWorkerMutations";
import { decodeLocationOption } from "./payrollUtils";
import { type EmployeeFormData, getThisMonthRange } from "./payrollSchemas";
import { usePayrollModelPart1 } from "./usePayrollModelPart1";

export function usePayrollModelPart4({
  assertCanChangeRecords,
  bulkBonusAmounts,
  bulkBonusAutoEnd,
  bulkBonusAutoMonth,
  bulkBonusAutoPctLocationId,
  bulkBonusAutoStart,
  bulkBonusBreakdowns,
  bulkBonusDate,
  bulkBonusNotes,
  createEmployeeForm,
  deleteConflict,
  deleteWorkerConflict,
  editBalePctRates,
  editBaleRates,
  editingEmployee,
  employeeGroups,
  employeeStaff,
  modeApiRequest,
  newGroupDescription,
  newGroupName,
  newWorkerForm,
  pendingBonuses,
  recordChanges,
  selectedCompany,
  selectedGroupForMembers,
  selectedWorkerForEdit,
  setBulkBonusAmounts,
  setBulkBonusAutoLoading,
  setBulkBonusBreakdowns,
  setCreateEmployeeDialogOpen,
  setCreateGroupDialogOpen,
  setDeleteConflict,
  setDeleteWorkerConflict,
  setEditEmployeeDialogOpen,
  setEditWorkerDialogOpen,
  setEditingEmployee,
  setNewGroupDescription,
  setNewGroupName,
  setNewWorkerDialogOpen,
  setWorkerOverrides,
  showError,
  toast,
}: Pick<
  Awaited<ReturnType<typeof usePayrollModelPart1>>,
  | "assertCanChangeRecords"
  | "bulkBonusAmounts"
  | "bulkBonusAutoEnd"
  | "bulkBonusAutoMonth"
  | "bulkBonusAutoPctLocationId"
  | "bulkBonusAutoStart"
  | "bulkBonusBreakdowns"
  | "bulkBonusDate"
  | "bulkBonusNotes"
  | "createEmployeeForm"
  | "deleteConflict"
  | "deleteWorkerConflict"
  | "editBalePctRates"
  | "editBaleRates"
  | "editingEmployee"
  | "employeeGroups"
  | "employeeStaff"
  | "modeApiRequest"
  | "newGroupDescription"
  | "newGroupName"
  | "newWorkerForm"
  | "pendingBonuses"
  | "recordChanges"
  | "selectedCompany"
  | "selectedGroupForMembers"
  | "selectedWorkerForEdit"
  | "setBulkBonusAmounts"
  | "setBulkBonusAutoLoading"
  | "setBulkBonusBreakdowns"
  | "setCreateEmployeeDialogOpen"
  | "setCreateGroupDialogOpen"
  | "setDeleteConflict"
  | "setDeleteWorkerConflict"
  | "setEditEmployeeDialogOpen"
  | "setEditWorkerDialogOpen"
  | "setEditingEmployee"
  | "setNewGroupDescription"
  | "setNewGroupName"
  | "setNewWorkerDialogOpen"
  | "setWorkerOverrides"
  | "showError"
  | "toast"
>) {
  const autoCalculateBonuses = async () => {
    setBulkBonusAutoLoading(true);
    try {
      const range =
        bulkBonusAutoMonth === "thisMonth" ? getThisMonthRange() : { start: bulkBonusAutoStart, end: bulkBonusAutoEnd };

      // The picker stores "locationId:companyId" so the % bonus is computed from
      // the sales of the company that sells at the location, which is not always
      // the company that owns the location row (GC-LSHI).
      const { locationId: pctLocationId, sourceCompanyId: pctSourceCompanyId } =
        decodeLocationOption(bulkBonusAutoPctLocationId);
      const res = await modeApiRequest("POST", "/api/payroll/auto-calculate-bonuses", {
        startDate: range.start,
        endDate: range.end,
        pctLocationId: pctLocationId || null,
        pctSourceCompanyId: pctSourceCompanyId || null,
      });
      const { results } = (await res.json()) as {
        results: Array<{ employeeId: number; amount: string; breakdown: string[] }>;
      };

      const amounts: Record<number, string> = { ...bulkBonusAmounts };
      const breakdowns: Record<number, string[]> = { ...bulkBonusBreakdowns };

      for (const r of results) {
        if (parseFloat(r.amount) > 0) {
          amounts[r.employeeId] = r.amount;
          breakdowns[r.employeeId] = r.breakdown;
        }
      }

      setBulkBonusAmounts(amounts);
      setBulkBonusBreakdowns(breakdowns);
      const calculatedCount = results.filter((r) => parseFloat(r.amount) > 0).length;
      if (calculatedCount === 0) {
        toast({
          title: "Nothing calculated",
          description:
            "No sales found for the configured locations in this date range. Check the date range, the saved bonus rates, and the Sales % location selection.",
          variant: "destructive",
        });
      } else {
        toast({
          title: "Done",
          description: `Bonuses calculated for ${calculatedCount} employee${calculatedCount !== 1 ? "s" : ""}`,
        });
      }
    } catch (error: unknown) {
      showError(error);
    } finally {
      setBulkBonusAutoLoading(false);
    }
  };

  const handlePrintBulkBonus = () => {
    const rows = employeeStaff
      .filter((emp) => parseFloat(bulkBonusAmounts[emp.id] || "0") > 0)
      .map((emp) => {
        const pending = pendingBonuses[emp.id];
        const amount = parseFloat(bulkBonusAmounts[emp.id] || "0");
        return `${emp.firstName} ${emp.lastName}: $${amount.toFixed(2)}${pending?.description ? ` — ${pending.description}` : ""}`;
      });
    const total = employeeStaff.reduce((s, e) => s + parseFloat(bulkBonusAmounts[e.id] || "0"), 0);
    const win = window.open("", "_blank");
    if (!win) return;
    win.document.write(`
      <html><head><title>Bulk Bonus — ${bulkBonusDate}</title>
      <style>body{font-family:sans-serif;padding:24px}h2{margin-bottom:8px}ul{list-style:none;padding:0}li{padding:6px 0;border-bottom:1px solid #eee}.total{font-weight:bold;margin-top:12px}</style>
      </head><body>
      <h2>Bulk Bonus Deposit</h2>
      <p>Date: ${bulkBonusDate}${bulkBonusNotes ? ` &nbsp;·&nbsp; ${bulkBonusNotes}` : ""}</p>
      <ul>${rows.map((r) => `<li>${r}</li>`).join("")}</ul>
      <p class="total">Total: $${total.toFixed(2)}</p>
      </body></html>
    `);
    win.document.close();
    win.print();
  };

  const handleDeleteEmployee = async (emp: Employee) => {
    if (!recordChanges.allowed) return;
    if (await confirmAction({ title: `Are you sure you want to delete ${emp.firstName}?`, tone: "destructive" })) {
      modeApiRequest("DELETE", `/api/employees/${emp.id}`, undefined)
        .then(() => {
          toast({ title: "Deleted", description: "Employee deleted" });
          queryClient.invalidateQueries({ queryKey: ["/api/employees", selectedCompany?.id] });
        })
        .catch(showError);
    }
  };

  const handleForceDeleteEmployee = () => {
    if (!deleteConflict || !recordChanges.allowed) return;
    modeApiRequest("DELETE", `/api/employees/${deleteConflict.employee.id}?force=true`, undefined)
      .then(() => {
        toast({ title: "Deleted", description: "Employee force-deleted" });
        queryClient.invalidateQueries({ queryKey: ["/api/employees", selectedCompany?.id] });
        setDeleteConflict(null);
      })
      .catch(showError);
  };

  const editEmployeeMutation = useMutation({
    mutationFn: async (data: EmployeeFormData) => {
      assertCanChangeRecords();
      if (!editingEmployee) throw new Error("No employee selected");
      const { employeeGroupId, ...employeeDetails } = data;

      // employeeGroupId is not a column on employees; membership is stored in
      // employee_group_members. Sending it through the employee PATCH caused
      // the entire details update to fail at the database layer.
      await modeApiRequest("PATCH", `/api/employees/${editingEmployee.id}`, employeeDetails);

      const baleRates = editBaleRates
        .filter((row) => row.locationId && row.rate)
        .map((row) => ({
          locationId: parseInt(row.locationId),
          rate: parseFloat(row.rate),
          sourceCompanyId: row.sourceCompanyId ? parseInt(row.sourceCompanyId) : null,
        }));
      const balePctRates = editBalePctRates
        .filter((row) => row.locationId && row.pct)
        .map((row) => ({
          locationId: parseInt(row.locationId),
          pct: parseFloat(row.pct),
          sourceCompanyId: row.sourceCompanyId ? parseInt(row.sourceCompanyId) : null,
        }));

      // These endpoints expect an object containing `rates`. Using the shared
      // request helper also makes a failed rate save reject the mutation instead
      // of closing the dialog and falsely reporting success.
      await modeApiRequest("PUT", `/api/employees/${editingEmployee.id}/bale-rates`, { rates: baleRates });
      await modeApiRequest("PUT", `/api/employees/${editingEmployee.id}/bale-pct-rates`, { rates: balePctRates });

      // The employee editor models one employee group. Remove stale membership
      // from employee groups, then add the selected group when one is chosen.
      await Promise.all(
        employeeGroups.map((group) =>
          modeApiRequest("DELETE", `/api/employee-groups/${group.id}/members/${editingEmployee.id}`, undefined)
        )
      );
      if (employeeGroupId && employeeGroupId !== "none") {
        const groupId = Number(employeeGroupId);
        if (!Number.isInteger(groupId) || !employeeGroups.some((group) => group.id === groupId)) {
          throw new Error("Invalid employee group");
        }
        await modeApiRequest("POST", `/api/employee-groups/${groupId}/members/${editingEmployee.id}`, undefined);
      }
    },
    onSuccess: () => {
      toast({ title: "Employee updated", description: "All employee details were saved successfully." });
      queryClient.invalidateQueries({ queryKey: ["/api/employees", selectedCompany?.id] });
      setEditEmployeeDialogOpen(false);
      setEditingEmployee(null);
    },
    onError: showError,
  });

  const createEmployeeMutation = useMutation({
    mutationFn: async (data: EmployeeFormData) =>
      modeApiRequest("POST", "/api/employees", {
        ...data,
        companyId: selectedCompany?.id,
        employeeType: "Employee",
      }),
    onSuccess: () => {
      toast({ title: "Employee created" });
      queryClient.invalidateQueries({ queryKey: ["/api/employees", selectedCompany?.id] });
      setCreateEmployeeDialogOpen(false);
      createEmployeeForm.reset();
    },
    onError: showError,
  });

  const {
    createGroupMutation,
    groupMembers,
    addWorkerToGroupMutation,
    removeWorkerFromGroupMutation,
    deleteWorkerGroupMutation,
    addWorkerToWorkerGroupMutation,
    removeWorkerFromWorkerGroupMutation,
  } = usePayrollGroupMutations({
    modeApiRequest,
    selectedCompanyId: selectedCompany?.id,
    newGroupName,
    newGroupDescription,
    setCreateGroupDialogOpen,
    setNewGroupName,
    setNewGroupDescription,
    selectedGroupForMembers,
  });

  const {
    handleToggleWorker,
    handleUpdateAmount,
    handleDeleteWorker,
    createWorkerMutation,
    updateWorkerMutation,
    handleForceDeleteWorker,
  } = usePayrollWorkerMutations({
    modeApiRequest,
    selectedCompanyId: selectedCompany?.id,
    setWorkerOverrides,
    setNewWorkerDialogOpen,
    newWorkerForm,
    selectedWorkerForEdit,
    setEditWorkerDialogOpen,
    deleteWorkerConflict,
    setDeleteWorkerConflict,
  });
  return {
    addWorkerToGroupMutation,
    addWorkerToWorkerGroupMutation,
    autoCalculateBonuses,
    createEmployeeMutation,
    createGroupMutation,
    createWorkerMutation,
    deleteWorkerGroupMutation,
    editEmployeeMutation,
    groupMembers,
    handleDeleteEmployee,
    handleDeleteWorker,
    handleForceDeleteEmployee,
    handleForceDeleteWorker,
    handlePrintBulkBonus,
    handleToggleWorker,
    handleUpdateAmount,
    removeWorkerFromGroupMutation,
    removeWorkerFromWorkerGroupMutation,
    updateWorkerMutation,
  };
}
