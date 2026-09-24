import { searchAny } from "@shared/searchNormalization";
/**
 * AdvancedRestrictionsPanel
 *
 * A self-contained, role-aware restrictions editor that reads/writes
 * the role_feature_permissions table via /api/settings/role-permissions.
 *
 * Checkbox semantics per role:
 *   Owner / Manager / POS  → checked = restriction active   (stored enabled=false)
 *   Normal User            → checked = access granted       (stored enabled=true)
 *
 * Developer / Admin rows are not editable (always full access).
 */

import { useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Loader2, ChevronDown, ChevronRight, Search, Shield, Info } from "lucide-react";
import {
  PERMISSION_CATALOG,
  PERMISSION_TYPE_LABELS,
  UNCONFIGURED_PERMISSIONS,
  type PermissionEntry,
  type PermissionType,
} from "@shared/permissionConfig";

interface RolePermissionRecord {
  role: string;
  featureKey: string;
  enabled: boolean;
}

interface AdvancedRestrictionsPanelProps {
  role: string;
  companyId: number;
  companyName?: string;
}

const IS_NORMAL_USER = (role: string) => role === "Normal User";

/**
 * For a given role and DB-stored enabled value, determine whether the
 * checkbox should appear checked in the UI.
 *
 *   Owner/Manager/POS → checkbox = restriction; checked means enabled=false in DB
 *   Normal User       → checkbox = grant;       checked means enabled=true in DB
 */
function dbToChecked(role: string, enabled: boolean | undefined): boolean {
  if (IS_NORMAL_USER(role)) {
    return enabled === true;
  }
  return enabled === false;
}

/**
 * Convert a UI checkbox state back to the DB enabled value.
 */
function checkedToDb(role: string, checked: boolean): boolean {
  if (IS_NORMAL_USER(role)) {
    return checked; // checked = granted = true
  }
  return !checked; // checked = restricted = false
}

/**
 * Returns how many restrictions/grants are active for this role given the
 * permission map.
 */
function countActive(role: string, permMap: Map<string, boolean>): number {
  let count = 0;
  for (const entry of PERMISSION_CATALOG) {
    const stored = permMap.get(entry.key);
    if (IS_NORMAL_USER(role)) {
      if (stored === true) count++;
    } else {
      if (stored === false) count++;
    }
  }
  return count;
}

const TYPE_ORDER: PermissionType[] = ["module", "page", "tab", "action", "sensitive", "export", "pos"];

