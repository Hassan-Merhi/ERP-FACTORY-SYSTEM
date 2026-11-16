// Extracted from ./usePayrollModel.tsx to keep that module under the source-size cap.
import { useEffect, useMemo } from "react";
import { useToast } from "@/hooks/use-toast";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { useCompany } from "@/contexts/CompanyContext";
import { useForm } from "react-hook-form";
import { zodResolver } from "@/lib/form-resolver";
import { useAppMode } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import { usePayrollState } from "./usePayrollState";
import { usePayrollData } from "./usePayrollData";
import { errorMessage } from "./payrollUtils";
import {
  type BulkPaymentFormData,
  bulkPaymentSchema,
  type DepositFormData,
  depositSchema,
  type EmployeeFormData,
  type WithdrawalFormData,
  withdrawalSchema,
  type WorkerFormData,
} from "./payrollSchemas";

export function usePayrollModelPart1() {
  const appMode = useAppMode();
  const modeApiRequest = getApiRequest(appMode);
  const { toast } = useToast();
  const { selectedCompany, companies } = useCompany();
  const recordChanges = useExistingRecordChangeAccess();
  const assertCanChangeRecords = () => {
    if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
  };
  const showError = (error: unknown) =>
    toast({ title: "Error", description: errorMessage(error), variant: "destructive" });

  const state = usePayrollState();
  const {
    empSearch,
    empStatusFilter,
    setDepositDialogOpen,
    setBonusDialogOpen,
    bonusTab,
    setBonusTab,
    bonusSalesPeriod,
    setBonusSalesPeriod,
    bonusSalesLocationId,
    setBonusSalesLocationId,
    bonusSalesStart,
    setBonusSalesStart,
    bonusSalesEnd,
    setBonusSalesEnd,
    bonusSalesPreview,
    setBonusSalesPreview,
    setBonusSalesLoading,
    bonusSalesCustomPct,
    setBonusSalesCustomPct,
    bonusDate,
    setBonusDate,
    bonusNotes,
    setBonusNotes,
    balesRows,
    setBalesRows,
    balesPeriod,
    setBalesPeriod,
    balesStart,
    balesEnd,
    setWithdrawalDialogOpen,
    setBulkPaymentDialogOpen,
    selectedEmployee,
    setSelectedEmployee,
    setNewWorkerDialogOpen,
    setEditWorkerDialogOpen,
    selectedWorkerForEdit,
    workerOverrides,
    setWorkerOverrides,
    setCreateEmployeeDialogOpen,
    deleteConflict,
    setDeleteConflict,
    deleteWorkerConflict,
    setDeleteWorkerConflict,
    statementEmployee,
    setStatementExpanded,
    setEditEmployeeDialogOpen,
    editingEmployee,
    setEditingEmployee,
    workerDeductionTarget,
    setWorkerDeductionTarget,
    workerDeductionAmount,
    setWorkerDeductionAmount,
    workerDeductionReason,
    setWorkerDeductionReason,
    workerDeductionDate,
    bulkDepositSelections,
    setBulkDepositSelections,
    bulkDepositAmounts,
    setBulkDepositAmounts,
    setBulkDepositDialogOpen,
    bulkDepositDate,
    bulkDepositNotes,
    editBaleRates,
    setEditBaleRates,
    editBalePctRates,
    setEditBalePctRates,
    bulkBonusAutoMonth,
    bulkBonusAutoStart,
    bulkBonusAutoEnd,
    setBulkBonusAutoLoading,
    bulkBonusAutoPctLocationId,
    setBulkBonusDialogOpen,
    bulkBonusDate,
    bulkBonusNotes,
    bulkBonusAmounts,
    setBulkBonusAmounts,
    bulkBonusBreakdowns,
    setBulkBonusBreakdowns,
    setBulkBonusStep,
    pendingBonuses,
    setPendingBonuses,
    setBulkWithdrawalDialogOpen,
    bulkWithdrawalDate,
    bulkWithdrawalNotes,
    bulkWithdrawalAmounts,
    setBulkWithdrawalAmounts,
    bulkWithdrawalAccountType,
    bulkWithdrawalAccountId,
    newGroupName,
    setNewGroupName,
    newGroupDescription,
    setNewGroupDescription,
    setCreateGroupDialogOpen,
    selectedGroupForMembers,
  } = state;

  const data = usePayrollData({
    selectedCompany,
    companies,
    statementEmployee,
    workerOverrides,
    empSearch,
    empStatusFilter,
  });
  const { locations, allCompanyLocations, employeeStaff, workerPayments, selectedPayments } = data;
  const employeeGroups = useMemo(
    () => data.employeeGroups.filter((group) => group.groupType !== "Worker"),
    [data.employeeGroups]
  );

  // Forms
  const depositForm = useForm<DepositFormData>({ resolver: zodResolver(depositSchema) });
  const withdrawalForm = useForm<WithdrawalFormData>({ resolver: zodResolver(withdrawalSchema) });
  const bulkPaymentForm = useForm<BulkPaymentFormData>({ resolver: zodResolver(bulkPaymentSchema) });
  const newWorkerForm = useForm<WorkerFormData>();
  const editWorkerForm = useForm<WorkerFormData>();

  // Pre-populate edit worker form when a worker is selected for editing
  useEffect(() => {
    if (selectedWorkerForEdit) {
      editWorkerForm.reset({
        firstName: selectedWorkerForEdit.firstName ?? "",
        lastName: selectedWorkerForEdit.lastName ?? "",
        code: selectedWorkerForEdit.code ?? "",
        monthlySalary: selectedWorkerForEdit.monthlySalary ?? "",
        department: selectedWorkerForEdit.department ?? "",
        active: selectedWorkerForEdit.active ?? true,
      });
    }
  }, [editWorkerForm, selectedWorkerForEdit]);
  const createEmployeeForm = useForm<EmployeeFormData>();
  const editEmployeeForm = useForm<EmployeeFormData>();

  // Reset statementExpanded whenever a new employee statement is opened
  useEffect(() => {
    if (statementEmployee) setStatementExpanded(false);
  }, [setStatementExpanded, statementEmployee]);
  return {
    allCompanyLocations,
    assertCanChangeRecords,
    balesEnd,
    balesPeriod,
    balesRows,
    balesStart,
    bonusDate,
    bonusNotes,
    bonusSalesCustomPct,
    bonusSalesEnd,
    bonusSalesLocationId,
    bonusSalesPeriod,
    bonusSalesPreview,
    bonusSalesStart,
    bonusTab,
    bulkBonusAmounts,
    bulkBonusAutoEnd,
    bulkBonusAutoMonth,
    bulkBonusAutoPctLocationId,
    bulkBonusAutoStart,
    bulkBonusBreakdowns,
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
    createEmployeeForm,
    data,
    deleteConflict,
    deleteWorkerConflict,
    depositForm,
    editBalePctRates,
    editBaleRates,
    editEmployeeForm,
    editWorkerForm,
    editingEmployee,
    employeeGroups,
    employeeStaff,
    locations,
    modeApiRequest,
    newGroupDescription,
    newGroupName,
    newWorkerForm,
    pendingBonuses,
    recordChanges,
    selectedCompany,
    selectedEmployee,
    selectedGroupForMembers,
    selectedPayments,
    selectedWorkerForEdit,
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
    setBulkBonusAmounts,
    setBulkBonusAutoLoading,
    setBulkBonusBreakdowns,
    setBulkBonusDialogOpen,
    setBulkBonusStep,
    setBulkDepositAmounts,
    setBulkDepositDialogOpen,
    setBulkDepositSelections,
    setBulkPaymentDialogOpen,
    setBulkWithdrawalAmounts,
    setBulkWithdrawalDialogOpen,
    setCreateEmployeeDialogOpen,
    setCreateGroupDialogOpen,
    setDeleteConflict,
    setDeleteWorkerConflict,
    setDepositDialogOpen,
    setEditBalePctRates,
    setEditBaleRates,
    setEditEmployeeDialogOpen,
    setEditWorkerDialogOpen,
    setEditingEmployee,
    setNewGroupDescription,
    setNewGroupName,
    setNewWorkerDialogOpen,
    setPendingBonuses,
    setSelectedEmployee,
    setWithdrawalDialogOpen,
    setWorkerDeductionAmount,
    setWorkerDeductionReason,
    setWorkerDeductionTarget,
    setWorkerOverrides,
    showError,
    state,
    toast,
    withdrawalForm,
    workerDeductionAmount,
    workerDeductionDate,
    workerDeductionReason,
    workerDeductionTarget,
    workerPayments,
  };
}
