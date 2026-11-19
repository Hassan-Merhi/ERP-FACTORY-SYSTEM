// Extracted from ./Settings.tsx
import { useHubQueryState } from "@/hooks/use-hub-query-state";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useAppMode } from "@/contexts/AppModeContext";
import { useCompany } from "@/contexts/CompanyContext";
import {
  Building2,
  Users,
  Settings2,
  Shield,
  Database,
  History,
  Upload,
  Zap,
  ShoppingCart,
  TrendingUp,
  Wrench,
  MapPin,
  CalendarClock,
  MessageSquareText,
  LayoutPanelLeft,
  Printer,
  Images,
  Clock,
  Snowflake,
  FileSpreadsheet,
} from "lucide-react";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { getExcelAppearanceCopy } from "@/i18n/excelAppearanceTranslations";
import type { Company } from "@shared/schema";
import type { LucideIcon } from "lucide-react";

interface SettingsSidebarItem {
  key: string;
  label: string;
  icon: LucideIcon;
  devOnly?: boolean;
  adminOnly?: boolean;
  href?: string;
}

export function useSettingsState() {
  const { language } = useApplicationLanguage();
  const excelAppearanceCopy = getExcelAppearanceCopy(language);
  const [, navigate] = useLocation();
  const companyContext = useCompany();
  const selectedCompany = companyContext?.selectedCompany ?? null;
  const appMode = useAppMode();

  const { data: companies = [] } = useQuery<Company[]>({
    queryKey: ["/api/companies"],
  });

  const { data: currentUser } = useQuery<{ role?: string; currentRole?: string; id: string }>({
    queryKey: ["/api/auth/me"],
  });

  const showSupplierTrackingDefaults = appMode === "erp" && selectedCompany?.companyType !== "supplier_partner";

  const canManageCompanyTimezone = ["Admin", "Owner", "Developer"].includes(currentUser?.role ?? "");
  const canManageSessions = ["Admin", "Owner", "Developer"].includes(currentUser?.role ?? "");
  const effectiveRole = currentUser?.currentRole ?? selectedCompany?.role ?? currentUser?.role ?? "";
  const isDeveloperMode = effectiveRole === "Developer";
  const canAccessSystemTools = isDeveloperMode || effectiveRole === "Admin";
  const canAccessAdminSections = canManageSessions && ["Admin", "Owner", "Developer"].includes(effectiveRole);

  const sidebarGroups = [
    {
      label: "General",
      items: [
        { key: "companies", label: "Companies", icon: Building2 },
        { key: "floating-widgets", label: "Floating Widgets", icon: LayoutPanelLeft },
        { key: "appearance-seasonal", label: "Appearance & Seasonal", icon: Snowflake, devOnly: true },
        { key: "preferences", label: "Preferences", icon: Settings2, adminOnly: true },
      ],
    },
    {
      label: "Users & Access",
      items: [
        { key: "users-permissions", label: "Users & Permissions", icon: Users },
        { key: "sessions-hub", label: "Sessions & Users", icon: Shield, devOnly: true },
      ],
    },
    {
      label: "Tracking",
      items: showSupplierTrackingDefaults
        ? [{ key: "supplier-tracking-defaults", label: "Supplier Defaults", icon: MapPin, devOnly: true }]
        : [],
    },
    {
      label: "WhatsApp",
      items: isDeveloperMode
        ? [{ key: "scheduled-whatsapp-messages", label: "Scheduled Messages", icon: MessageSquareText, devOnly: true }]
        : [],
    },
    {
      label: "Accounting",
      items: [{ key: "recurring-journals", label: "Recurring Journals", icon: CalendarClock, devOnly: true }],
    },
    {
      label: "Tools",
      items: [
        { key: "data-tools", label: "Data Tools", icon: Database, devOnly: true },
        { key: "edit-log", label: "Edit Log", icon: History },
        { key: "files-export", label: "Files & Export", icon: Upload },
        { key: "export-center", label: "Export Center", icon: Zap },
        { key: "excel-appearance", label: excelAppearanceCopy.title, icon: FileSpreadsheet, devOnly: true },
      ],
    },
    {
      label: "POS",
      items: appMode !== "factory" ? [{ key: "pos-setup", label: "POS Setup", icon: ShoppingCart, devOnly: true }] : [],
    },
    {
      label: "Factory",
      items:
        appMode === "factory"
          ? [
              {
                key: "automatic-priority-printing",
                label: "Automatic Priority Printing",
                icon: Printer,
                adminOnly: true,
              },
              {
                key: "label-banner-images",
                label: "Label Banner Images",
                icon: Images,
                href: "/factory/label-banners",
                adminOnly: true,
              },
              { key: "fx-rates", label: "FX Rates", icon: TrendingUp },
              ...(canManageCompanyTimezone
                ? [{ key: "company-timezone", label: "Company Timezone", icon: Clock, adminOnly: true }]
                : []),
            ]
          : [],
    },
    {
      label: "System",
      items: [{ key: "system", label: "System Tools", icon: Wrench }],
    },
  ];

  const allowedItems = (items: SettingsSidebarItem[]) =>
    items.filter(
      (item) =>
        (!item.devOnly || isDeveloperMode) &&
        (!item.adminOnly || canAccessAdminSections) &&
        (item.key !== "system" || canAccessSystemTools)
    );
  // Non-developers should never see headings with no accessible Settings pages.
  // Developers retain the full Settings taxonomy, including empty groups.
  const visibleSidebarGroups = sidebarGroups
    .map((group) => ({ ...group, items: allowedItems(group.items) }))
    .filter((group) => isDeveloperMode || group.items.length > 0);

  // The open section lives in ?section= so a reload or shared link reopens it.
  // Until the signed-in user loads, role-gated sections are kept, not stripped.
  const knownSectionKeys = sidebarGroups.flatMap((group) =>
    (group.items as SettingsSidebarItem[]).filter((item) => !item.href).map((item) => item.key)
  );
  const allowedSectionKeys = sidebarGroups.flatMap((group) =>
    allowedItems(group.items)
      .filter((item) => !item.href)
      .map((item) => item.key)
  );
  const [activeSection, setActiveSection] = useHubQueryState<string>({
    key: "section",
    allowedValues: currentUser ? allowedSectionKeys : knownSectionKeys,
    knownValues: knownSectionKeys,
    defaultValue: "users-permissions",
    clearKeys: ["tab"],
    omitDefault: true,
  });

  const openSection = (key: string) => {
    const item = visibleSidebarGroups.flatMap((group) => group.items).find((entry) => entry.key === key);
    if (!item) return;
    if (item.href) {
      navigate(item.href);
      return;
    }
    setActiveSection(key);
  };

  const activeSectionLabel = visibleSidebarGroups
    .flatMap((group) => group.items)
    .find((item) => item.key === activeSection)?.label;
  return {
    selectedCompany,
    appMode,
    companies,
    showSupplierTrackingDefaults,
    canManageCompanyTimezone,
    effectiveRole,
    isDeveloperMode,
    canAccessSystemTools,
    canAccessAdminSections,
    visibleSidebarGroups,
    activeSection,
    openSection,
    activeSectionLabel,
  };
}
