import { getErrorDetails } from "@shared/errorUtils";
import { releaseDebtEnglish } from "@/i18n/finalCloseoutTranslations";
import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, ChevronDown, Loader2, MessageCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useCompany } from "@/contexts/CompanyContext";
import { useLocation } from "@/contexts/LocationContext";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { LocationWhatsappScheduleDialog } from "./LocationWhatsappScheduleDialog";
import { LocationWhatsappDeliveryHistoryDialog } from "./LocationWhatsappDeliveryHistoryDialog";
import type { AuthMe, FactoryMyAccess, ApiListRow } from "@shared/apiTypes";

interface LocationInventoryHeaderProps {
  posUser?: AuthMe;
  showNegativeStock: boolean;
  setShowNegativeStock: (v: boolean) => void;
}

type SendMode = "with_cost" | "no_cost" | null;

function newIdempotencyToken(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function LocationInventoryHeader({
  posUser,
  showNegativeStock,
  setShowNegativeStock,
}: LocationInventoryHeaderProps) {
  const { selectedLocation } = useLocation();
  const { selectedCompany } = useCompany();
  const { toast } = useToast();
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

  return (
    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 sm:gap-4 px-4 sm:px-6 py-4 border-b shrink-0">
      <div className="min-w-0">
        <h1 className="text-xl sm:text-2xl font-bold">Location Inventory</h1>
        <p className="text-sm text-muted-foreground truncate">
          {selectedLocation ? `Manage inventory for ${selectedLocation.name}` : "Manage inventory across all locations"}
        </p>
      </div>

      {!posUser && (
        <div className="flex flex-wrap items-center gap-2 sm:justify-end">
          {canManageWhatsapp && selectedLocation && (
            <>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-2"
                    disabled={!whatsappReady || sendMode !== null}
                    title={whatsappButtonTitle}
                    data-testid="button-send-location-stock-whatsapp"
                  >
                    {sendMode ? <Loader2 className="h-4 w-4 animate-spin" /> : <MessageCircle className="h-4 w-4" />}
                    {sendMode ? "Sending…" : "Send Stock"}
                    {!sendMode && <ChevronDown className="h-3.5 w-3.5" />}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-64">
                  <DropdownMenuItem
                    onClick={() => handleSendStock(false)}
                    disabled={sendMode !== null}
                    data-testid="menu-send-stock-whatsapp-no-cost"
                  >
                    <MessageCircle className="h-4 w-4 mr-2" />
                    <div>
                      <div className="font-medium">{releaseDebtEnglish("Send WITHOUT COST")}</div>
                      <div className="text-xs text-muted-foreground">
                        {releaseDebtEnglish("Quantity-only Godown Summary PDF")}
                      </div>
                    </div>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => handleSendStock(true)}
                    disabled={sendMode !== null || !canSendWithCost}
                    data-testid="menu-send-stock-whatsapp-with-cost"
                  >
                    <MessageCircle className="h-4 w-4 mr-2" />
                    <div>
                      <div className="font-medium">{releaseDebtEnglish("Send WITH COST")}</div>
                      <div className="text-xs text-muted-foreground">
                        {canSendWithCost
                          ? "Includes average rate and total value"
                          : "Requires cost-price and total-value permission"}
                      </div>
                    </div>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>

              <LocationWhatsappScheduleDialog
                location={selectedLocation}
                companyId={companyId}
                canSendWithCost={canSendWithCost}
              />

              <LocationWhatsappDeliveryHistoryDialog
                location={selectedLocation}
                companyId={companyId}
                canSendWithCost={canSendWithCost}
              />
            </>
          )}

          <Button
            variant={showNegativeStock ? "destructive" : "outline"}
            size="sm"
            className="gap-2"
            onClick={() => setShowNegativeStock(!showNegativeStock)}
            data-testid="button-negative-stock"
          >
            <AlertCircle className="h-4 w-4" />
            <span>{releaseDebtEnglish("Negative Stock")}</span>
          </Button>
        </div>
      )}
    </div>
  );
}
