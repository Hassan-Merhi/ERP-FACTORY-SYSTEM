// Extracted from ./IntercompanyPosTab.tsx
import type { ClientErrorLike } from "@/lib/clientError";
import { useState, useEffect, useRef } from "react";
import { useToast } from "@/hooks/use-toast";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { type Company, type LedgerAccount } from "@shared/schema";
import type { SettingsIntercompanyPosConfig } from "./settingsTypes";
import { useCompany } from "@/contexts/CompanyContext";

export function useIntercompanyPosTabState() {
  const { toast } = useToast();
  const { selectedCompany } = useCompany();

  // Current config
  const { data: config, isLoading: configLoading } = useQuery<SettingsIntercompanyPosConfig>({
    queryKey: ["/api/intercompany-pos-config", selectedCompany?.id],
  });

  // All companies (for dest company dropdown)
  const { data: allCompanies = [] } = useQuery<Company[]>({
    queryKey: ["/api/companies"],
  });

  // Current company accounts (source interco account)
  const { data: srcAccounts = [] } = useQuery<LedgerAccount[]>({
    queryKey: ["/api/ledger-accounts", selectedCompany?.id],
  });

  const [destCompanyId, setDestCompanyId] = useState<string>("");
  const [sourceIntercoAccountId, setSourceIntercoAccountId] = useState<string>("");
  const [destIntercoAccountId, setDestIntercoAccountId] = useState<string>("");
  const [enabled, setEnabled] = useState(true);
  const [skipSourceVoucher, setSkipSourceVoucher] = useState(false);
  const [initialized, setInitialized] = useState(false);

  // Dest company accounts
  const { data: destAccounts = [], isLoading: destAccountsLoading } = useQuery<LedgerAccount[]>({
    queryKey: ["/api/intercompany-pos-config/dest-accounts", destCompanyId],
    queryFn: async () => {
      if (!destCompanyId) return [];
      const res = await fetch(`/api/intercompany-pos-config/dest-accounts?companyId=${destCompanyId}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to load dest accounts");
      return res.json();
    },
    enabled: !!destCompanyId,
  });

  // Populate form when config loads
  useEffect(() => {
    if (config && !initialized) {
      setDestCompanyId(String(config.destCompanyId ?? ""));
      setSourceIntercoAccountId(String(config.sourceIntercoAccountId ?? ""));
      setDestIntercoAccountId(String(config.destIntercoAccountId ?? ""));
      setEnabled(config.enabled ?? true);
      setSkipSourceVoucher(config.skipSourceVoucher ?? false);
      setInitialized(true);
    }
    if (!config && !configLoading && !initialized) {
      setInitialized(true);
    }
  }, [config, configLoading, initialized]);

  // Reset dest interco account when dest company changes
  const prevDestCompanyId = useRef(destCompanyId);
  const isFirstDestCompanyChange = useRef(true);
  useEffect(() => {
    if (isFirstDestCompanyChange.current) {
      isFirstDestCompanyChange.current = false;
      prevDestCompanyId.current = destCompanyId;
      return;
    }
    if (destCompanyId !== prevDestCompanyId.current) {
      setDestIntercoAccountId("");
      prevDestCompanyId.current = destCompanyId;
    }
  }, [destCompanyId]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/intercompany-pos-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          destCompanyId: parseInt(destCompanyId),
          sourceIntercoAccountId: parseInt(sourceIntercoAccountId),
          destIntercoAccountId: parseInt(destIntercoAccountId),
          enabled,
          skipSourceVoucher,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message ?? "Failed to save");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/intercompany-pos-config"] });
      toast({ title: "Saved", description: "Intercompany POS transfer config saved." });
    },
    onError: (err: ClientErrorLike) => {
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    },
  });

  const [rebuildFrom, setRebuildFrom] = useState("");
  const [rebuildTo, setRebuildTo] = useState("");
  const rebuildMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/intercompany-pos-config/rebuild", {
        fromDate: rebuildFrom,
        toDate: rebuildTo,
      });
      return (await res.json()) as { datesChecked: number; datesRebuilt: number; failedDates: string[] };
    },
    onSuccess: (result) => {
      toast({
        title: result.failedDates.length ? "Rebuild finished with errors" : "Rebuild complete",
        description: result.failedDates.length
          ? `Failed dates: ${result.failedDates.join(", ")}`
          : `${result.datesRebuilt} of ${result.datesChecked} dates rebuilt.`,
        variant: result.failedDates.length ? "destructive" : "default",
      });
    },
    onError: (err: ClientErrorLike) => {
      toast({ title: "Update failed", description: err.message, variant: "destructive" });
    },
  });

  const otherCompanies = allCompanies.filter((c) => c.id !== selectedCompany?.id);
  const canSave = destCompanyId && sourceIntercoAccountId && destIntercoAccountId;
  return {
    configLoading,
    config,
    srcAccounts,
    destCompanyId,
    setDestCompanyId,
    sourceIntercoAccountId,
    setSourceIntercoAccountId,
    destIntercoAccountId,
    setDestIntercoAccountId,
    enabled,
    setEnabled,
    skipSourceVoucher,
    setSkipSourceVoucher,
    destAccountsLoading,
    destAccounts,
    saveMutation,
    rebuildFrom,
    setRebuildFrom,
    rebuildTo,
    setRebuildTo,
    rebuildMutation,
    otherCompanies,
    canSave,
  };
}
