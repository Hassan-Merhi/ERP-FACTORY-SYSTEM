import { useState } from "react";
import type { Employee } from "@shared/schema";
import { getThisMonthRange, type SalaryAdvance } from "./payrollSchemas";
import type { BaleBonusRow, EmployeeDeleteConflict, EmployeeGroup, SalesPreview, WorkerGroup } from "./payrollTypes";

export function usePayrollState() {
  const [selectedTab, setSelectedTab] = useState("employees");

  // Shared state for dialogs
  const [empSearch, setEmpSearch] = useState("");
  const [empStatusFilter, setEmpStatusFilter] = useState("Active");
  const [depositDialogOpen, setDepositDialogOpen] = useState(false);
  const [bonusDialogOpen, setBonusDialogOpen] = useState(false);
  const [bonusTab, setBonusTab] = useState<"sales" | "bales">("sales");
  const [bonusSalesPeriod, setBonusSalesPeriod] = useState<"thisMonth" | "custom">("thisMonth");
  const [bonusSalesLocationId, setBonusSalesLocationId] = useState<string>("");
  const [bonusSalesStart, setBonusSalesStart] = useState<string>("");
  const [bonusSalesEnd, setBonusSalesEnd] = useState<string>("");
  const [bonusSalesPreview, setBonusSalesPreview] = useState<SalesPreview | null>(null);
  const [bonusSalesLoading, setBonusSalesLoading] = useState(false);
  const [bonusSalesCustomPct, setBonusSalesCustomPct] = useState<string>("");
  const [bonusDate, setBonusDate] = useState<string>(new Date().toLocaleDateString("en-CA"));
  const [bonusNotes, setBonusNotes] = useState<string>("");
  const [balesRows, setBalesRows] = useState<BaleBonusRow[]>([
    { locationId: "", sourceCompanyId: "", qty: "", rate: "", preview: null, loading: false },
  ]);
  const [balesPeriod, setBalesPeriod] = useState<"thisMonth" | "custom">("thisMonth");
  const [balesStart, setBalesStart] = useState<string>("");
  const [balesEnd, setBalesEnd] = useState<string>("");
  const [withdrawalDialogOpen, setWithdrawalDialogOpen] = useState(false);
  const [bulkPaymentDialogOpen, setBulkPaymentDialogOpen] = useState(false);
  const [advanceDialogOpen, setAdvanceDialogOpen] = useState(false);
  const [advanceWorkerComboOpen, setAdvanceWorkerComboOpen] = useState(false);
  const [advanceToDelete, setAdvanceToDelete] = useState<number | null>(null);
  const [deductionDialogOpen, setDeductionDialogOpen] = useState(false);
  const [selectedEmployee, setSelectedEmployee] = useState<Employee | null>(null);
  const [selectedAdvance, setSelectedAdvance] = useState<SalaryAdvance | null>(null);
  const [newWorkerDialogOpen, setNewWorkerDialogOpen] = useState(false);
  const [editWorkerDialogOpen, setEditWorkerDialogOpen] = useState(false);
  const [selectedWorkerForEdit, setSelectedWorkerForEdit] = useState<Employee | null>(null);
  const [workerOverrides, setWorkerOverrides] = useState<
    Record<number, { amount?: string; selected?: boolean; manuallyEdited?: boolean }>
  >({});
  const [createEmployeeDialogOpen, setCreateEmployeeDialogOpen] = useState(false);
  const [employeeToDelete, setEmployeeToDelete] = useState<Employee | null>(null);
  const [deleteConflict, setDeleteConflict] = useState<EmployeeDeleteConflict | null>(null);
  const [deleteWorkerConflict, setDeleteWorkerConflict] = useState<EmployeeDeleteConflict | null>(null);
  const [statementEmployee, setStatementEmployee] = useState<(Employee & { calculatedBalance?: string }) | null>(null);
  const [statementExpanded, setStatementExpanded] = useState(false);
  const [editEmployeeDialogOpen, setEditEmployeeDialogOpen] = useState(false);
  const [editingEmployee, setEditingEmployee] = useState<Employee | null>(null);
  const [workerDeductionTarget, setWorkerDeductionTarget] = useState<Employee | null>(null);
  const [workerDeductionAmount, setWorkerDeductionAmount] = useState("");
  const [workerDeductionReason, setWorkerDeductionReason] = useState("");
  const [workerDeductionDate, setWorkerDeductionDate] = useState(new Date().toLocaleDateString("en-CA"));
  const [bulkDepositSelections, setBulkDepositSelections] = useState<Record<number, boolean>>({});
  const [bulkDepositAmounts, setBulkDepositAmounts] = useState<Record<number, string>>({});
  const [bulkDepositDialogOpen, setBulkDepositDialogOpen] = useState(false);
  const [bulkDepositDate, setBulkDepositDate] = useState(new Date().toLocaleDateString("en-CA"));
  const [bulkDepositNotes, setBulkDepositNotes] = useState("");
  const [editBaleRates, setEditBaleRates] = useState<{ locationId: string; rate: string; sourceCompanyId: string }[]>(
    []
  );
  const [editBalePctRates, setEditBalePctRates] = useState<
    { locationId: string; pct: string; sourceCompanyId: string }[]
  >([]);
  const [bulkBonusAutoMonth, setBulkBonusAutoMonth] = useState<"thisMonth" | "custom">("thisMonth");
  const [bulkBonusAutoStart, setBulkBonusAutoStart] = useState(() => getThisMonthRange().start);
  const [bulkBonusAutoEnd, setBulkBonusAutoEnd] = useState(() => getThisMonthRange().end);
  const [bulkBonusAutoLoading, setBulkBonusAutoLoading] = useState(false);
  const [bulkBonusAutoPctLocationId, setBulkBonusAutoPctLocationId] = useState<string>("");
  const [bulkBonusDialogOpen, setBulkBonusDialogOpen] = useState(false);
  const [bulkBonusDate, setBulkBonusDate] = useState(new Date().toLocaleDateString("en-CA"));
  const [bulkBonusNotes, setBulkBonusNotes] = useState("");
  const [bulkBonusAmounts, setBulkBonusAmounts] = useState<Record<number, string>>({});
  const [bulkBonusBreakdowns, setBulkBonusBreakdowns] = useState<Record<number, string[]>>({});
  const [bulkBonusStep, setBulkBonusStep] = useState<"edit" | "preview">("edit");
  const [pendingBonuses, setPendingBonuses] = useState<
    Record<number, { amount: number; description: string; employeeName: string }>
  >({});
  const [bulkWithdrawalDialogOpen, setBulkWithdrawalDialogOpen] = useState(false);
  const [bulkWithdrawalDate, setBulkWithdrawalDate] = useState(new Date().toLocaleDateString("en-CA"));
  const [bulkWithdrawalNotes, setBulkWithdrawalNotes] = useState("");
  const [bulkWithdrawalAmounts, setBulkWithdrawalAmounts] = useState<Record<number, string>>({});
  const [bulkWithdrawalAccountType, setBulkWithdrawalAccountType] = useState<"bank" | "cash">("cash");
  const [bulkWithdrawalAccountId, setBulkWithdrawalAccountId] = useState("");
  const [newGroupName, setNewGroupName] = useState("");
  const [newGroupDescription, setNewGroupDescription] = useState("");
  const [createGroupDialogOpen, setCreateGroupDialogOpen] = useState(false);
  const [selectedGroupForMembers, setSelectedGroupForMembers] = useState<EmployeeGroup | null>(null);
  const [groupMembersDialogOpen, setGroupMembersDialogOpen] = useState(false);

  // Worker tab state
  const [workerGroupsExpanded, setWorkerGroupsExpanded] = useState<Record<number, boolean>>({});
  const [createWorkerGroupDialogOpen, setCreateWorkerGroupDialogOpen] = useState(false);
  const [selectedWorkerGroupForMembers, setSelectedWorkerGroupForMembers] = useState<WorkerGroup | null>(null);
  const [workerGroupMembersDialogOpen, setWorkerGroupMembersDialogOpen] = useState(false);
  const [workerGroupMemberSelections, setWorkerGroupMemberSelections] = useState<Record<number, boolean>>({});

  return {
    selectedTab,
    setSelectedTab,
    empSearch,
    setEmpSearch,
    empStatusFilter,
    setEmpStatusFilter,
    depositDialogOpen,
    setDepositDialogOpen,
    bonusDialogOpen,
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
    bonusSalesLoading,
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
    setBalesStart,
    balesEnd,
    setBalesEnd,
    withdrawalDialogOpen,
    setWithdrawalDialogOpen,
    bulkPaymentDialogOpen,
    setBulkPaymentDialogOpen,
    advanceDialogOpen,
    setAdvanceDialogOpen,
    advanceWorkerComboOpen,
    setAdvanceWorkerComboOpen,
    advanceToDelete,
    setAdvanceToDelete,
    deductionDialogOpen,
    setDeductionDialogOpen,
    selectedEmployee,
    setSelectedEmployee,
    selectedAdvance,
    setSelectedAdvance,
    newWorkerDialogOpen,
    setNewWorkerDialogOpen,
    editWorkerDialogOpen,
    setEditWorkerDialogOpen,
    selectedWorkerForEdit,
    setSelectedWorkerForEdit,
    workerOverrides,
    setWorkerOverrides,
    createEmployeeDialogOpen,
    setCreateEmployeeDialogOpen,
    employeeToDelete,
    setEmployeeToDelete,
    deleteConflict,
    setDeleteConflict,
    deleteWorkerConflict,
    setDeleteWorkerConflict,
    statementEmployee,
    setStatementEmployee,
    statementExpanded,
    setStatementExpanded,
    editEmployeeDialogOpen,
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
    setWorkerDeductionDate,
    bulkDepositSelections,
    setBulkDepositSelections,
    bulkDepositAmounts,
    setBulkDepositAmounts,
    bulkDepositDialogOpen,
    setBulkDepositDialogOpen,
    bulkDepositDate,
    setBulkDepositDate,
    bulkDepositNotes,
    setBulkDepositNotes,
    editBaleRates,
    setEditBaleRates,
    editBalePctRates,
    setEditBalePctRates,
    bulkBonusAutoMonth,
    setBulkBonusAutoMonth,
    bulkBonusAutoStart,
    setBulkBonusAutoStart,
    bulkBonusAutoEnd,
    setBulkBonusAutoEnd,
    bulkBonusAutoLoading,
    setBulkBonusAutoLoading,
    bulkBonusAutoPctLocationId,
    setBulkBonusAutoPctLocationId,
    bulkBonusDialogOpen,
    setBulkBonusDialogOpen,
    bulkBonusDate,
    setBulkBonusDate,
    bulkBonusNotes,
    setBulkBonusNotes,
    bulkBonusAmounts,
    setBulkBonusAmounts,
    bulkBonusBreakdowns,
    setBulkBonusBreakdowns,
    bulkBonusStep,
    setBulkBonusStep,
    pendingBonuses,
    setPendingBonuses,
    bulkWithdrawalDialogOpen,
    setBulkWithdrawalDialogOpen,
    bulkWithdrawalDate,
    setBulkWithdrawalDate,
    bulkWithdrawalNotes,
    setBulkWithdrawalNotes,
    bulkWithdrawalAmounts,
    setBulkWithdrawalAmounts,
    bulkWithdrawalAccountType,
    setBulkWithdrawalAccountType,
    bulkWithdrawalAccountId,
    setBulkWithdrawalAccountId,
    newGroupName,
    setNewGroupName,
    newGroupDescription,
    setNewGroupDescription,
    createGroupDialogOpen,
    setCreateGroupDialogOpen,
    selectedGroupForMembers,
    setSelectedGroupForMembers,
    groupMembersDialogOpen,
    setGroupMembersDialogOpen,
    workerGroupsExpanded,
    setWorkerGroupsExpanded,
    createWorkerGroupDialogOpen,
    setCreateWorkerGroupDialogOpen,
    selectedWorkerGroupForMembers,
    setSelectedWorkerGroupForMembers,
    workerGroupMembersDialogOpen,
    setWorkerGroupMembersDialogOpen,
    workerGroupMemberSelections,
    setWorkerGroupMemberSelections,
  };
}
