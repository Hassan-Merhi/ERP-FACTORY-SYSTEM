// Extracted from ./usePayrollModel.tsx to keep that module under the source-size cap.
import { useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import type { Employee } from "@shared/schema";
import { decodeLocationOption, errorMessage } from "./payrollUtils";
import type { BaleRateResponse, SalesPreview } from "./payrollTypes";
import { type DepositFormData, getThisMonthRange, type WithdrawalFormData } from "./payrollSchemas";
import { usePayrollModelPart1 } from "./usePayrollModelPart1";

export function usePayrollModelPart2({
  assertCanChangeRecords,
  balesEnd,
  balesPeriod,
  balesRows,
  balesStart,
  bonusSalesEnd,
  bonusSalesLocationId,
  bonusSalesPeriod,
  bonusSalesStart,
  depositForm,
  editEmployeeForm,
  editingEmployee,
  employeeGroups,
  modeApiRequest,
  selectedCompany,
  selectedEmployee,
  setBalesPeriod,
  setBalesRows,
  setBonusDate,
  setBonusDialogOpen,
  setBonusNotes,
  setBonusSalesCustomPct,
  setBonusSalesEnd,
  setBonusSalesLoading,
  setBonusSalesLocationId,
  setBonusSalesPeriod,
  setBonusSalesPreview,
  setBonusSalesStart,
  setBonusTab,
  setDepositDialogOpen,
  setEditBalePctRates,
  setEditBaleRates,
  setSelectedEmployee,
  setWithdrawalDialogOpen,
  showError,
  toast,
  withdrawalForm,
}: Pick<
  Awaited<ReturnType<typeof usePayrollModelPart1>>,
  | "assertCanChangeRecords"
  | "balesEnd"
  | "balesPeriod"
  | "balesRows"
  | "balesStart"
  | "bonusSalesEnd"
  | "bonusSalesLocationId"
  | "bonusSalesPeriod"
  | "bonusSalesStart"
  | "depositForm"
  | "editEmployeeForm"
  | "editingEmployee"
  | "employeeGroups"
  | "modeApiRequest"
  | "selectedCompany"
  | "selectedEmployee"
  | "setBalesPeriod"
  | "setBalesRows"
  | "setBonusDate"
  | "setBonusDialogOpen"
  | "setBonusNotes"
  | "setBonusSalesCustomPct"
  | "setBonusSalesEnd"
  | "setBonusSalesLoading"
  | "setBonusSalesLocationId"
  | "setBonusSalesPeriod"
  | "setBonusSalesPreview"
  | "setBonusSalesStart"
  | "setBonusTab"
  | "setDepositDialogOpen"
  | "setEditBalePctRates"
  | "setEditBaleRates"
  | "setSelectedEmployee"
  | "setWithdrawalDialogOpen"
  | "showError"
  | "toast"
  | "withdrawalForm"
>) {
  // Pre-populate every editable employee field so opening the dialog never
  // replaces persisted values with react-hook-form defaults on save.
  useEffect(() => {
    if (!editingEmployee) return;
    let cancelled = false;

    editEmployeeForm.reset({
      firstName: editingEmployee.firstName ?? "",
      lastName: editingEmployee.lastName ?? "",
      code: editingEmployee.code ?? "",
      monthlySalary: editingEmployee.monthlySalary ?? "0",
      department: editingEmployee.department ?? "",
      joinDate: editingEmployee.joinDate ? String(editingEmployee.joinDate).slice(0, 10) : "",
      active: editingEmployee.active ?? true,
      employeeGroupId: "none",
      salesBonusPct:
        editingEmployee.salesBonusPct !== null && editingEmployee.salesBonusPct !== undefined
          ? String(editingEmployee.salesBonusPct)
          : "",
      salesBonusPctLocationId:
        editingEmployee.salesBonusPctLocationId !== null && editingEmployee.salesBonusPctLocationId !== undefined
          ? String(editingEmployee.salesBonusPctLocationId)
          : "",
      salesBonusPctSourceCompanyId:
        editingEmployee.salesBonusPctSourceCompanyId !== null &&
        editingEmployee.salesBonusPctSourceCompanyId !== undefined
          ? String(editingEmployee.salesBonusPctSourceCompanyId)
          : "",
    });

    // Employee group membership lives in employee_group_members rather than on
    // the employees row. Resolve the selected employee's current group through
    // the existing group-members API so the edit dropdown reflects saved data.
    void Promise.all(
      employeeGroups.map(async (group) => {
        const response = await fetch(`/api/employee-groups/${group.id}/members`, { credentials: "include" });
        if (!response.ok) return null;
        const members = (await response.json()) as Array<{ employeeId?: number | null }>;
        return members.some((member) => member.employeeId === editingEmployee.id) ? group.id : null;
      })
    )
      .then((groupIds) => {
        if (cancelled) return;
        const groupId = groupIds.find((value): value is number => value !== null);
        editEmployeeForm.setValue("employeeGroupId", groupId ? String(groupId) : "none");
      })
      .catch(() => {
        if (!cancelled) editEmployeeForm.setValue("employeeGroupId", "none");
      });

    // Load bale rates
    fetch(`/api/employees/${editingEmployee.id}/bale-rates`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : []))
      .then((rateRows: BaleRateResponse[]) => {
        if (cancelled) return;
        setEditBaleRates(
          rateRows.map((rateRow) => ({
            locationId: String(rateRow.locationId),
            rate: String(rateRow.rate),
            sourceCompanyId: rateRow.sourceCompanyId ? String(rateRow.sourceCompanyId) : "",
          }))
        );
      })
      .catch(() => {
        if (!cancelled) setEditBaleRates([]);
      });

    // Load pct rates
    fetch(`/api/employees/${editingEmployee.id}/bale-pct-rates`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : []))
      .then((rateRows: BaleRateResponse[]) => {
        if (cancelled) return;
        setEditBalePctRates(
          rateRows.map((rateRow) => ({
            locationId: String(rateRow.locationId),
            pct: String(rateRow.pct),
            sourceCompanyId: rateRow.sourceCompanyId ? String(rateRow.sourceCompanyId) : "",
          }))
        );
      })
      .catch(() => {
        if (!cancelled) setEditBalePctRates([]);
      });

    return () => {
      cancelled = true;
    };
  }, [editEmployeeForm, editingEmployee, employeeGroups, setEditBalePctRates, setEditBaleRates]);

  // Mutations (Logic simplified for orchestrator)
  const depositMutation = useMutation({
    mutationFn: async (data: DepositFormData) => {
      assertCanChangeRecords();
      if (!selectedEmployee) throw new Error("No employee selected");
      return await modeApiRequest("POST", "/api/payroll/deposit-employee", {
        employeeId: selectedEmployee.id,
        amount: data.amount,
        date: data.date,
        notes: data.notes || "",
      });
    },
    onSuccess: () => {
      toast({ title: "Success", description: "Deposit recorded successfully" });
      queryClient.invalidateQueries({ queryKey: ["/api/employees", selectedCompany?.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/accounts/employee", selectedEmployee?.id] });
      setDepositDialogOpen(false);
      depositForm.reset();
    },
  });

  const withdrawalMutation = useMutation({
    mutationFn: async (data: WithdrawalFormData) => {
      assertCanChangeRecords();
      if (!selectedEmployee) throw new Error("No employee selected");
      return await modeApiRequest("POST", "/api/payroll/withdraw-employee", {
        employeeId: selectedEmployee.id,
        amount: data.amount,
        paymentAccountType: data.paymentAccountType,
        paymentAccountId: data.paymentAccountId,
        date: data.date,
        notes: data.notes || "",
      });
    },
    onSuccess: () => {
      toast({ title: "Success", description: "Withdrawal recorded successfully" });
      queryClient.invalidateQueries({ queryKey: ["/api/employees", selectedCompany?.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/accounts/employee", selectedEmployee?.id] });
      setWithdrawalDialogOpen(false);
      withdrawalForm.reset();
    },
  });

  // Handlers
  const handleDeposit = (emp: Employee) => {
    setSelectedEmployee(emp);
    depositForm.reset({ amount: emp.monthlySalary || "", date: new Date().toLocaleDateString("en-CA"), notes: "" });
    setDepositDialogOpen(true);
  };

  const handleWithdrawal = (emp: Employee) => {
    setSelectedEmployee(emp);
    withdrawalForm.reset({
      amount: "",
      paymentAccountType: "cash",
      paymentAccountId: "",
      date: new Date().toLocaleDateString("en-CA"),
      notes: "",
    });
    setWithdrawalDialogOpen(true);
  };

  const handleBonus = (emp: Employee) => {
    setSelectedEmployee(emp);
    setBonusTab("sales");
    setBonusSalesPreview(null);
    setBonusSalesCustomPct(emp.salesBonusPct ? String(emp.salesBonusPct) : "");
    setBonusSalesLocationId(emp.salesBonusPctLocationId ? String(emp.salesBonusPctLocationId) : "");
    setBonusSalesPeriod("thisMonth");
    setBonusSalesStart("");
    setBonusSalesEnd("");
    setBalesRows([
      {
        locationId: "",
        sourceCompanyId: "",
        qty: "",
        rate: emp.balesBonusRate != null ? String(emp.balesBonusRate) : "",
        preview: null,
        loading: false,
      },
    ]);
    setBalesPeriod("thisMonth");
    setBonusDate(new Date().toLocaleDateString("en-CA"));
    setBonusNotes("");
    setBonusDialogOpen(true);
  };

  const fetchSalesPreview = async () => {
    if (!bonusSalesLocationId) return;
    setBonusSalesLoading(true);
    setBonusSalesPreview(null);
    try {
      const range =
        bonusSalesPeriod === "thisMonth" ? getThisMonthRange() : { start: bonusSalesStart, end: bonusSalesEnd };
      const { locationId, sourceCompanyId } = decodeLocationOption(bonusSalesLocationId);
      const sourceParam = sourceCompanyId ? `&sourceCompanyId=${sourceCompanyId}` : "";
      const res = await fetch(
        `/api/payroll/sales-summary?locationId=${locationId}&startDate=${range.start}&endDate=${range.end}${sourceParam}`,
        { credentials: "include" }
      );
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as SalesPreview;
      setBonusSalesPreview(data);
    } catch (error: unknown) {
      showError(error);
    } finally {
      setBonusSalesLoading(false);
    }
  };

  const fetchBalesQty = async (idx: number) => {
    const row = balesRows[idx];
    if (!row.locationId) return;
    setBalesRows((previous) => previous.map((row, index) => (index === idx ? { ...row, loading: true } : row)));
    try {
      const range = balesPeriod === "thisMonth" ? getThisMonthRange() : { start: balesStart, end: balesEnd };
      const sourceParam = row.sourceCompanyId ? `&sourceCompanyId=${row.sourceCompanyId}` : "";
      const res = await fetch(
        `/api/payroll/sales-summary?locationId=${row.locationId}&startDate=${range.start}&endDate=${range.end}${sourceParam}`,
        { credentials: "include" }
      );
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as SalesPreview;
      setBalesRows((previous) =>
        previous.map((row, index) => (index === idx ? { ...row, qty: data.totalQuantity, loading: false } : row))
      );
    } catch (error: unknown) {
      setBalesRows((previous) => previous.map((row, index) => (index === idx ? { ...row, loading: false } : row)));
      toast({ title: "Error fetching qty", description: errorMessage(error), variant: "destructive" });
    }
  };
  return {
    depositMutation,
    fetchBalesQty,
    fetchSalesPreview,
    handleBonus,
    handleDeposit,
    handleWithdrawal,
    withdrawalMutation,
  };
}
