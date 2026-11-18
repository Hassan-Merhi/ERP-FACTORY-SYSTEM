// Extracted from ./AdvancedRestrictionsSection.tsx
import { useState } from "react";
import { ALL_ERP_PAGES, FACTORY_TABS } from "./UserManagementConstants";
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
