// Extracted from ./WorkerDialogs.tsx
import type { usePayrollModel } from "./usePayrollModel";
import type { Employee } from "@shared/schema";

type PayrollModel = ReturnType<typeof usePayrollModel>;

export interface WorkerDialogsProps {
  newWorkerDialogOpen: boolean;
  setNewWorkerDialogOpen: (open: boolean) => void;
  newWorkerForm: PayrollModel["newWorkerForm"];
  createWorkerMutation: PayrollModel["createWorkerMutation"];
  editWorkerDialogOpen: boolean;
  setEditWorkerDialogOpen: (open: boolean) => void;
  selectedWorkerForEdit: PayrollModel["selectedWorkerForEdit"];
  editWorkerForm: PayrollModel["editWorkerForm"];
  updateWorkerMutation: PayrollModel["updateWorkerMutation"];
  deleteWorkerConflict: PayrollModel["deleteWorkerConflict"];
  setDeleteWorkerConflict: PayrollModel["setDeleteWorkerConflict"];
  handleForceDeleteWorker: () => void;
  createWorkerGroupDialogOpen: boolean;
  setCreateWorkerGroupDialogOpen: (open: boolean) => void;
  workerGroupMembersDialogOpen: boolean;
  setWorkerGroupMembersDialogOpen: (open: boolean) => void;
  selectedWorkerGroupForMembers: PayrollModel["selectedWorkerGroupForMembers"];
  allWorkerGroups: PayrollModel["workerGroupsData"];
  allWorkers: Employee[];
  addWorkerToWorkerGroupMutation: PayrollModel["addWorkerToWorkerGroupMutation"];
  removeWorkerFromWorkerGroupMutation: PayrollModel["removeWorkerFromWorkerGroupMutation"];
}
