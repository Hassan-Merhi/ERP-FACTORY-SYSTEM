// Extracted from ./AdvancedRestrictionsPanel.tsx
import { searchAny } from "@shared/searchNormalization";
import { useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { PERMISSION_CATALOG, type PermissionEntry } from "@shared/permissionConfig";
import {
  IS_NORMAL_USER,
  dbToChecked,
  checkedToDb,
  countActive,
  type RolePermissionRecord,
  type AdvancedRestrictionsPanelProps,
} from "./AdvancedRestrictionsPanelHelpers";

export function useAdvancedRestrictionsPanelState({
  role,
  companyId,
}: Pick<AdvancedRestrictionsPanelProps, "role" | "companyId">) {
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [openSections, setOpenSections] = useState<Set<string>>(new Set());

  const isNormal = IS_NORMAL_USER(role);
  const isPrivileged = role === "Developer" || role === "Admin";

  // ── Load current permissions ─────────────────────────────────────────────
  const { data: allPermissions = [], isLoading } = useQuery<RolePermissionRecord[]>({
    queryKey: ["/api/settings/role-permissions", companyId],
    queryFn: async () => {
      const res = await fetch(`/api/settings/role-permissions?companyId=${companyId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load permissions");
      return res.json();
    },
    enabled: !!companyId,
  });

  const permMap = useMemo(() => {
    const map = new Map<string, boolean>();
    allPermissions.forEach((p) => {
      if (p.role === role) map.set(p.featureKey, p.enabled);
    });
    return map;
  }, [allPermissions, role]);

  // ── Mutation ─────────────────────────────────────────────────────────────
  const updateMutation = useMutation({
    mutationFn: async (updates: { featureKey: string; enabled: boolean }[]) => {
      const res = await apiRequest("PUT", "/api/settings/role-permissions", {
        companyId,
        permissions: updates.map((u) => ({ role, featureKey: u.featureKey, enabled: u.enabled })),
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings/role-permissions", companyId] });
    },
    onError: (err: Error) => {
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    },
  });

  const toggleKey = (key: string, currentChecked: boolean) => {
    const newEnabled = checkedToDb(role, !currentChecked);
    updateMutation.mutate([{ featureKey: key, enabled: newEnabled }]);
  };

  const checkAllInGroup = (entries: PermissionEntry[], checked: boolean) => {
    const updates = entries.map((e) => ({
      featureKey: e.key,
      enabled: checkedToDb(role, checked),
    }));
    updateMutation.mutate(updates);
  };

  // ── Section open/close ───────────────────────────────────────────────────
  const toggleSection = (section: string) => {
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      return next;
    });
  };

  // ── Build filtered catalog ───────────────────────────────────────────────

  const hasSearch = search.trim().length > 0;
  const filteredCatalog = useMemo(() => {
    if (!hasSearch) return PERMISSION_CATALOG;
    return PERMISSION_CATALOG.filter((e) => searchAny(search, e.label, e.key, e.group, e.description));
  }, [hasSearch, search]);

  // Group filtered catalog by type then group
  const byType = useMemo(() => {
    const result: Record<string, Record<string, PermissionEntry[]>> = {};
    for (const entry of filteredCatalog) {
      if (!result[entry.type]) result[entry.type] = {};
      if (!result[entry.type][entry.group]) result[entry.type][entry.group] = [];
      result[entry.type][entry.group].push(entry);
    }
    return result;
  }, [filteredCatalog]);

  const activeCount = useMemo(() => countActive(role, permMap), [role, permMap]);

  // ── Helpers ───────────────────────────────────────────────────────────────
  const getChecked = (key: string) => dbToChecked(role, permMap.get(key));

  const groupAllChecked = (entries: PermissionEntry[]) => entries.every((e) => getChecked(e.key));
  const groupSomeChecked = (entries: PermissionEntry[]) => entries.some((e) => getChecked(e.key));
  return {
    search,
    setSearch,
    openSections,
    isNormal,
    isPrivileged,
    isLoading,
    updateMutation,
    toggleKey,
    checkAllInGroup,
    toggleSection,
    hasSearch,
    filteredCatalog,
    byType,
    activeCount,
    getChecked,
    groupAllChecked,
    groupSomeChecked,
  };
}
