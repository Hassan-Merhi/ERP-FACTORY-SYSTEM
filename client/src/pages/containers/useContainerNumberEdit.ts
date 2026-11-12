import type { ClientErrorLike } from "@/lib/clientError";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";

export function useContainerNumberEdit() {
  const { toast } = useToast();
  const recordChanges = useExistingRecordChangeAccess();
  const [editingNumberId, setEditingNumberId] = useState<number | null>(null);
  const [editingNumberValue, setEditingNumberValue] = useState("");

  const editContainerNumberMutation = useMutation({
    mutationFn: async ({ id, containerNumber }: { id: number; containerNumber: string }) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const res = await apiRequest("PATCH", `/api/containers/${id}/number`, { containerNumber });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message);
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/containers/active"] });
      queryClient.invalidateQueries({ queryKey: ["/api/containers/sold"] });
      setEditingNumberId(null);
      setEditingNumberValue("");
      toast({ title: "Updated", description: "Container number changed" });
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  return {
    editingNumberId,
    setEditingNumberId,
    editingNumberValue,
    setEditingNumberValue,
    editContainerNumberMutation,
    canChangeExistingRecords: recordChanges.allowed,
  };
}
