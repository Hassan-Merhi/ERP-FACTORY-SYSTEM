// Extracted from ./ImportCycleDiagnostics.tsx: state, queries and handlers for ImportCycleDiagnostics.
import { useQuery, useMutation } from "@tanstack/react-query";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { useCompany } from "@/contexts/CompanyContext";
import { useAppMode } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import { queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { ImportCycleData, DiagnosticsData } from "./importCycleDiagnosticsTypes";

export function useImportCycleDiagnosticsModel() {
  const { formatAmount } = useCurrencyContext();
  const { selectedCompany } = useCompany();
  const appMode = useAppMode();
  const modeApiRequest = getApiRequest(appMode);
  const { toast } = useToast();

  const { data, isLoading, error, refetch } = useQuery<ImportCycleData>({
    queryKey: ["/api/stats/import-cycle-balance", selectedCompany?.id, appMode],
    queryFn: () =>
      modeApiRequest("GET", "/api/stats/import-cycle-balance").then((r) => {
        if (!r.ok) throw new Error("Failed to load import cycle balance");
        return r.json();
      }),
    enabled: !!selectedCompany,
  });

  const { data: diagnosticsData, isLoading: diagnosticsLoading } = useQuery<DiagnosticsData>({
    queryKey: ["/api/stats/import-cycle-diagnostics", selectedCompany?.id, appMode],
    queryFn: () =>
      modeApiRequest("GET", "/api/stats/import-cycle-diagnostics").then((r) => {
        if (!r.ok) throw new Error("Failed to load diagnostics");
        return r.json();
      }),
    enabled: !!selectedCompany,
  });

  const recalculateMutation = useMutation({
    mutationFn: () => {
      return modeApiRequest("POST", "/api/admin/recalculate-equity-adjustment").then((r) => {
        if (!r.ok) throw new Error("Recalculate failed");
        return r.json();
      });
    },
    onSuccess: (data: { message?: string }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/stats/import-cycle-balance"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats/import-cycle-diagnostics"] });
      toast({ title: "Recalculated", description: data.message ?? "" });
    },
    onError: (e: Error) => toast({ title: "Recalculation failed", description: e.message, variant: "destructive" }),
  });

  return { formatAmount, data, isLoading, error, refetch, diagnosticsData, diagnosticsLoading, recalculateMutation };
}

export type ImportCycleDiagnosticsModel = ReturnType<typeof useImportCycleDiagnosticsModel>;
