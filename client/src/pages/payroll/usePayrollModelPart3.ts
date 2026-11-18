// Extracted from ./usePayrollModel.tsx to keep that module under the source-size cap.
import { useMemo } from "react";
import { useMutation } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import type { Employee } from "@shared/schema";
import type { BulkPaymentFormData } from "./payrollSchemas";
import { usePayrollModelPart1 } from "./usePayrollModelPart1";

export function usePayrollModelPart3({
  allCompanyLocations,
  assertCanChangeRecords,
  balesRows,
  bonusDate,
  bonusNotes,
  bonusSalesCustomPct,
  bonusSalesPreview,
  bonusTab,
  bulkBonusAmounts,
  bulkBonusDate,
  bulkBonusNotes,
  bulkDepositAmounts,
  bulkDepositDate,
  bulkDepositNotes,
  bulkDepositSelections,
  bulkPaymentForm,
  bulkWithdrawalAccountId,
  bulkWithdrawalAccountType,
  bulkWithdrawalAmounts,
  bulkWithdrawalDate,
  bulkWithdrawalNotes,
  employeeStaff,
  locations,
  modeApiRequest,
  selectedCompany,
  selectedEmployee,
  selectedPayments,
  setBonusDialogOpen,
  setBulkBonusAmounts,
  setBulkBonusBreakdowns,
  setBulkBonusDialogOpen,
  setBulkBonusStep,
  setBulkDepositAmounts,
  setBulkDepositDialogOpen,
  setBulkDepositSelections,
  setBulkPaymentDialogOpen,
  setBulkWithdrawalAmounts,
  setBulkWithdrawalDialogOpen,
  setPendingBonuses,
  setWorkerOverrides,
  showError,
  toast,
  workerPayments,
}: Pick<
  Awaited<ReturnType<typeof usePayrollModelPart1>>,
  | "allCompanyLocations"
  | "assertCanChangeRecords"
  | "balesRows"
  | "bonusDate"
  | "bonusNotes"
  | "bonusSalesCustomPct"
  | "bonusSalesPreview"
  | "bonusTab"
  | "bulkBonusAmounts"
  | "bulkBonusDate"
  | "bulkBonusNotes"
  | "bulkDepositAmounts"
  | "bulkDepositDate"
  | "bulkDepositNotes"
  | "bulkDepositSelections"
  | "bulkPaymentForm"
  | "bulkWithdrawalAccountId"
  | "bulkWithdrawalAccountType"
  | "bulkWithdrawalAmounts"
  | "bulkWithdrawalDate"
  | "bulkWithdrawalNotes"
  | "employeeStaff"
  | "locations"
  | "modeApiRequest"
  | "selectedCompany"
  | "selectedEmployee"
  | "selectedPayments"
  | "setBonusDialogOpen"
  | "setBulkBonusAmounts"
  | "setBulkBonusBreakdowns"
  | "setBulkBonusDialogOpen"
  | "setBulkBonusStep"
  | "setBulkDepositAmounts"
  | "setBulkDepositDialogOpen"
  | "setBulkDepositSelections"
  | "setBulkPaymentDialogOpen"
  | "setBulkWithdrawalAmounts"
  | "setBulkWithdrawalDialogOpen"
  | "setPendingBonuses"
  | "setWorkerOverrides"
  | "showError"
  | "toast"
  | "workerPayments"
>) {
  const getBonusAmount = (): number => {
    if (bonusTab === "sales") {
      if (!bonusSalesPreview) return 0;
      return (parseFloat(bonusSalesPreview.totalSalesAmount || "0") * parseFloat(bonusSalesCustomPct || "0")) / 100;
    } else {
      return balesRows.reduce((sum, row) => sum + parseFloat(row.qty || "0") * parseFloat(row.rate || "0"), 0);
    }
  };

  const saveBonusToPending = () => {
    if (!selectedEmployee) return;
    const amount = getBonusAmount();
    if (amount <= 0) return;
    const descParts: string[] = [];
    if (bonusTab === "sales" && bonusSalesPreview) {
      descParts.push(`Sales bonus ${bonusSalesCustomPct}% on ${bonusSalesPreview.locationName}`);
    } else {
      balesRows
        .filter((row) => parseFloat(row.qty || "0") > 0 && parseFloat(row.rate || "0") > 0)
        .forEach((row) => {
          const loc =
            locations.find((location) => location.id === parseInt(row.locationId)) ??
            allCompanyLocations.find((location) => location.id === parseInt(row.locationId));
          descParts.push(`${parseFloat(row.qty)} bales @ ${row.rate} (${loc?.name ?? row.locationId})`);
        });
    }
    setPendingBonuses((previous) => ({
      ...previous,
      [selectedEmployee.id]: {
        amount,
        description: descParts.join(", ") || "Bonus",
        employeeName: `${selectedEmployee.firstName} ${selectedEmployee.lastName}`,
      },
    }));
    setBonusDialogOpen(false);
    toast({
      title: "Saved to bulk",
      description: `Bonus of ${amount.toFixed(2)} saved for ${selectedEmployee.firstName}`,
    });
  };

  const bonusMutation = useMutation({
    mutationFn: async ({ employeeId, amount }: { employeeId: number; amount: number }) => {
      assertCanChangeRecords();
      return await modeApiRequest("POST", "/api/payroll/bonus-employee", {
        employeeId,
        amount: amount.toFixed(2),
        date: bonusDate,
        notes: bonusNotes || "",
      });
    },
    onSuccess: () => {
      toast({ title: "Saved", description: "Bonus recorded successfully" });
      queryClient.invalidateQueries({ queryKey: ["/api/employees", selectedCompany?.id] });
      if (selectedEmployee)
        queryClient.invalidateQueries({ queryKey: ["/api/accounts/employee", selectedEmployee.id] });
      setBonusDialogOpen(false);
    },
    onError: showError("Save failed"),
  });

  const submitSmartBonus = () => {
    if (!selectedEmployee) return;
    const amount = getBonusAmount();
    if (amount <= 0) return;
    bonusMutation.mutate({ employeeId: selectedEmployee.id, amount });
  };

  // ── Bulk deposit helpers ─────────────────────────────────────────────────
  const getBulkDepositAmount = (employee: Employee): string =>
    bulkDepositAmounts[employee.id] ?? employee.monthlySalary ?? "";

  const handleSelectAllEmployees = (checked: boolean | "indeterminate") => {
    if (checked) {
      const all: Record<number, boolean> = {};
      const amounts: Record<number, string> = { ...bulkDepositAmounts };
      employeeStaff.forEach((e) => {
        all[e.id] = true;
        if (amounts[e.id] === undefined) amounts[e.id] = e.monthlySalary ?? "";
      });
      setBulkDepositSelections(all);
      setBulkDepositAmounts(amounts);
    } else {
      setBulkDepositSelections({});
    }
  };

  const handleToggleEmployeeDeposit = (id: number) => {
    const employee = employeeStaff.find((e) => e.id === id);
    setBulkDepositSelections((prev: Record<number, boolean>) => ({ ...prev, [id]: !prev[id] }));
    if (employee && bulkDepositAmounts[id] === undefined) {
      setBulkDepositAmounts((prev) => ({ ...prev, [id]: employee.monthlySalary ?? "" }));
    }
  };

  const validSelectedEmployees = useMemo(
    () =>
      employeeStaff.filter(
        (e) => bulkDepositSelections[e.id] && parseFloat(bulkDepositAmounts[e.id] ?? e.monthlySalary ?? "0") > 0
      ),
    [employeeStaff, bulkDepositSelections, bulkDepositAmounts]
  );

  const bulkDepositTotal = useMemo(
    () =>
      validSelectedEmployees.reduce(
        (sum, employee) => sum + parseFloat(bulkDepositAmounts[employee.id] ?? employee.monthlySalary ?? "0"),
        0
      ),
    [validSelectedEmployees, bulkDepositAmounts]
  );

  const bulkDepositMutation = useMutation({
    mutationFn: async () => {
      assertCanChangeRecords();
      const deposits = validSelectedEmployees.map((employee) => ({
        employeeId: employee.id,
        amount: getBulkDepositAmount(employee),
      }));
      return modeApiRequest("POST", "/api/payroll/bulk-deposit-employees", {
        deposits,
        date: bulkDepositDate,
        notes: bulkDepositNotes || "",
      });
    },
    onSuccess: () => {
      toast({ title: "Saved", description: `Deposited salary for ${validSelectedEmployees.length} employees` });
      queryClient.invalidateQueries({ queryKey: ["/api/employees", selectedCompany?.id] });
      setBulkDepositDialogOpen(false);
      setBulkDepositSelections({});
      setBulkDepositAmounts({});
    },
    onError: showError("Save failed"),
  });

  const bulkWithdrawalMutation = useMutation({
    mutationFn: async () => {
      assertCanChangeRecords();
      const withdrawals = Object.entries(bulkWithdrawalAmounts)
        .filter(([, amt]) => parseFloat(amt) > 0)
        .map(([empId, amount]) => ({ employeeId: parseInt(empId), amount }));
      return modeApiRequest("POST", "/api/payroll/bulk-withdraw-employees", {
        withdrawals,
        date: bulkWithdrawalDate,
        notes: bulkWithdrawalNotes || "",
        paymentAccountType: bulkWithdrawalAccountType,
        paymentAccountId: bulkWithdrawalAccountId,
      });
    },
    onSuccess: () => {
      const count = Object.values(bulkWithdrawalAmounts).filter((amt) => parseFloat(amt) > 0).length;
      toast({ title: "Saved", description: `Processed withdrawals for ${count} employees` });
      queryClient.invalidateQueries({ queryKey: ["/api/employees", selectedCompany?.id] });
      setBulkWithdrawalDialogOpen(false);
      setBulkWithdrawalAmounts({});
    },
    onError: showError("Save failed"),
  });

  const bulkBonusMutation = useMutation({
    mutationFn: async () => {
      assertCanChangeRecords();
      const bonuses = Object.entries(bulkBonusAmounts)
        .filter(([, amt]) => parseFloat(amt) > 0)
        .map(([empId, amount]) => ({ employeeId: parseInt(empId), amount }));
      return modeApiRequest("POST", "/api/payroll/bulk-bonus-employees", {
        bonuses,
        date: bulkBonusDate,
        notes: bulkBonusNotes || "",
      });
    },
    onSuccess: () => {
      const count = Object.values(bulkBonusAmounts).filter((amt) => parseFloat(amt) > 0).length;
      toast({ title: "Saved", description: `Bonus deposited for ${count} employees` });
      queryClient.invalidateQueries({ queryKey: ["/api/employees", selectedCompany?.id] });
      setBulkBonusDialogOpen(false);
      setBulkBonusAmounts({});
      setBulkBonusBreakdowns({});
      setPendingBonuses({});
      setBulkBonusStep("edit");
    },
    onError: showError("Save failed"),
  });

  const bulkPaymentMutation = useMutation({
    mutationFn: async (data: BulkPaymentFormData) => {
      assertCanChangeRecords();
      const payments = selectedPayments.map((w) => ({
        workerId: w.id,
        amount: workerPayments[w.id]?.amount || "0",
      }));
      return modeApiRequest("POST", "/api/payroll/bulk-pay-workers", {
        payments,
        paymentAccountType: data.paymentAccountType,
        paymentAccountId: data.paymentAccountId,
        date: data.date,
        notes: data.notes || "",
      });
    },
    onSuccess: () => {
      toast({ title: "Saved", description: `Paid ${selectedPayments.length} workers` });
      queryClient.invalidateQueries({ queryKey: ["/api/employees", selectedCompany?.id] });
      setBulkPaymentDialogOpen(false);
      bulkPaymentForm.reset();
      setWorkerOverrides({});
    },
    onError: showError("Save failed"),
  });
  return {
    bulkBonusMutation,
    bulkDepositMutation,
    bulkDepositTotal,
    bulkPaymentMutation,
    bulkWithdrawalMutation,
    handleSelectAllEmployees,
    handleToggleEmployeeDeposit,
    saveBonusToPending,
    submitSmartBonus,
    validSelectedEmployees,
  };
}