export function AdvancedRestrictionsPanel({ role, companyId, companyName }: AdvancedRestrictionsPanelProps) {
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
      toast({ title: "Error", description: err.message, variant: "destructive" });
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

  const filteredCatalog = useMemo(() => {
    if (!searchLower) return PERMISSION_CATALOG;
    return PERMISSION_CATALOG.filter(
      (e) =>
        e.label.toLowerCase().includes(searchLower) ||
        e.key.toLowerCase().includes(searchLower) ||
        e.group.toLowerCase().includes(searchLower) ||
        (e.description?.toLowerCase().includes(searchLower) ?? false)
    );
  }, [searchLower]);

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

  if (isPrivileged) {
    return (
      <div className="flex items-start gap-2 rounded-md border bg-muted/20 px-3 py-2.5 text-sm text-muted-foreground">
        <Shield className="h-4 w-4 mt-0.5 shrink-0" />
        <span>
          <strong>{role}</strong> accounts always have full access. Advanced restrictions do not apply.
        </span>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-4 text-muted-foreground text-sm">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading restrictions…
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Header / helper text */}
      <div className="space-y-1">
        {isNormal ? (
          <p className="text-xs text-muted-foreground bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-md px-3 py-2">
            <strong>Normal User</strong> has no access by default. Select what this user is allowed to access. Checked
            items are visible/accessible.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            Checked items are hidden or restricted from users with the <strong>{role}</strong> role
            {companyName ? ` at ${companyName}` : ""}.
          </p>
        )}
        {activeCount > 0 && (
          <Badge variant="secondary" className="text-xs">
            {activeCount} {isNormal ? "granted" : "restricted"}
          </Badge>
        )}
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
        <Input
          placeholder="Search permissions…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-8 h-8 text-xs"
          data-testid="input-permission-search"
        />
      </div>

      {/* Sections by type */}
      {TYPE_ORDER.map((type) => {
        if (!byType[type]) return null;
        const typeLabel = PERMISSION_TYPE_LABELS[type];
        const sectionKey = `type-${type}`;
        const isOpen = openSections.has(sectionKey) || !!searchLower;
        const allGroupNames = Object.keys(byType[type]);
        const allEntriesInType = allGroupNames.flatMap((g) => byType[type][g]);
        const someChecked = allEntriesInType.some((e) => getChecked(e.key));

        return (
          <Collapsible key={type} open={isOpen} onOpenChange={() => toggleSection(sectionKey)}>
            <CollapsibleTrigger asChild>
              <div
                className="flex items-center justify-between cursor-pointer select-none rounded-md px-3 py-2 bg-muted/30 hover-elevate"
                data-testid={`section-${type}`}
              >
                <div className="flex items-center gap-2">
                  {isOpen ? (
                    <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                  )}
                  <span className="text-xs font-semibold">{typeLabel}</span>
                  {someChecked && !isNormal && (
                    <Badge variant="secondary" className="text-xs">
                      restricted
                    </Badge>
                  )}
                  {someChecked && isNormal && (
                    <Badge variant="secondary" className="text-xs">
                      granted
                    </Badge>
                  )}
                </div>
                <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 text-xs px-2"
                    onClick={() => checkAllInGroup(allEntriesInType, true)}
                    disabled={updateMutation.isPending}
                    data-testid={`button-check-all-${type}`}
                  >
                    {isNormal ? "Allow all" : "Restrict all"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 text-xs px-2"
                    onClick={() => checkAllInGroup(allEntriesInType, false)}
                    disabled={updateMutation.isPending}
                    data-testid={`button-uncheck-all-${type}`}
                  >
                    {isNormal ? "Deny all" : "Allow all"}
                  </Button>
                </div>
              </div>
            </CollapsibleTrigger>

            <CollapsibleContent>
              <div className="space-y-3 mt-1 pl-2">
                {allGroupNames.map((groupName) => {
                  const entries = byType[type][groupName];
                  const allChecked = groupAllChecked(entries);
                  const someGroupChecked = groupSomeChecked(entries);

                  return (
                    <div key={groupName} className="space-y-1.5">
                      {/* Group header */}
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <Checkbox
                            checked={allChecked}
                            onCheckedChange={(v) => checkAllInGroup(entries, !!v)}
                            disabled={updateMutation.isPending}
                            data-testid={`checkbox-group-${groupName.toLowerCase().replace(/\s+/g, "-")}`}
                          />
                          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                            {groupName}
                          </span>
                          {someGroupChecked && !allChecked && (
                            <Badge variant="secondary" className="text-xs">
                              partial
                            </Badge>
                          )}
                        </div>
                      </div>

                      {/* Items */}
                      <div className="ml-6 grid grid-cols-1 gap-1">
                        {entries.map((entry) => {
                          const checked = getChecked(entry.key);
                          return (
                            <div key={entry.key} className="flex items-start gap-2">
                              <Checkbox
                                checked={checked}
                                onCheckedChange={() => toggleKey(entry.key, checked)}
                                disabled={updateMutation.isPending}
                                data-testid={`checkbox-perm-${entry.key}`}
                                className="mt-0.5 shrink-0"
                              />
                              <div className="flex-1 min-w-0">
                                <span className="text-sm">{entry.label}</span>
                                {entry.description && (
                                  <p className="text-xs text-muted-foreground">{entry.description}</p>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </CollapsibleContent>
          </Collapsible>
        );
      })}

      {/* Unconfigured section */}
      {UNCONFIGURED_PERMISSIONS.length > 0 && !searchLower && (
        <div className="rounded-md border border-dashed px-3 py-2.5 space-y-1">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Info className="h-3.5 w-3.5" />
            <span className="font-semibold uppercase tracking-wide">Auto-detected / Unconfigured</span>
          </div>
          <p className="text-xs text-muted-foreground ml-5">
            These pages/routes exist in the app but haven't been formally catalogued yet.
          </p>
          <div className="ml-5 space-y-1 mt-2">
            {UNCONFIGURED_PERMISSIONS.map((entry) => {
              const checked = getChecked(entry.key);
              return (
                <div key={entry.key} className="flex items-center gap-2">
                  <Checkbox
                    checked={checked}
                    onCheckedChange={() => toggleKey(entry.key, checked)}
                    disabled={updateMutation.isPending}
                    data-testid={`checkbox-perm-${entry.key}`}
                  />
                  <span className="text-sm text-muted-foreground">{entry.label}</span>
                  <Badge variant="outline" className="text-xs">
                    unconfigured
                  </Badge>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {filteredCatalog.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-3">No permissions match your search.</p>
      )}

      {updateMutation.isPending && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          Saving…
        </div>
      )}
    </div>
  );
}
