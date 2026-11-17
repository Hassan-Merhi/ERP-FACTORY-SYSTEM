// Extracted from ./FactoryStockAllocationV3.tsx to keep that module under the source-size cap.
import type { ClientErrorLike } from "@/lib/clientError";
import { useState } from "react";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { useMutation, useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { Proforma, StockRow, Tab, V3Load } from "./factorystockallocationv3/types";

export function useFactoryStockAllocationV3State() {
  const { selectedCompany } = useCompany();
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const [scanningLoad, setScanningLoad] = useState<V3Load | null>(null);
  const [createLoadProforma, setCreateLoadProforma] = useState<Proforma | null>(null);
  const [cancelTargetId, setCancelTargetId] = useState<number | null>(null);

  // Queries
  const {
    data: stockRows = [],
    isLoading: stockLoading,
    isError: stockError,
    refetch: refetchStock,
  } = useQuery<StockRow[]>({
    queryKey: companyQueryKey("/api/factory/v3/stock-overview", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
  });

  const { data: expectedLoads = [] } = useQuery<V3Load[]>({
    queryKey: companyQueryKey("/api/factory/v3/loads", selectedCompany?.id, "expected_to_load"),
    enabled: Boolean(selectedCompany?.id),
    queryFn: () =>
      fetch("/api/factory/v3/loads?status=expected_to_load", { credentials: "include" }).then((r) => r.json()),
  });

  const { data: loadingLoads = [] } = useQuery<V3Load[]>({
    queryKey: companyQueryKey("/api/factory/v3/loads", selectedCompany?.id, "loading"),
    enabled: Boolean(selectedCompany?.id),
    queryFn: () => fetch("/api/factory/v3/loads?status=loading", { credentials: "include" }).then((r) => r.json()),
  });

  const { data: finalizedLoads = [] } = useQuery<V3Load[]>({
    queryKey: companyQueryKey("/api/factory/v3/loads", selectedCompany?.id, "finalized"),
    enabled: Boolean(selectedCompany?.id),
    queryFn: () => fetch("/api/factory/v3/loads?status=finalized", { credentials: "include" }).then((r) => r.json()),
  });

  const { data: proformas = [] } = useQuery<Proforma[]>({
    queryKey: companyQueryKey("/api/factory/v3/proformas", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
  });

  // KPI totals
  const totalInStock = stockRows.reduce((s, r) => s + (r.inStockBales ?? 0), 0);
  const totalEtl = stockRows.reduce((s, r) => s + (r.expectedToLoadBales ?? 0), 0);
  const totalLoading = stockRows.reduce((s, r) => s + (r.loadingBales ?? 0), 0);
  const totalFtp = stockRows.reduce((s, r) => s + (r.ftpBales ?? 0), 0);

  const startMutation = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`/api/factory/v3/loads/${id}/start`, { method: "PATCH", credentials: "include" });
      const data = await r.json();
      if (!r.ok) throw new Error(data.message);
      return data;
    },
    onSuccess: (_, _id) => {
      toast({ title: "Loading started" });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/v3/loads"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/v3/stock-overview"] });
      setActiveTab("loading");
    },
    onError: (err: ClientErrorLike) =>
      toast({ title: "Update failed", description: err.message, variant: "destructive" }),
  });

  const cancelMutation = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`/api/factory/v3/loads/${id}/cancel`, { method: "PATCH", credentials: "include" });
      const data = await r.json();
      if (!r.ok) throw new Error(data.message);
      return data;
    },
    onSuccess: () => {
      toast({ title: "Load cancelled" });
      setCancelTargetId(null);
      queryClient.invalidateQueries({ queryKey: ["/api/factory/v3/loads"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/v3/stock-overview"] });
    },
    onError: (err: ClientErrorLike) =>
      toast({ title: "Cancel failed", description: err.message, variant: "destructive" }),
  });
  return {
    stockError,
    refetchStock,
    activeTab,
    cancelMutation,
    cancelTargetId,
    createLoadProforma,
    expectedLoads,
    finalizedLoads,
    loadingLoads,
    proformas,
    scanningLoad,
    setActiveTab,
    setCancelTargetId,
    setCreateLoadProforma,
    setScanningLoad,
    startMutation,
    stockLoading,
    stockRows,
    totalEtl,
    totalFtp,
    totalInStock,
    totalLoading,
  };
}
