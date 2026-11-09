/**
 * Per-workspace Help & Training catalogs. Each hook reads the exact navigation
 * the user's sidebar renders, so the guides follow company type, role, page
 * permissions, feature flags and hidden tabs without a second rule set.
 */
import { useMemo } from "react";
import { useCompany } from "@/contexts/CompanyContext";
import { useErpVisibleSections } from "@/components/AppSidebar";
import { useFactoryVisibleSections } from "@/components/FactorySidebar";
import { PROPERTIES_PINNED_DEFAULTS, getPropertiesVisibleNavSections } from "@/components/PropertiesSidebar";
import { canUsePropertiesCapability } from "@/properties/config/propertiesNavigation";
import { SUPPLIER_PARTNER_SECTIONS } from "@/lib/supplier-partner-navigation";
import { FACTORY_PINNED_PAGES } from "@shared/factoryAccessRegistry";
import type { PosNavItem } from "@/app/usePosNavigationItems";
import type { TrainingTopic } from "./trainingCatalog";
import { buildHelpTopics, factoryTabsByRoute, type HelpNavSection } from "./helpTrainingTopics";

interface HelpUser {
  username?: string | null;
  role?: string | null;
  currentRole?: string | null;
}

export function useErpHelpTopics(user: HelpUser | undefined): TrainingTopic[] {
  const { selectedCompany } = useCompany();
  const { sections, visiblePinnedItems, visibleUtilityItems } = useErpVisibleSections(user);
  const isSupplierPartner = selectedCompany?.companyType === "supplier_partner";
  return useMemo(() => {
    const all: HelpNavSection[] = [
      ...(isSupplierPartner ? SUPPLIER_PARTNER_SECTIONS : []),
      ...sections,
      { label: "Quick access", items: visiblePinnedItems },
      { label: "Tools", items: visibleUtilityItems },
    ];
    return buildHelpTopics("erp", all);
  }, [isSupplierPartner, sections, visiblePinnedItems, visibleUtilityItems]);
}

export function useFactoryHelpTopics(user: HelpUser | undefined): TrainingTopic[] {
  const { sections, isPinnedVisible, hiddenTabFields, seesAllTabs } = useFactoryVisibleSections(user);
  return useMemo(() => {
    const pinned = FACTORY_PINNED_PAGES.filter((page) => isPinnedVisible({ url: page.route })).map((page) => ({
      title: page.label,
      url: page.route,
    }));
    const all: HelpNavSection[] = [{ label: "Quick access", items: pinned }, ...sections];
    return buildHelpTopics("factory", all, factoryTabsByRoute(hiddenTabFields, seesAllTabs));
    // isPinnedVisible is recreated each render; its inputs are covered by sections and tab fields.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sections, hiddenTabFields, seesAllTabs]);
}

export function usePropertiesHelpTopics(user: HelpUser | undefined): TrainingTopic[] {
  const { selectedCompany } = useCompany();
  const isDeveloper = canUsePropertiesCapability("developer", user, selectedCompany);
  return useMemo(
    () =>
      buildHelpTopics("properties", [
        { label: "Quick access", items: PROPERTIES_PINNED_DEFAULTS },
        ...getPropertiesVisibleNavSections(isDeveloper),
      ]),
    [isDeveloper]
  );
}

export function posHelpTopics(items: readonly PosNavItem[]): TrainingTopic[] {
  const toItems = (group: PosNavItem["group"]) =>
    items.filter((item) => item.group === group).map((item) => ({ title: item.label, url: item.path }));
  return buildHelpTopics("pos", [
    { label: "Point of Sale", items: toItems("primary") },
    { label: "Tools", items: toItems("tools") },
  ]);
}
