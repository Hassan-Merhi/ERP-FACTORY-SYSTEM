// Extracted from ./LocationInventoryHeader.tsx
import { getErrorDetails } from "@shared/errorUtils";
import { releaseDebtEnglish } from "@/i18n/finalCloseoutTranslations";
import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, MapPin, Link2, RadioTower } from "lucide-react";
import { useCompany } from "@/contexts/CompanyContext";
import { useLocation } from "@/contexts/LocationContext";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import type { AuthMe } from "@shared/apiTypes";

export interface LocationInventoryHeaderProps {
  posUser?: AuthMe;
  showNegativeStock: boolean;
  setShowNegativeStock: (v: boolean) => void;
  landing?: boolean;
  locationsCount?: number | null;
  negativeCount?: number | null;
  linkedGroupsCount?: number | null;
  activeReportsCount?: number | null;
}

type SendMode = "with_cost" | "no_cost" | null;

function newIdempotencyToken(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function useLocationInventoryHeaderState({
  posUser,
  locationsCount = null,
  negativeCount = null,
  linkedGroupsCount = null,
  activeReportsCount = null,
}: Pick<
  LocationInventoryHeaderProps,
  "posUser" | "locationsCount" | "negativeCount" | "linkedGroupsCount" | "activeReportsCount"
>) {
  const { selectedLocation } = useLocation();
  const { selectedCompany } = useCompany();
  const { toast } = useToast();
  const recordChanges = useExistingRecordChangeAccess();
  const [sendMode, setSendMode] = useState<SendMode>(null);
  const sendLockRef = useRef(false);
  const companyId = selectedCompany?.id;

  const { data: whatsappCapability } = useQuery<{ canManage: boolean }>({
    queryKey: companyId ? ["/api/location-inventory/whatsapp/capability", companyId] : [],
    queryFn: async () => {
      const response = await fetch("/api/location-inventory/whatsapp/capability", { credentials: "include" });
      if (!response.ok) return { canManage: false };
      return response.json();
    },
    enabled: !posUser && !!companyId,
    staleTime: 5 * 60 * 1000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const canManageWhatsapp = !posUser && whatsappCapability?.canManage === true;

  const { data: costCapability } = useQuery<{ canSendWithCost: boolean }>({
    queryKey: companyId ? ["/api/location-inventory/whatsapp/cost-capability", companyId] : [],
    queryFn: async () => {
      const response = await fetch("/api/location-inventory/whatsapp/cost-capability", { credentials: "include" });
      if (!response.ok) return { canSendWithCost: false };
      return response.json();
    },
    enabled: canManageWhatsapp && !!companyId,
    staleTime: 5 * 60 * 1000,
    retry: false,
    refetchOnWindowFocus: false,
  });

  const canSendWithCost = costCapability?.canSendWithCost === true;
  const whatsappReady = Boolean(selectedLocation?.whatsappGroupChatId && selectedLocation?.whatsappStockReportsEnabled);

  const handleSendStock = async (includeCost: boolean) => {
    if (!selectedLocation || sendMode || sendLockRef.current) return;
    if (includeCost && !canSendWithCost) {
      toast({
        title: releaseDebtEnglish("Cost report restricted"),
        description: releaseDebtEnglish(
          "Your role does not have permission to send cost price and total inventory value."
        ),
        variant: "destructive",
      });
      return;
    }

    sendLockRef.current = true;
    const mode: SendMode = includeCost ? "with_cost" : "no_cost";
    const idempotencyKey = newIdempotencyToken();
    setSendMode(mode);
    try {
      const response = await apiRequest("POST", `/api/locations/${selectedLocation.id}/send-stock-whatsapp`, {
        includeCost,
        idempotencyKey,
      });
      const result = await response.json();
      toast({
        title: result.duplicate ? "Stock report already sent" : "Stock sent to WhatsApp",
        description: `${result.itemCount ?? 0} items${result.duplicate ? " were already processed" : " sent"}${result.pageCount ? ` in ${result.pageCount} PDF page${result.pageCount === 1 ? "" : "s"}` : ""}${includeCost ? " with cost" : " without cost"}.`,
      });
    } catch (error) {
      toast({
        title: releaseDebtEnglish("WhatsApp send failed"),
        description: getErrorDetails(error).optionalMessage || "Could not send the stock report.",
        variant: "destructive",
      });
    } finally {
      sendLockRef.current = false;
      setSendMode(null);
      await queryClient.invalidateQueries({ queryKey: ["/api/locations", selectedLocation.id, "whatsapp-deliveries"] });
    }
  };

  const whatsappButtonTitle = !selectedLocation
    ? "Open a location to send its stock report"
    : !selectedLocation.whatsappGroupChatId
      ? "Link a WhatsApp group to this location first"
      : !selectedLocation.whatsappStockReportsEnabled
        ? "Enable WhatsApp stock reports for this location first"
        : `Send stock to ${selectedLocation.whatsappGroupName || "the linked WhatsApp group"}`;

  const overviewStats = [
    {
      label: "Locations",
      value: locationsCount,
      icon: MapPin,
      tone: "border-violet-200/80 bg-violet-50/90 text-violet-700 dark:border-violet-400/35 dark:bg-violet-500/15 dark:text-violet-100",
      iconTone: "bg-violet-100 text-violet-700 dark:bg-violet-600/40 dark:text-violet-100",
    },
    {
      label: "Negative stock",
      value: negativeCount,
      icon: AlertCircle,
      tone: "border-rose-200/80 bg-rose-50/80 text-rose-700 dark:border-rose-400/30 dark:bg-rose-500/10 dark:text-rose-100",
      iconTone: "bg-rose-100 text-rose-700 dark:bg-rose-600/35 dark:text-rose-100",
    },
    {
      label: "WhatsApp linked",
      value: linkedGroupsCount,
      icon: Link2,
      tone: "border-amber-200/80 bg-amber-50/80 text-amber-700 dark:border-amber-400/30 dark:bg-amber-500/10 dark:text-amber-100",
      iconTone: "bg-amber-100 text-amber-700 dark:bg-amber-600/30 dark:text-amber-100",
    },
    {
      label: "Reports enabled",
      value: activeReportsCount,
      icon: RadioTower,
      tone: "border-sky-200/80 bg-sky-50/80 text-sky-700 dark:border-sky-400/30 dark:bg-sky-500/10 dark:text-sky-100",
      iconTone: "bg-sky-100 text-sky-700 dark:bg-sky-600/30 dark:text-sky-100",
    },
  ];
  return {
    selectedLocation,
    recordChanges,
    sendMode,
    companyId,
    canManageWhatsapp,
    canSendWithCost,
    whatsappReady,
    handleSendStock,
    whatsappButtonTitle,
    overviewStats,
  };
}
