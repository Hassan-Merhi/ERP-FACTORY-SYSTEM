// Extracted from ./EmployeesTab.tsx
import type { Employee } from "@shared/schema";
import type { EmployeeGroup } from "./payrollTypes";

export interface EmployeesTabProps {
  empSearch: string;
  setEmpSearch: (val: string) => void;
  empStatusFilter: string;
  setEmpStatusFilter: (val: string) => void;
  setCreateEmployeeDialogOpen: (val: boolean) => void;
  employeeStaff: (Employee & { calculatedBalance: string })[];
  filteredEmployeeStaff: (Employee & { calculatedBalance: string })[];
  employeeGroups: EmployeeGroup[];
  setCreateGroupDialogOpen: (val: boolean) => void;
  setSelectedGroupForMembers: (group: EmployeeGroup | null) => void;
  setGroupMembersDialogOpen: (val: boolean) => void;
  pendingBonuses: Record<number, { amount: number; description: string; employeeName: string }>;
  setBulkDepositSelections: (val: Record<number, boolean>) => void;
  setBulkDepositAmounts: (val: Record<number, string>) => void;
  setBulkDepositDialogOpen: (val: boolean) => void;
  setBulkBonusAmounts: (val: Record<number, string>) => void;
  setBulkBonusStep: (val: "edit" | "preview") => void;
  setBulkBonusDialogOpen: (val: boolean) => void;
  setBulkWithdrawalAmounts: (val: Record<number, string>) => void;
  setBulkWithdrawalAccountId: (val: string) => void;
  setBulkWithdrawalDialogOpen: (val: boolean) => void;
  setStatementEmployee: (val: (Employee & { calculatedBalance?: string }) | null) => void;
  handleDeposit: (emp: Employee) => void;
  handleBonus: (emp: Employee) => void;
  handleWithdrawal: (emp: Employee) => void;
  setEditingEmployee: (emp: Employee | null) => void;
  setEditEmployeeDialogOpen: (val: boolean) => void;
  handleDeleteEmployee: (emp: Employee) => void;
  /** False for View Only and Create Only: hide controls that change existing records. */
  canChangeExistingRecords: boolean;
  canCreate: (method: string, path: string) => boolean;
}
