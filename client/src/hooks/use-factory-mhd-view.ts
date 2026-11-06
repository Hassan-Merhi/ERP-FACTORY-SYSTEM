import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useOptionalCompany } from "@/contexts/CompanyContext";
import { useUserPreferences } from "@/hooks/use-user-preferences";
import { queryClient } from "@/lib/queryClient";
import {
  factoryMhdLookup,
  factoryMhdName,
  sortFactoryMhdRows,
  type FactoryMhdDisplayMode,
  type FactoryMhdEntry,
} from "@/lib/factoryMhdDisplay";

type MhdEntry = FactoryMhdEntry;
type MhdResponse = {
  revision: number;
  rows: MhdEntry[];
  products: Array<{ id: number; articleCode: string; name: string }>;
};
export type FactoryProductViewMode = FactoryMhdDisplayMode;
const MHD_FETCH_ERROR = "Unable to load MHD View";
const MHD_SAVE_ERROR = "Unable to save your Factory view preference";

export function useFactoryMhdView() {
  const selectedCompany = useOptionalCompany()?.selectedCompany;
  const { prefs } = useUserPreferences();
  const [saving, setSaving] = useState(false);
  const { data, isLoading } = useQuery<MhdResponse>({
    queryKey: ["/api/factory/mhd-view", selectedCompany?.id],
    enabled: Boolean(selectedCompany?.id && ["factory", "factory_v2"].includes(selectedCompany.companyType ?? "")),
    staleTime: 60_000,
    queryFn: async () => {
      const response = await fetch("/api/factory/mhd-view", { credentials: "include" });
      if (!response.ok) throw new Error(MHD_FETCH_ERROR);
      return response.json();
    },
  });
  const mode: FactoryProductViewMode = prefs?.factoryMhdViewDefault ? "mhd" : "standard";
  const lookup = useMemo(() => factoryMhdLookup(data?.rows ?? []), [data?.rows]);
  // Stable while the view mode and published mapping are unchanged, so callers
  // can list them as hook dependencies without recomputing on every render.
  const nameFor = useCallback(
    (articleCode: string | null | undefined, originalName: string): string =>
      factoryMhdName(mode, lookup, articleCode, originalName),
    [mode, lookup]
  );
  const sortRows = useCallback(
    <T>(rows: readonly T[], articleCode: (row: T) => string | null | undefined): T[] =>
      sortFactoryMhdRows(mode, lookup, rows, articleCode),
    [mode, lookup]
  );

  const setMode = async (next: FactoryProductViewMode) => {
    if (saving || next === mode) return;
    const key = ["/api/user-preferences"];
    const prior = queryClient.getQueryData<Record<string, unknown>>(key);
    queryClient.setQueryData(key, { ...(prior ?? {}), factoryMhdViewDefault: next === "mhd" });
    setSaving(true);
    try {
      const response = await fetch("/api/user-preferences", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ factoryMhdViewDefault: next === "mhd" }),
      });
      if (!response.ok) throw new Error(MHD_SAVE_ERROR);
      await queryClient.invalidateQueries({ queryKey: key });
    } catch (error) {
      queryClient.setQueryData(key, prior);
      throw error;
    } finally {
      setSaving(false);
    }
  };
  return {
    mode,
    setMode,
    saving,
    isLoading,
    nameFor,
    sortRows,
    hasMhdView: lookup.size > 0,
    revision: data?.revision ?? 0,
  };
}
