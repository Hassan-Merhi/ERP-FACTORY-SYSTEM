// Extracted from ./SpSetupPanel.tsx
import type { ClientErrorLike } from "@/lib/clientError";
import { releaseDebtEnglish } from "@/i18n/finalCloseoutTranslations";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { type GoldenCoastSetupStatus, type SpSetupStatus, type SetupConfirmationPayload } from "./SpSetupPanelParts";

export function useSpSetupPanelState() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: status, isLoading: isSpStatusLoading } = useQuery<SpSetupStatus>({
    queryKey: ["/api/sp/setup/status"],
  });
  const { data: goldenCoastBase, isLoading: isGoldenCoastStatusLoading } = useQuery<GoldenCoastSetupStatus>({
    queryKey: ["/api/sp/setup/golden-coast/status"],
  });
  const parentCompanyId = Number(goldenCoastBase?.phase13?.parentCompanyId ?? 0);
  const scopedGoldenCoastStatusUrl =
    parentCompanyId > 0 ? `/api/sp/setup/golden-coast/status?targetCompanyId=${parentCompanyId}` : "";
  const { data: goldenCoastScoped } = useQuery<GoldenCoastSetupStatus>({
    queryKey: [scopedGoldenCoastStatusUrl],
    enabled: parentCompanyId > 0,
    retry: false,
  });

  const setupMutation = useMutation({
    mutationFn: async (payload: SetupConfirmationPayload) => {
      const response = await apiRequest("POST", "/api/sp/setup", payload);
      return response.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/sp/setup/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/ledger-accounts"] });

      const messages: string[] = [];
      if (data.created?.length > 0) messages.push(`Created: ${data.created.join(", ")}.`);
      if (data.repairedSupplierVoucherLinks > 0) {
        messages.push(
          `Repaired ${data.repairedSupplierVoucherLinks} Goods-OTW voucher supplier link${
            data.repairedSupplierVoucherLinks === 1 ? "" : "s"
          }.`
        );
      }

      toast({
        title: "Supplier Partner setup complete",
        description: messages.join(" ") || "Accounts, warehouse, and supplier ledger links are already configured.",
      });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });

  const goldenCoastMutation = useMutation({
    mutationFn: async (payload: SetupConfirmationPayload) => {
      const response = await apiRequest("POST", "/api/sp/setup/golden-coast", payload);
      return response.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/sp/setup/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/sp/setup/golden-coast/status"] });
      if (scopedGoldenCoastStatusUrl) {
        queryClient.invalidateQueries({ queryKey: [scopedGoldenCoastStatusUrl] });
      }
      queryClient.invalidateQueries({ queryKey: ["/api/ledger-accounts"] });

      const messages: string[] = [];
      if (data.created?.length > 0) messages.push(`Created ${data.created.length} balance-sheet account(s).`);
      if (data.repaired?.length > 0) messages.push(`Repaired ${data.repaired.length} balance-sheet account(s).`);
      if (data.settingsChanged?.length > 0) messages.push(`Bound ${data.settingsChanged.join(", ")}.`);
      const intercompanyChanges = (data.intercompanyChanges ?? []).filter(
        (item: { action?: string }) => item.action && item.action !== "none"
      );
      if (intercompanyChanges.length > 0) {
        messages.push(
          `Provisioned/repaired ${intercompanyChanges.length} Golden Coast ↔ HADI intercompany account(s).`
        );
      }

      toast({
        title: releaseDebtEnglish("Golden Coast accounting setup complete"),
        description: messages.join(" ") || "Golden Coast and HADI accounting accounts were already configured.",
      });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });
  return {
    isSpStatusLoading,
    status,
    isGoldenCoastStatusLoading,
    goldenCoastBase,
    goldenCoastScoped,
    setupMutation,
    goldenCoastMutation,
  };
}
