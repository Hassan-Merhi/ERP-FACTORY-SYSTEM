import { confirmAction } from "@/components/ConfirmHost";
import { useMutation } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { queryClient } from "@/lib/queryClient";
import { getApiRequest } from "@/lib/factoryApi";
import type { Employee } from "@shared/schema";
import { errorMessage } from "./payrollUtils";
import type { WorkerFormData } from "./payrollSchemas";
import type { EmployeeDeleteConflict } from "./payrollTypes";

interface UsePayrollWorkerMutationsArgs {
  modeApiRequest: ReturnType<typeof getApiRequest>;
  selectedCompanyId: number | undefined;
  setWorkerOverrides: (
    updater: (
      previous: Record<number, { selected?: boolean; amount?: string; manuallyEdited?: boolean }>
    ) => Record<number, { selected?: boolean; amount?: string; manuallyEdited?: boolean }>
  ) => void;
  setNewWorkerDialogOpen: (open: boolean) => void;
  newWorkerForm: { reset: () => void };
  selectedWorkerForEdit: Employee | null;
  setEditWorkerDialogOpen: (open: boolean) => void;
  deleteWorkerConflict: EmployeeDeleteConflict | null;
  setDeleteWorkerConflict: (conflict: EmployeeDeleteConflict | null) => void;
}

// Extracted from usePayrollModel to keep that hook under the repository's
// god-file line-count ceiling. Behavior is unchanged.
export function usePayrollWorkerMutations({
  modeApiRequest,
  selectedCompanyId,
  setWorkerOverrides,
  setNewWorkerDialogOpen,
  newWorkerForm,
  selectedWorkerForEdit,
  setEditWorkerDialogOpen,
  deleteWorkerConflict,
  setDeleteWorkerConflict,
}: UsePayrollWorkerMutationsArgs) {
  const { toast } = useToast();
  const recordChanges = useExistingRecordChangeAccess();
  // The toast title names the action that failed ("Save failed", "Delete failed", ...).
  const showError = (title: string) => (error: unknown) =>
    toast({ title, description: errorMessage(error), variant: "destructive" });

  const handleToggleWorker = (id: number) => {
    setWorkerOverrides((previous) => ({
      ...previous,
      [id]: { ...previous[id], selected: !previous[id]?.selected },
    }));
  };

  const handleUpdateAmount = (id: number, val: string) => {
    setWorkerOverrides((previous) => ({
      ...previous,
      [id]: { ...previous[id], amount: val, manuallyEdited: true },
    }));
  };

  const handleDeleteWorker = async (worker: Employee) => {
    if (!recordChanges.allowed) return;
    if (await confirmAction({ title: `Delete worker ${worker.firstName} ${worker.lastName}?`, tone: "destructive" })) {
      modeApiRequest("DELETE", `/api/employees/${worker.id}`, undefined)
        .then(() => {
          toast({ title: "Deleted", description: "Worker deleted" });
          queryClient.invalidateQueries({ queryKey: ["/api/employees", selectedCompanyId] });
        })
        .catch(showError("Delete failed"));
    }
  };

  const createWorkerMutation = useMutation({
    mutationFn: async (data: WorkerFormData & { joinDate?: string }) =>
      modeApiRequest("POST", "/api/employees", {
        ...data,
        companyId: selectedCompanyId,
        employeeType: "Worker",
        joinDate: data.joinDate || new Date().toLocaleDateString("en-CA"),
      }),
    onSuccess: () => {
      toast({ title: "Worker created" });
      queryClient.invalidateQueries({ queryKey: ["/api/employees", selectedCompanyId] });
      setNewWorkerDialogOpen(false);
      newWorkerForm.reset();
    },
    onError: showError("Save failed"),
  });

  const updateWorkerMutation = useMutation({
    mutationFn: async (data: WorkerFormData) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      if (!selectedWorkerForEdit) throw new Error("No worker selected");
      return modeApiRequest("PATCH", `/api/employees/${selectedWorkerForEdit.id}`, data);
    },
    onSuccess: () => {
      toast({ title: "Worker updated" });
      queryClient.invalidateQueries({ queryKey: ["/api/employees", selectedCompanyId] });
      setEditWorkerDialogOpen(false);
    },
    onError: showError("Update failed"),
  });

  const handleForceDeleteWorker = () => {
    if (!deleteWorkerConflict || !recordChanges.allowed) return;
    modeApiRequest("DELETE", `/api/employees/${deleteWorkerConflict.employee.id}?force=true`, undefined)
      .then(() => {
        toast({ title: "Deleted", description: "Worker force-deleted" });
        queryClient.invalidateQueries({ queryKey: ["/api/employees", selectedCompanyId] });
        setDeleteWorkerConflict(null);
      })
      .catch(showError("Delete failed"));
  };

  return {
    canChangeExistingRecords: recordChanges.allowed,
    handleToggleWorker,
    handleUpdateAmount,
    handleDeleteWorker,
    createWorkerMutation,
    updateWorkerMutation,
    handleForceDeleteWorker,
  };
}
