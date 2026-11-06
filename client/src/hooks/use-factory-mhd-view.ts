import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useCompany } from "@/contexts/CompanyContext";
import { useUserPreferences } from "@/hooks/use-user-preferences";
import { queryClient } from "@/lib/queryClient";

type MhdEntry = { articleCode: string; itemName: string; sortOrder: number };
type MhdResponse = { revision: number; rows: MhdEntry[]; products: Array<{ id: number; articleCode: string; name: string }> };
export type FactoryProductViewMode = "standard" | "mhd";
const normalize = (code: string | null | undefined) => String(code ?? "").trim().toUpperCase();

export function useFactoryMhdView() {
  const { selectedCompany } = useCompany();
  const { prefs } = useUserPreferences();
  const [saving, setSaving] = useState(false);
  const { data, isLoading } = useQuery<MhdResponse>({
    queryKey: ["/api/factory/mhd-view", selectedCompany?.id],
    enabled: Boolean(selectedCompany?.id && ["factory", "factory_v2"].includes(selectedCompany.companyType ?? "")),
    staleTime: 60_000,
    queryFn: async () => {
      const response = await fetch("/api/factory/mhd-view", { credentials: "include" });
      if (!response.ok) throw new Error("Unable to load MHD View");
      return response.json();
    },
  });
  const mode: FactoryProductViewMode = prefs?.factoryMhdViewDefault ? "mhd" : "standard";
  const lookup = useMemo(() => {
    const map = new Map<string, MhdEntry>();
    for (const row of data?.rows ?? []) map.set(normalize(row.articleCode), row);
    return map;
  }, [data?.rows]);

  const nameFor = (articleCode: string | null | undefined, originalName: string): string => {
    if (mode !== "mhd") return originalName;
    return lookup.get(normalize(articleCode))?.itemName || originalName;
  };
  const sortRows = <T,>(rows: readonly T[], articleCode: (row: T) => string | null | undefined): T[] => {
    if (mode !== "mhd" || !lookup.size) return [...rows];
    return rows.map((row, originalIndex) => ({ row, originalIndex })).sort((a, b) => {
      const aOrder = lookup.get(normalize(articleCode(a.row)))?.sortOrder ?? Number.MAX_SAFE_INTEGER;
      const bOrder = lookup.get(normalize(articleCode(b.row)))?.sortOrder ?? Number.MAX_SAFE_INTEGER;
      return aOrder - bOrder || a.originalIndex - b.originalIndex;
    }).map((item) => item.row);
  };

  const setMode = async (next: FactoryProductViewMode) => {
    if (saving || next === mode) return;
    const key = ["/api/user-preferences"];
    const prior = queryClient.getQueryData<Record<string, unknown>>(key);
    queryClient.setQueryData(key, { ...(prior ?? {}), factoryMhdViewDefault: next === "mhd" });
    setSaving(true);
    try {
      const response = await fetch("/api/user-preferences", {
        method: "PUT", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ factoryMhdViewDefault: next === "mhd" }),
      });
      if (!response.ok) throw new Error("Unable to save your Factory view preference");
      await queryClient.invalidateQueries({ queryKey: key });
    } catch (error) {
      queryClient.setQueryData(key, prior);
      throw error;
    } finally {
      setSaving(false);
    }
  };
  return { mode, setMode, saving, isLoading, nameFor, sortRows, hasMhdView: lookup.size > 0, revision: data?.revision ?? 0 };
}
