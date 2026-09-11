import type { ClientErrorLike } from "@/lib/clientError";
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

export default function Settings() {
  const { toast } = useToast();
  const companyContext = useCompany();
  const selectedCompany = companyContext?.selectedCompany ?? null;
  const { dateFormat, setDateFormat, isPending: isDateFormatPending } = useDateFormat();
  const appMode = useAppMode();
  const modeApiRequest = getApiRequest(appMode);
  const [activeSection, setActiveSection] = useState("users-permissions");
  const [userToDelete, setUserToDelete] = useState<any>(null);

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
      items: appMode === "factory" ? [{ key: "fx-rates", label: "FX Rates", icon: TrendingUp }] : [],
    },
    {
      label: "System",
      items: [{ key: "system", label: "System Tools", icon: Wrench }],
    },
  ];

  const allowedItems = (items: any[]) => items.filter((item) => !item.devOnly || currentUser?.role === "Developer");
  const canManageTrackingDefaults = ["Admin", "Owner", "Developer"].includes(currentUser?.role ?? "");

  return (
    <div className="flex flex-col sm:flex-row sm:h-full">
      <div className="sm:hidden border-b p-3 flex items-center gap-2">
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
                      className={`flex items-center gap-2 w-full rounded-md px-2 py-1.5 text-sm transition-colors ${activeSection === item.key ? "bg-background font-medium shadow-sm" : "text-muted-foreground hover:bg-muted/50"}`}
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

      <div className="flex-1 sm:overflow-y-auto p-4 sm:p-6">
        {activeSection === "companies" && <CompaniesTab />}
        {activeSection === "users-permissions" && (
          <UsersPermissionsHub userRole={currentUser?.role} appMode={appMode} />
        )}
        {activeSection === "sessions-hub" && currentUser?.role === "Developer" && (
          <SessionsHub isAdmin={true} isDev={true} />
        )}
        {activeSection === "supplier-tracking-defaults" && showSupplierTrackingDefaults && (
          <SupplierTrackingDefaultsTab canManage={canManageTrackingDefaults} />
        )}
        {activeSection === "edit-log" && <EditLogTab selectedCompany={selectedCompany} />}
        {activeSection === "data-tools" && currentUser?.role === "Developer" && <DataToolsTab />}
        {activeSection === "pos-setup" && currentUser?.role === "Developer" && (
          <PosSetupHub userRole={currentUser?.role} />
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
              <AlertDialogDescription>Are you sure you want to delete {userToDelete?.username}?</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => deleteUserMutation.mutate(userToDelete.id)}
                className="bg-destructive text-destructive-foreground"
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}
