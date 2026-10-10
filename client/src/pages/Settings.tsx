import type { ClientErrorLike } from "@/lib/clientError";
import { PageHeader } from "@/components/PageHeader";
import { useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { useMutation, useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { useAppMode } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import { useDateFormat } from "@/contexts/DateFormatContext";
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
  LayoutPanelLeft,
  Printer,
} from "lucide-react";

import { FxRatesCard } from "./settings/FxRatesCard";
import { CompaniesTab } from "./settings/CompaniesTab";
import { SystemToolsTab } from "./settings/SystemToolsTab";
import { PreferencesTab } from "./settings/PreferencesTab";
import { EditLogTab } from "./settings/EditLogTab";
import { SessionsHub } from "./settings/SessionsHub";
import { DataToolsTab } from "./settings/DataToolsTab";
import { PosSetupHub } from "./settings/PosSetupHub";
import { FileStorageAndExport } from "./settings/FileStorageAndExport";
import { ExportCenter } from "./settings/ExportCenter";
import { UsersPermissionsHub } from "./settings/UsersPermissionsHub";
import { SupplierTrackingDefaultsTab } from "./settings/SupplierTrackingDefaultsTab";
import { RecurringJournalsTab } from "./settings/RecurringJournalsTab";
import { AutomaticPriorityPrintingCard } from "./factory/factorysettings/AutomaticPriorityPrintingCard";
import { useUserPreferences } from "@/hooks/use-user-preferences";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { Company } from "@shared/schema";
import type { LucideIcon } from "lucide-react";

interface SettingsUserToDelete {
  id: string;
  username?: string;
}

interface SettingsSidebarItem {
  key: string;
  label: string;
  icon: LucideIcon;
  devOnly?: boolean;
}

export default function Settings() {
  const { toast } = useToast();
  const companyContext = useCompany();
  const selectedCompany = companyContext?.selectedCompany ?? null;
  const { dateFormat, setDateFormat, isPending: isDateFormatPending } = useDateFormat();
  const appMode = useAppMode();
  const modeApiRequest = getApiRequest(appMode);
  const [activeSection, setActiveSection] = useState("users-permissions");
  const [userToDelete, setUserToDelete] = useState<SettingsUserToDelete | null>(null);
  const { prefs, updatePref, isPending: prefsPending } = useUserPreferences();

  const { data: companies = [], isLoading: _isLoadingCompanies } = useQuery<Company[]>({
    queryKey: ["/api/companies"],
  });

  const { data: currentUser } = useQuery<{ role?: string; id: string }>({
    queryKey: ["/api/auth/me"],
  });

  const deleteUserMutation = useMutation({
    mutationFn: async (userId: string) => {
      const res = await modeApiRequest("DELETE", `/api/users/${userId}`);
      return await res.json();
    },
    onSuccess: () => {
      toast({ title: "Success", description: "User deleted successfully" });
      queryClient.invalidateQueries({ queryKey: ["/api/users"] });
      setUserToDelete(null);
    },
    onError: (error: ClientErrorLike) => {
      toast({ title: "Error", description: error.message || "Failed to delete user", variant: "destructive" });
    },
  });

  const showSupplierTrackingDefaults = appMode === "erp" && selectedCompany?.companyType !== "supplier_partner";

  const sidebarGroups = [
    {
      label: "General",
      items: [
        { key: "companies", label: "Companies", icon: Building2 },
        { key: "floating-widgets", label: "Floating Widgets", icon: LayoutPanelLeft },
        { key: "preferences", label: "Preferences", icon: Settings2, devOnly: true },
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
        ? [{ key: "supplier-tracking-defaults", label: "Supplier Defaults", icon: MapPin }]
        : [],
    },
    {
      label: "Accounting",
      items: [{ key: "recurring-journals", label: "Recurring Journals", icon: CalendarClock }],
    },
    {
      label: "Tools",
      items: [
        { key: "data-tools", label: "Data Tools", icon: Database, devOnly: true },
        { key: "edit-log", label: "Edit Log", icon: History },
        { key: "files-export", label: "Files & Export", icon: Upload },
        { key: "export-center", label: "Export Center", icon: Zap },
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
              { key: "automatic-priority-printing", label: "Automatic Priority Printing", icon: Printer },
              { key: "fx-rates", label: "FX Rates", icon: TrendingUp },
            ]
          : [],
    },
    {
      label: "System",
      items: [{ key: "system", label: "System Tools", icon: Wrench }],
    },
  ];

  const allowedItems = (items: SettingsSidebarItem[]) =>
    items.filter((item) => !item.devOnly || currentUser?.role === "Developer");
  const canManageTrackingDefaults = ["Admin", "Owner", "Developer"].includes(currentUser?.role ?? "");

  const activeSectionLabel = sidebarGroups
    .flatMap((group) => allowedItems(group.items))
    .find((item) => item.key === activeSection)?.label;

  return (
    <div className="flex flex-col sm:h-full">
      {appMode === "erp" && (
        <div className="shrink-0 sm:px-6 sm:pt-4">
          <PageHeader title="Settings" meta={activeSectionLabel ? <span>{activeSectionLabel}</span> : undefined} />
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        <div className="sm:hidden border-b pb-3 flex items-center gap-2">
          <Select value={activeSection} onValueChange={setActiveSection}>
            <SelectTrigger className="flex-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {sidebarGroups.map((group) =>
                allowedItems(group.items).map((item) => (
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
            {sidebarGroups.map((group) => (
              <div key={group.label}>
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider px-2 mb-1">
                  {group.label}
                </p>
                <div className="space-y-0.5">
                  {allowedItems(group.items).map((item) => {
                    const Icon = item.icon;
                    return (
                      <button
                        key={item.key}
                        onClick={() => setActiveSection(item.key)}
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
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Floating tools</CardTitle>
                  <CardDescription>These controls apply to your account across the ERP.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
                    <div>
                      <p className="text-sm font-medium leading-none">AI Agent Chatbot</p>
                      <p className="text-xs text-muted-foreground mt-1">Show the floating AI chat bubble.</p>
                    </div>
                    <Switch
                      checked={prefs?.showChatWidget !== false}
                      disabled={prefsPending}
                      onCheckedChange={(value) => {
                        updatePref({ showChatWidget: value });
                        toast({
                          title: value ? "AI assistant enabled" : "AI assistant hidden",
                          description: value
                            ? "The floating AI chat bubble is now visible."
                            : "The floating AI chat bubble has been turned off.",
                        });
                      }}
                      data-testid="settings-switch-show-chat-widget"
                    />
                  </div>
                  <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
                    <div>
                      <p className="text-sm font-medium leading-none">My Notes</p>
                      <p className="text-xs text-muted-foreground mt-1">Show the floating My Notes button.</p>
                    </div>
                    <Switch
                      checked={prefs?.showNotesPanel !== false}
                      disabled={prefsPending}
                      onCheckedChange={(value) => {
                        updatePref({ showNotesPanel: value });
                        toast({
                          title: value ? "My Notes enabled" : "My Notes hidden",
                          description: value
                            ? "The floating My Notes button is now visible."
                            : "The floating My Notes button has been turned off.",
                        });
                      }}
                      data-testid="settings-switch-show-notes-panel"
                    />
                  </div>
                </CardContent>
              </Card>
            </div>
          )}
          {activeSection === "users-permissions" && (
            <UsersPermissionsHub userRole={currentUser?.role} appMode={appMode} />
          )}
          {activeSection === "sessions-hub" && currentUser?.role === "Developer" && (
            <SessionsHub isAdmin={true} isDev={true} />
          )}
          {activeSection === "supplier-tracking-defaults" && showSupplierTrackingDefaults && (
            <SupplierTrackingDefaultsTab canManage={canManageTrackingDefaults} />
          )}
          {activeSection === "recurring-journals" && <RecurringJournalsTab />}
          {activeSection === "edit-log" && <EditLogTab selectedCompany={selectedCompany} />}
          {activeSection === "data-tools" && currentUser?.role === "Developer" && <DataToolsTab />}
          {activeSection === "pos-setup" && currentUser?.role === "Developer" && (
            <PosSetupHub userRole={currentUser?.role} />
          )}
          {activeSection === "automatic-priority-printing" && appMode === "factory" && (
            <div className="space-y-5 max-w-3xl">
              <AutomaticPriorityPrintingCard />
            </div>
          )}
          {activeSection === "fx-rates" && appMode === "factory" && (
            <div className="space-y-5 max-w-2xl">
              <FxRatesCard />
            </div>
          )}
          {activeSection === "files-export" && <FileStorageAndExport />}
          {activeSection === "export-center" && <ExportCenter />}
          {activeSection === "preferences" && (
            <PreferencesTab
              dateFormat={dateFormat}
              setDateFormat={setDateFormat}
              isDateFormatPending={isDateFormatPending}
            />
          )}
          {activeSection === "system" && (
            <SystemToolsTab
              appMode={appMode}
              currentUser={currentUser}
              selectedCompany={selectedCompany}
              companies={companies}
            />
          )}

          <AlertDialog open={!!userToDelete} onOpenChange={(open) => !open && setUserToDelete(null)}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete User</AlertDialogTitle>
                <AlertDialogDescription>
                  Are you sure you want to delete {userToDelete?.username}?
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => userToDelete && deleteUserMutation.mutate(userToDelete.id)}
                  className="bg-destructive text-destructive-foreground"
                >
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>
    </div>
  );
}
