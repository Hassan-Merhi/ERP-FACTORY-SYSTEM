import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { InventoryLocation as Location } from "./locationInventoryTypes";

interface UseLocationInventoryMutationsParams {
  toast: (opts: { title: string; description?: string; variant?: "destructive" | "default" }) => void;
  selectedLocationLocal: Location | null;
  setSelectedLocationLocal: (loc: Location | null) => void;
  setRenameDialogOpen: (open: boolean) => void;
  setCreateLocationOpen: (open: boolean) => void;
  setCreateLocationName: (name: string) => void;
  setWaGroupDialogOpen: (open: boolean) => void;
}

export function useLocationInventoryMutations({
  toast,
  selectedLocationLocal,
  setSelectedLocationLocal,
  setRenameDialogOpen,
  setCreateLocationOpen,
  setCreateLocationName,
  setWaGroupDialogOpen,
}: UseLocationInventoryMutationsParams) {
  const renameLocationMutation = useMutation({
    mutationFn: async ({
      id,
      name,
      supplierPartnerPayableDeductionPerQty,
    }: {
      id: number;
      name: string;
      supplierPartnerPayableDeductionPerQty?: number;
    }) => {
      const payload: Record<string, unknown> = { name };
      if (supplierPartnerPayableDeductionPerQty !== undefined)
        payload.supplierPartnerPayableDeductionPerQty = supplierPartnerPayableDeductionPerQty;
      const res = await apiRequest("PATCH", `/api/locations/${id}`, payload);
      return res.json();
    },
    onSuccess: (updated) => {
      toast({ title: "Location renamed", description: `Renamed to "${updated.name}".` });
      queryClient.invalidateQueries({ queryKey: ["/api/locations"] });
      if (selectedLocationLocal?.id === updated.id) setSelectedLocationLocal(updated);
      setRenameDialogOpen(false);
    },
    onError: (error: Error) => toast({ title: "Error", description: error.message, variant: "destructive" }),
  });

  const createLocationMutation = useMutation({
    mutationFn: async (name: string) => {
      const res = await apiRequest("POST", "/api/locations", { name });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Location created" });
      queryClient.invalidateQueries({ queryKey: ["/api/locations"] });
      setCreateLocationOpen(false);
      setCreateLocationName("");
    },
    onError: (error: Error) => toast({ title: "Error", description: error.message, variant: "destructive" }),
  });

  const waGroupMutation = useMutation({
    mutationFn: async ({
      id,
      whatsappGroupChatId,
      enabled,
    }: {
      id: number;
      whatsappGroupChatId: string | null;
      enabled: boolean;
    }) => {
      const res = await apiRequest("PUT", `/api/locations/${id}/whatsapp-settings`, {
        whatsappGroupChatId,
        enabled,
      });
      return res.json();
    },
    onSuccess: (updated) => {
      const linked = Boolean(updated.whatsappGroupChatId);
      const reportEnabled = linked && updated.whatsappStockReportsEnabled === true;
      toast({
        title: linked ? "WhatsApp settings saved" : "WhatsApp group removed",
        description: linked
          ? `${updated.whatsappGroupName || "WhatsApp group"} is ${reportEnabled ? "enabled" : "linked but disabled"} for location stock reports.`
          : "This location no longer has a WhatsApp stock-report group.",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/locations"] });
      if (selectedLocationLocal?.id === updated.id) setSelectedLocationLocal(updated);
      setWaGroupDialogOpen(false);
    },
    onError: (error: Error) => toast({ title: "Error", description: error.message, variant: "destructive" }),
  });

  const waTestMutation = useMutation({
    mutationFn: async ({ id, whatsappGroupChatId }: { id: number; whatsappGroupChatId: string | null }) => {
      const res = await apiRequest("POST", `/api/locations/${id}/whatsapp-test`, { whatsappGroupChatId });
      return res.json();
    },
    onSuccess: (result) => {
      toast({ title: "WhatsApp test sent", description: result.message });
    },
    onError: (error: Error) =>
      toast({ title: "WhatsApp test failed", description: error.message, variant: "destructive" }),
  });

  return { renameLocationMutation, createLocationMutation, waGroupMutation, waTestMutation };
}
