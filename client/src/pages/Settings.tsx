import { useHubQueryState } from "@/hooks/use-hub-query-state";
import { PageHeader } from "@/components/PageHeader";
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

import { FxRatesCard } from "./settings/FxRatesCard";
import { CompanyTimezoneCard } from "./settings/CompanyTimezoneCard";
import { CompaniesTab } from "./settings/CompaniesTab";
import { SystemToolsTab } from "./settings/SystemToolsTab";
import { PreferencesTab } from "./settings/PreferencesTab";
import { ChristmasModeSettingsCard } from "./settings/ChristmasModeSettingsCard";
import { EditLogTab } from "./settings/EditLogTab";
import { SessionsHub } from "./settings/SessionsHub";
import { DataToolsTab } from "./settings/DataToolsTab";
import { PosSetupHub } from "./settings/PosSetupHub";
import { FileStorageAndExport } from "./settings/FileStorageAndExport";
import { ExportCenter } from "./settings/ExportCenter";
import { ExcelAppearanceSettingsTab } from "./settings/ExcelAppearanceSettingsTab";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { getExcelAppearanceCopy } from "@/i18n/excelAppearanceTranslations";
import { UsersPermissionsHub } from "./settings/UsersPermissionsHub";
import { SupplierTrackingDefaultsTab } from "./settings/SupplierTrackingDefaultsTab";
import { RecurringJournalsTab } from "./settings/RecurringJournalsTab";
import { ScheduledWhatsAppMessagesTab } from "./settings/ScheduledWhatsAppMessagesTab";
import { AutomaticPriorityPrintingCard } from "./factory/factorysettings/AutomaticPriorityPrintingCard";
import { FloatingWidgetsSettingsCard } from "./settings/FloatingWidgetsSettingsCard";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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

export default function Settings() {
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
                devOnly: true,
              },
              {
                key: "label-banner-images",
                label: "Label Banner Images",
                icon: Images,
                href: "/factory/label-banners",
                devOnly: true,
              },
              { key: "fx-rates", label: "FX Rates", icon: TrendingUp, devOnly: true },
              ...(canManageCompanyTimezone
                ? [{ key: "company-timezone", label: "Company Timezone", icon: Clock, devOnly: true }]
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
        (!item.adminOnly || canManageSessions) &&
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

  return (
    <div className="flex flex-col sm:h-full">
      <div className="shrink-0 sm:px-6 sm:pt-4">
        <PageHeader title="Settings" meta={activeSectionLabel ? <span>{activeSectionLabel}</span> : undefined} />
      </div>
      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        <div className="sm:hidden border-b pb-3 flex items-center gap-2">
          <Select value={activeSection} onValueChange={openSection}>
            <SelectTrigger className="flex-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {visibleSidebarGroups.map((group) =>
                group.items.map((item) => (
                  <SelectItem key={item.key} value={item.key}>
                    {item.label}
                  </SelectItem>
                ))
              )}
            </SelectContent>
          </Select>
        </div>

        <nav className="hidden sm:flex sm:flex-col w-56 shrink-0 border-r bg-muted/30 p-3 gap-3 overflow-y-auto">
          <div className="space-y-4">
            {visibleSidebarGroups.map((group) => (
              <div key={group.label}>
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider px-2 mb-1">
                  {group.label}
                </p>
                <div className="space-y-0.5">
                  {group.items.map((item) => {
                    const Icon = item.icon;
                    return (
                      <button
                        key={item.key}
                        onClick={() => openSection(item.key)}
                        className={`flex items-center gap-2 w-full rounded-md px-2 py-1.5 text-sm transition-colors ${activeSection === item.key ? "bg-background font-medium shadow-xs" : "text-muted-foreground hover:bg-muted/50"}`}
                      >
                        <Icon className="h-4 w-4 shrink-0" />
                        <span className="truncate">{item.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </nav>

        <div className="flex-1 sm:overflow-y-auto py-3 sm:p-6">
          {activeSection === "companies" && <CompaniesTab />}
          {activeSection === "appearance-seasonal" && isDeveloperMode && <ChristmasModeSettingsCard />}
          {activeSection === "floating-widgets" && (
            <div className="space-y-5 max-w-2xl">
              <div>
                <h2 className="text-2xl font-semibold flex items-center gap-2">
                  <LayoutPanelLeft className="h-5 w-5" />
                  Floating Widgets
                </h2>
                <p className="text-muted-foreground text-sm mt-1">
                  Turn the floating AI assistant and My Notes buttons on or off.
                </p>
              </div>
              <FloatingWidgetsSettingsCard testIdPrefix="settings-" />
            </div>
          )}
          {activeSection === "users-permissions" && <UsersPermissionsHub userRole={effectiveRole} appMode={appMode} />}
          {activeSection === "sessions-hub" && isDeveloperMode && (
            <SessionsHub isAdmin={true} isDev={isDeveloperMode} />
          )}
          {activeSection === "supplier-tracking-defaults" && isDeveloperMode && showSupplierTrackingDefaults && (
            <SupplierTrackingDefaultsTab canManage={true} />
          )}
          {activeSection === "recurring-journals" && isDeveloperMode && <RecurringJournalsTab />}
          {activeSection === "scheduled-whatsapp-messages" && isDeveloperMode && <ScheduledWhatsAppMessagesTab />}
          {activeSection === "edit-log" && <EditLogTab selectedCompany={selectedCompany} />}
          {activeSection === "data-tools" && isDeveloperMode && <DataToolsTab />}
          {activeSection === "pos-setup" && isDeveloperMode && <PosSetupHub userRole={effectiveRole} />}
          {activeSection === "automatic-priority-printing" && isDeveloperMode && appMode === "factory" && (
            <div className="space-y-5 max-w-3xl">
              <AutomaticPriorityPrintingCard />
            </div>
          )}
          {activeSection === "fx-rates" && isDeveloperMode && appMode === "factory" && (
            <div className="space-y-5 max-w-2xl">
              <FxRatesCard />
            </div>
          )}
          {activeSection === "company-timezone" &&
            isDeveloperMode &&
            appMode === "factory" &&
            canManageCompanyTimezone && (
              <div className="space-y-5 max-w-2xl">
                <CompanyTimezoneCard />
              </div>
            )}
          {activeSection === "files-export" && <FileStorageAndExport />}
          {activeSection === "export-center" && <ExportCenter />}
          {activeSection === "excel-appearance" && isDeveloperMode && (
            <ExcelAppearanceSettingsTab company={selectedCompany} />
          )}
          {activeSection === "preferences" && <PreferencesTab />}
          {activeSection === "system" && canAccessSystemTools && (
            <SystemToolsTab
              appMode={appMode}
              currentUser={{ role: effectiveRole }}
              selectedCompany={selectedCompany}
              companies={companies}
            />
          )}
        </div>
      </div>
    </div>
  );
}
