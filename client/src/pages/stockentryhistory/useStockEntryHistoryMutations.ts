import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

interface StockEntryHistoryMutationsInput {
  fromActive: boolean;
  fromDate: string;
  today: string;
  setEditingDateKey: (key: string | null) => void;
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function wasHandledGlobally(error: unknown) {
  return typeof error === "object" && error !== null && "_handledGlobally" in error;
}

export function useStockEntryHistoryMutations({
  fromActive,
  fromDate,
  today,
  setEditingDateKey,
}: StockEntryHistoryMutationsInput) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const updateDateMutation = useMutation({
    mutationFn: async ({ ids, stockEntryDate }: { ids: number[]; stockEntryDate: string }) => {
      const response = await apiRequest("PATCH", "/api/factory/bales/bulk-date", { ids, stockEntryDate });
      return response.json();
    },
    onSuccess: (_, variables) => {
      toast({ title: "Date updated", description: `Updated date for ${variables.ids.length} bale(s).` });
      setEditingDateKey(null);
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bales/stock-entry-history"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bales"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bale-stock-list"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/stock-entry/in-stock"] });
    },
    onError: (error: unknown) => {
      toast({ title: "Update failed", description: errorMessage(error, "Update failed"), variant: "destructive" });
    },
  });

  const bulkAssignMutation = useMutation({
    mutationFn: async ({ baleIds, workerId }: { baleIds: number[]; workerId: number }) => {
      const response = await apiRequest("PATCH", "/api/factory/bales/bulk-assign-worker", { baleIds, workerId });
      return response.json();
    },
    onSuccess: (_, variables) => {
      toast({ title: "Worker assigned", description: `Worker updated for ${variables.baleIds.length} bale(s).` });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bales/stock-entry-history"] });
    },
    onError: (error: unknown) => {
      toast({
        title: "Assignment failed",
        description: errorMessage(error, "Assignment failed"),
        variant: "destructive",
      });
    },
  });

  const sendWorkerPdfWaMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/factory/bales/send-worker-pdf-whatsapp", {
        date: fromActive ? fromDate : today,
      });
      if (!response.ok) {
        const body: { message?: string } = await response.json();
        throw new Error(body.message || "Send failed");
      }
      return response.json();
    },
    onSuccess: () => {
      toast({ title: "Sent", description: "Worker PDF sent to production WhatsApp group." });
    },
    onError: (error: unknown) => {
      if (wasHandledGlobally(error)) return;
      toast({ title: "Send failed", description: errorMessage(error, "Send failed"), variant: "destructive" });
    },
  });

  return { updateDateMutation, bulkAssignMutation, sendWorkerPdfWaMutation };
}
