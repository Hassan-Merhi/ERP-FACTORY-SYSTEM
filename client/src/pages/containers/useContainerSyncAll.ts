import type { ClientErrorLike } from "@/lib/clientError";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { ContainerSyncAllResponse } from "./types";

export function useContainerSyncAll() {
  const { toast } = useToast();
  const [syncAllConfirmOpen, setSyncAllConfirmOpen] = useState(false);

  const syncAllMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/containers/sync-all-vouchers", {});
      return res.json() as Promise<ContainerSyncAllResponse>;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/containers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/containers/active"] });
      queryClient.invalidateQueries({ queryKey: ["/api/containers/sold"] });
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/daybook"] });
      queryClient.invalidateQueries({ queryKey: ["/api/purchase-orders"] });
      queryClient.invalidateQueries({ queryKey: ["/api/suppliers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/ledger-accounts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/accounts"] });
      const parts: string[] = [data?.message ?? "All POs and parent JVs have been checked."];
      if ((data?.updatedFreightVouchers ?? 0) > 0)
        parts.push(`Freight vouchers fixed: ${data.updatedFreightVouchers}.`);
      if ((data?.updatedContainerCharges ?? 0) > 0) parts.push(`Charge rows fixed: ${data.updatedContainerCharges}.`);
      if ((data?.notFoundParentVouchers?.length ?? 0) > 0)
        parts.push(
          `${data.notFoundParentVouchers.length} PO(s) have no parent JV yet — import or re-save those POs to create them.`
        );
      toast({ title: "Sync Complete", description: parts.join(" ") });
      if (data?.errors?.length > 0) {
        console.warn("[SyncAll] Errors:", data.errors);
      }
      if (data?.missingParentFreightAccount?.length > 0) {
        toast({
          title: "Action Required",
          description: `${data.missingParentFreightAccount.length} PO(s) have parent-paid freight but no parent account set. Please edit each PO to select the parent freight account.`,
          variant: "destructive",
        });
      }
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({
        title: "Sync Failed",
        description: error.message || "Failed to sync vouchers",
        variant: "destructive",
      });
    },
  });

  return { syncAllMutation, syncAllConfirmOpen, setSyncAllConfirmOpen };
}
