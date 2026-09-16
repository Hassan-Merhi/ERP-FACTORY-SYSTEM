import { useQuery, useMutation } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { getApiRequest } from "@/lib/factoryApi";
import type { Employee } from "@shared/schema";
import { errorMessage } from "./payrollUtils";
import type { EmployeeGroup } from "./payrollTypes";

interface UsePayrollGroupMutationsArgs {
  modeApiRequest: ReturnType<typeof getApiRequest>;
  selectedCompanyId: number | undefined;
  newGroupName: string;
  newGroupDescription: string;
  setCreateGroupDialogOpen: (open: boolean) => void;
  setNewGroupName: (value: string) => void;
  setNewGroupDescription: (value: string) => void;
  selectedGroupForMembers: EmployeeGroup | null;
}

// Extracted from usePayrollModel to keep that hook under the repository's
// god-file line-count ceiling. Behavior is unchanged — same queries,
// mutations and cache invalidations as before the split.
export function usePayrollGroupMutations({
  modeApiRequest,
  selectedCompanyId,
  newGroupName,
  newGroupDescription,
  setCreateGroupDialogOpen,
  setNewGroupName,
  setNewGroupDescription,
  selectedGroupForMembers,
}: UsePayrollGroupMutationsArgs) {
  const { toast } = useToast();
  const showError = (error: unknown) =>
    toast({ title: "Error", description: errorMessage(error), variant: "destructive" });

  const createGroupMutation = useMutation({
    mutationFn: async () =>
      modeApiRequest("POST", "/api/employee-groups", {
        name: newGroupName,
        description: newGroupDescription,
        companyId: selectedCompanyId,
      }),
    onSuccess: () => {
      toast({ title: "Group created" });
      queryClient.invalidateQueries({ queryKey: ["/api/employee-groups", selectedCompanyId] });
      setCreateGroupDialogOpen(false);
      setNewGroupName("");
      setNewGroupDescription("");
    },
    onError: showError,
  });

  const { data: groupMembers = [] } = useQuery<Employee[]>({
    queryKey: ["/api/employee-groups", selectedGroupForMembers?.id, "members"],
    queryFn: async () => {
      if (!selectedGroupForMembers) return [];
      const res = await fetch(`/api/employee-groups/${selectedGroupForMembers.id}/members`, {
        credentials: "include",
      });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!selectedGroupForMembers,
  });

  const addWorkerToGroupMutation = useMutation({
    mutationFn: async ({ groupId, employeeId }: { groupId: number; employeeId: number }) =>
      modeApiRequest("POST", `/api/employee-groups/${groupId}/members/${employeeId}`, undefined),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["/api/employee-groups", selectedGroupForMembers?.id, "members"],
      });
    },
    onError: showError,
  });

  const removeWorkerFromGroupMutation = useMutation({
    mutationFn: async ({ groupId, employeeId }: { groupId: number; employeeId: number }) =>
      modeApiRequest("DELETE", `/api/employee-groups/${groupId}/members/${employeeId}`, undefined),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["/api/employee-groups", selectedGroupForMembers?.id, "members"],
      });
    },
    onError: showError,
  });

  const deleteWorkerGroupMutation = useMutation({
    mutationFn: async (groupId: number) => modeApiRequest("DELETE", `/api/worker-groups/${groupId}`, undefined),
    onSuccess: () => {
      toast({ title: "Group deleted" });
      queryClient.invalidateQueries({ queryKey: ["/api/worker-groups/with-members", selectedCompanyId] });
    },
  });

  const addWorkerToWorkerGroupMutation = useMutation({
    mutationFn: async ({ groupId, workerId }: { groupId: number; workerId: number }) =>
      modeApiRequest("POST", `/api/worker-groups/${groupId}/members/${workerId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/worker-groups/with-members", selectedCompanyId] });
    },
  });

  const removeWorkerFromWorkerGroupMutation = useMutation({
    mutationFn: async ({ groupId, workerId }: { groupId: number; workerId: number }) =>
      modeApiRequest("DELETE", `/api/worker-groups/${groupId}/members/${workerId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/worker-groups/with-members", selectedCompanyId] });
    },
  });

  return {
    createGroupMutation,
    groupMembers,
    addWorkerToGroupMutation,
    removeWorkerFromGroupMutation,
    deleteWorkerGroupMutation,
    addWorkerToWorkerGroupMutation,
    removeWorkerFromWorkerGroupMutation,
  };
}
