// Extracted from ./useRawStockRecalculate.ts
import { useMutation, useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import type { PartialOffloadApplyResponse, RecalcRow } from "./rawstockrecalculate/types";
import { getRawStockErrorMessage, useRawStockRecalculatePart1 } from "./getRawStockErrorMessage";

export function useRawStockRecalculatePart4({
  activeTab,
  modeApiRequest,
  toast,
}: Pick<Awaited<ReturnType<typeof useRawStockRecalculatePart1>>, "activeTab" | "modeApiRequest" | "toast">) {
  // ── Partial-offload legacy fix scan ──────────────────────────────────────
  const {
    data: partialOffloadScan,
    isLoading: partialOffloadLoading,
    refetch: refetchPartialOffload,
  } = useQuery<{ affected: RecalcRow[]; skippedFx: RecalcRow[]; totalScanned: number }>({
    queryKey: ["/api/factory/raw-stock/recalc/partial-offload-scan"],
    queryFn: async () => {
      const res = await modeApiRequest("GET", "/api/factory/raw-stock/recalc/partial-offload-scan");
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || "Scan failed");
      return res.json();
    },
    enabled: activeTab === "partialfix",
  });

  const partialOffloadApplyMutation = useMutation({
    mutationFn: async () => {
      const dryRun = await modeApiRequest("POST", "/api/factory/raw-stock/recalc/partial-offload-scan/apply", {});
      if (!dryRun.ok) throw new Error((await dryRun.json()).message || "Dry-run failed");
      const dryRunData = await dryRun.json();
      if (!dryRunData.confirmationToken) {
        return dryRunData; // nothing to fix
      }
      const res = await modeApiRequest("POST", "/api/factory/raw-stock/recalc/partial-offload-scan/apply", {
        confirm: true,
        confirmationToken: dryRunData.confirmationToken,
      });
      if (!res.ok) throw new Error((await res.json()).message || "Apply failed");
      return res.json() as Promise<PartialOffloadApplyResponse>;
    },
    onSuccess: (data) => {
      if (!data.applied) {
        toast({ title: "Nothing to fix", description: "All partial-offload containers already have correct costs." });
        return;
      }
      queryClient.invalidateQueries({ queryKey: ["/api/factory/raw-stock/recalc/partial-offload-scan"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/raw-stock/recalc/preview"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/raw-stock/recalc/full-audit"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/raw-stock"] });
      toast({
        title: "Partial-offload costs corrected",
        description: `Fixed ${data.applied} container(s). ${data.skipped} skipped.`,
      });
    },
    onError: (err: unknown) => {
      toast({ title: "Fix failed", description: getRawStockErrorMessage(err), variant: "destructive" });
    },
  });
  return { partialOffloadApplyMutation, partialOffloadLoading, partialOffloadScan, refetchPartialOffload };
}
