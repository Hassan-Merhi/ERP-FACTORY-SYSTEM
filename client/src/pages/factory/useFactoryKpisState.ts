// Extracted from ./FactoryKpis.tsx
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { type RowsExportSheet } from "@/components/export/RowsExportMenu";
import type { FactoryMyAccess } from "@shared/apiTypes";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";

interface DailyProduction {
  date: string;
  balesProduced: number;
  kgPressed: number;
  wasteKg: number;
}

interface WorkerPerformance {
  workerName: string;
  balesCount: number;
  totalKg: number;
}

interface MixEfficiency {
  mixBatchId: number | string;
  totalInputKg: number;
  totalOutputKg: number;
  wasteKg: number;
  wastePercent: number;
}

function getDefaultDateRange() {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 30);
  return {
    from: from.toLocaleDateString("en-CA"),
    to: to.toLocaleDateString("en-CA"),
  };
}

export function useFactoryKpisState() {
  const { selectedCompany } = useCompany();
  const { formatDisplayDate } = useDateFormat();
  const defaults = getDefaultDateRange();
  const [from, setFrom] = useState(defaults.from);
  const [to, setTo] = useState(defaults.to);
  const [requestedTab, setRequestedTab] = useState<"daily" | "workers" | "mixes">("daily");

  const { data: settings } = useQuery({
    queryKey: companyQueryKey("/api/factory/settings", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
    queryFn: async () => {
      const r = await fetch("/api/factory/settings");
      return r.ok ? r.json() : {};
    },
    staleTime: 60000,
  });

  const { data: myAccess } = useQuery<FactoryMyAccess>({
    queryKey: companyQueryKey("/api/factory/my-access", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
    staleTime: 5 * 60000,
  });
  const hiddenTabs =
    myAccess?.companyId === selectedCompany?.id && myAccess?.hasFactoryAccess === true
      ? myAccess.hiddenCostFields
      : ["hide_tab_kpis_daily", "hide_tab_kpis_worker_performance", "hide_tab_kpis_mix_efficiency"];

  const showDaily = !hiddenTabs.includes("hide_tab_kpis_daily");
  const showWorkers =
    settings?.kpisTabWorkerPerformanceEnabled !== false && !hiddenTabs.includes("hide_tab_kpis_worker_performance");
  const showMixes =
    settings?.kpisTabMixEfficiencyEnabled !== false && !hiddenTabs.includes("hide_tab_kpis_mix_efficiency");
  const visibleTabs = [showDaily ? "daily" : null, showWorkers ? "workers" : null, showMixes ? "mixes" : null].filter(
    (value): value is "daily" | "workers" | "mixes" => value !== null
  );
  const activeTab = visibleTabs.includes(requestedTab) ? requestedTab : visibleTabs[0];

  useEffect(() => {
    if (activeTab && requestedTab !== activeTab) setRequestedTab(activeTab);
  }, [activeTab, requestedTab]);

  const dailyQuery = useQuery<DailyProduction[]>({
    queryKey: companyQueryKey("/api/factory/kpis/daily", selectedCompany?.id, from, to),
    queryFn: async () => {
      const res = await fetch(`/api/factory/kpis/daily?from=${from}&to=${to}`);
      if (!res.ok) throw new Error("Failed to load daily production");
      return res.json();
    },
    enabled: showDaily && Boolean(selectedCompany?.id),
  });

  const workersQuery = useQuery<WorkerPerformance[]>({
    queryKey: companyQueryKey("/api/factory/kpis/workers", selectedCompany?.id, from, to),
    queryFn: async () => {
      const res = await fetch(`/api/factory/kpis/workers?from=${from}&to=${to}`);
      if (!res.ok) throw new Error("Failed to load worker performance");
      return res.json();
    },
    enabled: showWorkers && Boolean(selectedCompany?.id),
  });

  const mixesQuery = useQuery<MixEfficiency[]>({
    queryKey: companyQueryKey("/api/factory/kpis/mixes", selectedCompany?.id, from, to),
    queryFn: async () => {
      const res = await fetch(`/api/factory/kpis/mixes?from=${from}&to=${to}`);
      if (!res.ok) throw new Error("Failed to load mix efficiency");
      return res.json();
    },
    enabled: showMixes && Boolean(selectedCompany?.id),
  });

  // The open tab's table, exactly as shown, for the Export menu.
  const exportSheet: RowsExportSheet<unknown> | null =
    activeTab === "daily"
      ? {
          name: "Daily Production",
          rows: dailyQuery.data ?? [],
          columns: [
            { header: "Date", value: (row: DailyProduction) => (row.date ? formatDisplayDate(row.date) : "—") },
            { header: "Bales Produced", value: (row: DailyProduction) => row.balesProduced, type: "number" },
            { header: "KG Pressed", value: (row: DailyProduction) => row.kgPressed, type: "number" },
            { header: "Waste KG", value: (row: DailyProduction) => row.wasteKg, type: "number" },
          ],
        }
      : activeTab === "workers"
        ? {
            name: "Worker Performance",
            rows: (workersQuery.data ?? []).map((worker, idx) => ({ ...worker, rank: idx + 1 })),
            columns: [
              { header: "#", value: (row: WorkerPerformance & { rank: number }) => row.rank, type: "number" },
              { header: "Worker Name", value: (row: WorkerPerformance) => row.workerName },
              { header: "Bales Count", value: (row: WorkerPerformance) => row.balesCount, type: "number" },
              { header: "Total KG", value: (row: WorkerPerformance) => row.totalKg, type: "number" },
            ],
          }
        : activeTab === "mixes"
          ? {
              name: "Mix Efficiency",
              rows: mixesQuery.data ?? [],
              columns: [
                { header: "Mix Batch ID", value: (mix: MixEfficiency) => mix.mixBatchId },
                { header: "Total Input KG", value: (mix: MixEfficiency) => mix.totalInputKg, type: "number" },
                { header: "Total Output KG", value: (mix: MixEfficiency) => mix.totalOutputKg, type: "number" },
                { header: "Waste KG", value: (mix: MixEfficiency) => mix.wasteKg, type: "number" },
                { header: "Waste %", value: (mix: MixEfficiency) => `${(mix.wastePercent ?? 0).toFixed(1)}%` },
              ],
            }
          : null;
  return {
    formatDisplayDate,
    from,
    setFrom,
    to,
    setTo,
    setRequestedTab,
    showDaily,
    showWorkers,
    showMixes,
    activeTab,
    dailyQuery,
    workersQuery,
    mixesQuery,
    exportSheet,
  };
}
