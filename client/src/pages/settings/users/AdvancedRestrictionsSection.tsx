// Extracted from ./AdvancedRestrictions.tsx to keep that module under the source-size cap.
import { useState } from "react";
import { Check, ChevronDown, ChevronRight, X } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ALL_ERP_PAGES,
  ALL_FACTORY_PAGES,
  FACTORY_PAGE_GROUPS,
  FACTORY_TAB_GROUPS,
  FACTORY_TABS,
} from "./UserManagementConstants";
import type { SettingsUserRow } from "../settingsTypes";
import {
  FACTORY_EMPTY_CONTAINER_GRANT_KEY,
  FACTORY_TAB_GRANT_KEYS,
  type FactoryTabDefinition,
  isFactoryTabVisibleInProfile,
  setFactoryTabVisibleInProfile,
} from "@shared/factoryPermissionCatalog";

export interface AdvancedRestrictionsProps {
  user: SettingsUserRow;
  isPrivileged: boolean;
  isViewOnly: boolean;
  hasFactoryAccess: boolean;
  hasErpAccess: boolean;
  pageAccess: Set<string>;
  hiddenCostFields: string[];
  hiddenErpCostFields: string[];
  setPageAccess: (v: Set<string> | ((prev: Set<string>) => Set<string>)) => void;
  setHiddenCostFields: (v: string[] | ((prev: string[]) => string[])) => void;
  setHiddenErpCostFields: (v: string[] | ((prev: string[]) => string[])) => void;
  openTabGroups: Set<string>;
  toggleTabGroup: (group: string) => void;
}

