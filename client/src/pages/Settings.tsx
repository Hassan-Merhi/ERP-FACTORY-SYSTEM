import { PageHeader } from "@/components/PageHeader";
import { LayoutPanelLeft } from "lucide-react";

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
import { UsersPermissionsHub } from "./settings/UsersPermissionsHub";
import { SupplierTrackingDefaultsTab } from "./settings/SupplierTrackingDefaultsTab";
import { RecurringJournalsTab } from "./settings/RecurringJournalsTab";
import { ScheduledWhatsAppMessagesTab } from "./settings/ScheduledWhatsAppMessagesTab";
import { AutomaticPriorityPrintingCard } from "./factory/factorysettings/AutomaticPriorityPrintingCard";
import { FloatingWidgetsSettingsCard } from "./settings/FloatingWidgetsSettingsCard";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useSettingsState } from "./useSettingsState";

export default function Settings() {
  const {
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
  } = useSettingsState();

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
          {activeSection === "automatic-priority-printing" && canAccessAdminSections && appMode === "factory" && (
            <div className="space-y-5 max-w-3xl">
              <AutomaticPriorityPrintingCard />
            </div>
          )}
          {activeSection === "fx-rates" && appMode === "factory" && (
            <div className="space-y-5 max-w-2xl">
              <FxRatesCard />
            </div>
          )}
          {activeSection === "company-timezone" &&
            canAccessAdminSections &&
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
