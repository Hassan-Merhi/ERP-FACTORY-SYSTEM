// Extracted from ./LocationWhatsappDeliveryHistoryDialog.tsx
import { releaseDebtEnglish } from "@/i18n/finalCloseoutTranslations";
import { useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import {
  newIdempotencyToken,
  type DeliveryEntry,
  type DeliveryHistoryResponse,
  type Props,
} from "./LocationWhatsappDeliveryHistoryDialogHelpers";

export function useLocationWhatsappDeliveryHistoryDialogState({
  location,
  companyId,
  canSendWithCost,
}: Pick<Props, "location" | "companyId" | "canSendWithCost">) {
  const [open, setOpen] = useState(false);
  const [retryingId, setRetryingId] = useState<number | null>(null);
  const retryLockRef = useRef(false);
  const { toast } = useToast();
  const recordChanges = useExistingRecordChangeAccess();

  const historyQuery = useQuery<DeliveryHistoryResponse>({
    queryKey: ["/api/locations", location.id, "whatsapp-deliveries", companyId],
    queryFn: async () => {
      const response = await fetch(`/api/locations/${location.id}/whatsapp-deliveries?limit=50`, {
        credentials: "include",
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.message || `Failed to load delivery history: ${response.status}`);
      }
      return response.json();
    },
    enabled: open && !!companyId,
    retry: false,
    refetchOnWindowFocus: false,
  });

  const retryMutation = useMutation({
    mutationFn: async (delivery: DeliveryEntry) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      setRetryingId(delivery.id);
      const idempotencyKey = newIdempotencyToken();
      const response = await apiRequest(
        "POST",
        `/api/locations/${location.id}/whatsapp-deliveries/${delivery.id}/retry`,
        { idempotencyKey }
      );
      return response.json();
    },
    onSuccess: (result) => {
      toast({
        title: result.duplicate ? "Retry already processed" : "Stock report resent",
        description: `${result.itemCount ?? 0} items sent to ${result.destinationGroupName || "the linked WhatsApp group"}.`,
      });
    },
    onError: (error: Error) => {
      toast({ title: releaseDebtEnglish("Retry failed"), description: error.message, variant: "destructive" });
    },
    onSettled: async () => {
      retryLockRef.current = false;
      setRetryingId(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["/api/locations", location.id, "whatsapp-deliveries"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/locations", location.id, "whatsapp-schedule"] }),
      ]);
    },
  });

  const handleRetry = (delivery: DeliveryEntry) => {
    if (retryLockRef.current || retryMutation.isPending) return;
    if (delivery.includeCost && !canSendWithCost) {
      toast({
        title: releaseDebtEnglish("Cost report restricted"),
        description: releaseDebtEnglish("Cost-price and total-value permission is required to retry this report."),
        variant: "destructive",
      });
      return;
    }
    retryLockRef.current = true;
    retryMutation.mutate(delivery);
  };

  const summary = historyQuery.data?.summary;
  const deliveries = historyQuery.data?.deliveries ?? [];
  return { setOpen, open, retryingId, recordChanges, historyQuery, retryMutation, handleRetry, summary, deliveries };
}
