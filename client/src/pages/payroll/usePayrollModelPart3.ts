// Extracted from ./usePayrollModel.tsx to keep that module under the source-size cap.
import { useMutation } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import type { BulkPaymentFormData } from "./payrollSchemas";
import { usePayrollModelPart1 } from "./usePayrollModelPart1";
import { usePayrollModelPart7 } from "./usePayrollModelPart7";

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
  const {
    saveBonusToPending,
    submitSmartBonus,
    handleSelectAllEmployees,
    handleToggleEmployeeDeposit,
    validSelectedEmployees,
    bulkDepositTotal,
    bulkDepositMutation,
    bulkWithdrawalMutation,
  } = usePayrollModelPart7({
    allCompanyLocations,
    assertCanChangeRecords,
    balesRows,
    bonusDate,
    bonusNotes,
    bonusSalesCustomPct,
    bonusSalesPreview,
    bonusTab,
    bulkDepositAmounts,
    bulkDepositDate,
    bulkDepositNotes,
    bulkDepositSelections,
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
    setBonusDialogOpen,
    setBulkDepositAmounts,
    setBulkDepositDialogOpen,
    setBulkDepositSelections,
    setBulkWithdrawalAmounts,
    setBulkWithdrawalDialogOpen,
    setPendingBonuses,
    showError,
    toast,
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