export function useAdvancedRestrictionsState({
  user,
  isPrivileged,
  isViewOnly,
  hasFactoryAccess,
  hasErpAccess,
  pageAccess,
  hiddenCostFields,
  hiddenErpCostFields,
  setPageAccess,
  setHiddenCostFields,
  setHiddenErpCostFields,
  openTabGroups,
  toggleTabGroup,
}: AdvancedRestrictionsProps) {
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const togglePage = (key: string) => {
    setPageAccess((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleGroup = (group: string, pages: { key: string }[]) => {
    const allSelected = pages.every((p) => pageAccess.has(p.key));
    setPageAccess((prev) => {
      const next = new Set(prev);
      pages.forEach((p) => (allSelected ? next.delete(p.key) : next.add(p.key)));
      return next;
    });
  };

  const toggleCostField = (key: string) => {
    setHiddenCostFields((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  };

  const setFactoryTabsVisible = (tabs: readonly FactoryTabDefinition[], visible: boolean) => {
    setHiddenCostFields((prev) =>
      tabs.reduce((fields, tab) => setFactoryTabVisibleInProfile(fields, tab, visible), prev)
    );
  };

  const toggleErpCostField = (key: string) => {
    setHiddenErpCostFields((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  };

  // Opt-in tabs are hidden without a stored key, so count tabs by visibility.
  const factoryTabKeys = new Set(FACTORY_TABS.map((tab) => tab.key));
  const hiddenTabCount = isPrivileged
    ? 0
    : FACTORY_TABS.filter((tab) => !isFactoryTabVisibleInProfile(tab, hiddenCostFields)).length;
  const emptyContainerGranted =
    hasFactoryAccess && !isViewOnly && hiddenCostFields.includes(FACTORY_EMPTY_CONTAINER_GRANT_KEY);
  const hiddenFieldCount = isPrivileged
    ? 0
    : hiddenCostFields.filter(
        (key) =>
          !factoryTabKeys.has(key) && !FACTORY_TAB_GRANT_KEYS.has(key) && key !== FACTORY_EMPTY_CONTAINER_GRANT_KEY
      ).length;
  // View Only ERP access is automatic, so legacy ERP selections do not count
  // as active page restrictions in the user-management summary.
  const erpPageKeys = new Set(ALL_ERP_PAGES.map((page) => page.key));
  const relevantPageCount = isPrivileged
    ? 0
    : isViewOnly
      ? [...pageAccess].filter((key) => !erpPageKeys.has(key)).length
      : pageAccess.size;
  const restrictionCount =
    relevantPageCount +
    hiddenTabCount +
    hiddenFieldCount +
    (isPrivileged ? 0 : hiddenErpCostFields.length) +
    (isPrivileged ? 0 : Number(emptyContainerGranted));
  return {
    advancedOpen,
    emptyContainerGranted,
    hasErpAccess,
    hasFactoryAccess,
    hiddenCostFields,
    hiddenErpCostFields,
    hiddenFieldCount,
    hiddenTabCount,
    isPrivileged,
    isViewOnly,
    openTabGroups,
    pageAccess,
    relevantPageCount,
    restrictionCount,
    setAdvancedOpen,
    setFactoryTabsVisible,
    setHiddenCostFields,
    setPageAccess,
    toggleCostField,
    toggleErpCostField,
    toggleGroup,
    togglePage,
    toggleTabGroup,
    user,
  };
}

export function AdvancedRestrictionsSection({
  hiddenCostFields,
  openTabGroups,
  setFactoryTabsVisible,
  toggleTabGroup,
}: Pick<
  ReturnType<typeof useAdvancedRestrictionsState>,
  "hiddenCostFields" | "openTabGroups" | "setFactoryTabsVisible" | "toggleTabGroup"
>) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Factory Tabs</p>
        <div className="flex gap-1.5">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setFactoryTabsVisible(FACTORY_TABS, true)}
            data-testid="button-factory-tabs-show-all"
          >
            <Check className="h-3 w-3 mr-1" />
            Show All
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setFactoryTabsVisible(FACTORY_TABS, false)}
            data-testid="button-factory-tabs-hide-all"
          >
            <X className="h-3 w-3 mr-1" />
            Hide All
          </Button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Checked tabs are <strong>shown</strong> to this user. Uncheck a tab to hide it. Customer Loading is off by
        default and must be checked to grant access.
      </p>
      <div className="space-y-1">
        {FACTORY_TAB_GROUPS.map((group) => {
          const groupTabs = FACTORY_TABS.filter((t) => t.group === group);
          const visibleCount = groupTabs.filter((t) => isFactoryTabVisibleInProfile(t, hiddenCostFields)).length;
          const isOpen = openTabGroups.has(group);
          return (
            <Collapsible key={group} open={isOpen} onOpenChange={() => toggleTabGroup(group)}>
              <CollapsibleTrigger asChild>
                <div
                  className="flex items-center justify-between cursor-pointer select-none rounded-md px-2.5 py-1.5 bg-muted/30 hover-elevate"
                  data-testid={`group-tabs-${group.toLowerCase().replace(/\s+/g, "-")}`}
                >
                  <div className="flex items-center gap-2">
                    {isOpen ? (
                      <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                    )}
                    <span className="text-xs font-semibold">{group}</span>
                    <Badge variant="secondary" className="text-xs">
                      {visibleCount}/{groupTabs.length} shown
                    </Badge>
                  </div>
                  <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 text-xs px-2"
                      onClick={() => setFactoryTabsVisible(groupTabs, false)}
                      data-testid={`button-tabs-hide-all-${group}`}
                    >
                      Hide all
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 text-xs px-2"
                      onClick={() => setFactoryTabsVisible(groupTabs, true)}
                      data-testid={`button-tabs-show-all-${group}`}
                    >
                      Show all
                    </Button>
                  </div>
                </div>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-1 px-2 py-1.5 pl-8">
                  {groupTabs.map((tab) => (
                    <div key={tab.key} className="flex items-center gap-2">
                      <Checkbox
                        checked={isFactoryTabVisibleInProfile(tab, hiddenCostFields)}
                        onCheckedChange={(checked) => setFactoryTabsVisible([tab], checked === true)}
                        data-testid={`checkbox-tab-${tab.key}`}
                      />
                      <span className="text-sm">{tab.label}</span>
                    </div>
                  ))}
                </div>
              </CollapsibleContent>
            </Collapsible>
          );
        })}
      </div>
    </div>
  );
}

export function AdvancedRestrictionsSection2({
  pageAccess,
  setPageAccess,
  toggleGroup,
  togglePage,
}: Pick<
  ReturnType<typeof useAdvancedRestrictionsState>,
  "pageAccess" | "setPageAccess" | "toggleGroup" | "togglePage"
>) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Factory Pages</p>
        <div className="flex gap-1.5">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPageAccess((prev) => new Set([...prev, ...ALL_FACTORY_PAGES.map((p) => p.key)]))}
            data-testid="button-factory-pages-all"
          >
            <Check className="h-3 w-3 mr-1" />
            Select all
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setPageAccess((prev) => {
                const next = new Set(prev);
                ALL_FACTORY_PAGES.forEach((p) => next.delete(p.key));
                return next;
              })
            }
            data-testid="button-factory-pages-none"
          >
            <X className="h-3 w-3 mr-1" />
            Clear
          </Button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Checked pages are <strong>available</strong> to this user. If any Factory page is checked, only the checked
        Factory pages are available. Clear all Factory page checks for unrestricted Factory page access.
      </p>
      <div className="space-y-3 border rounded-md p-3 max-h-48 overflow-y-auto">
        {FACTORY_PAGE_GROUPS.map((group) => {
          const groupPages = ALL_FACTORY_PAGES.filter((p) => p.group === group);
          const allSel = groupPages.every((p) => pageAccess.has(p.key));
          const someSel = groupPages.some((p) => pageAccess.has(p.key));
          return (
            <div key={group} className="space-y-1.5">
              <div className="flex items-center gap-2">
                <Checkbox
                  checked={allSel}
                  onCheckedChange={() => toggleGroup(group, groupPages)}
                  data-testid={`checkbox-group-${group.toLowerCase().replace(/\s+/g, "-")}`}
                />
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{group}</span>
                {someSel && !allSel && (
                  <Badge variant="secondary" className="text-xs">
                    partial
                  </Badge>
                )}
              </div>
              <div className="ml-6 grid grid-cols-1 md:grid-cols-2 gap-1">
                {groupPages.map((page) => (
                  <div key={page.key} className="flex items-center gap-2">
                    <Checkbox
                      checked={pageAccess.has(page.key)}
                      onCheckedChange={() => togglePage(page.key)}
                      data-testid={`checkbox-page-${page.key.replace(/\//g, "-")}`}
                    />
                    <span className="text-sm">{page.label}</span>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
