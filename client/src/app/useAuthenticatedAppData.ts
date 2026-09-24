import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { setAppTimezone, setFactoryAccountingModuleAccess } from "@/lib/queryClient";
import { accessQueryPolicy, liveCountQueryPolicy, stableSettingsQueryPolicy } from "@/lib/queryPolicies";
import { useToast } from "@/hooks/use-toast";

export interface FactoryAccess {
  fullAccess: boolean;
  pageKeys: string[];
  hasErpAccess: boolean;
  hasFactoryAccess: boolean;
  companyId?: number;
  companyName?: string;
  hiddenCostFields?: string[];
}

interface CompanySettings {
  timezone?: string;
  posExcelImportEnabled?: boolean;
}

interface UseAuthenticatedAppDataOptions {
  selectedCompanyId?: number;
  companyType?: string | null;
  userPresent: boolean;
  isPOS: boolean;
  userRole?: string;
}

export function useAuthenticatedAppData({
  selectedCompanyId,
  companyType,
  userPresent,
  isPOS,
  userRole,
}: UseAuthenticatedAppDataOptions) {
  const { toast } = useToast();
  const prevUnreadRef = useRef<number>(-1);
  const isFactoryCompany = companyType === "factory" || companyType === "factory_v2";
  const factoryBootstrapEnabled = userPresent && !isPOS && !!selectedCompanyId && isFactoryCompany;
  const privilegedAccountingRole = userRole === "Developer" || userRole === "Admin";

  const { data: chatUnread } = useQuery<{ count: number }>({
    queryKey: companyQueryKey("/api/chat/unread-count", selectedCompanyId),
    ...liveCountQueryPolicy(60_000),
    enabled: isPOS && userPresent && !!selectedCompanyId,
  });

  useEffect(() => {
    if (!isPOS) return;
    const count = chatUnread?.count || 0;
    if (prevUnreadRef.current === -1) {
      prevUnreadRef.current = count;
      return;
    }
    if (count > prevUnreadRef.current) {
      toast({ title: "New message", description: `You have ${count} unread message${count > 1 ? "s" : ""}.` });
    }
    prevUnreadRef.current = count;
  }, [chatUnread?.count, isPOS, toast]);

  const { data: companySettings } = useQuery<CompanySettings>({
    queryKey: companyQueryKey("/api/company-settings", selectedCompanyId),
    ...stableSettingsQueryPolicy,
    enabled: userPresent && !!selectedCompanyId,
  });

  useEffect(() => {
    setAppTimezone(companySettings?.timezone);
  }, [companySettings?.timezone]);

  const {
    data: myAccess,
    isLoading: myAccessLoading,
    isError: myAccessError,
  } = useQuery<FactoryAccess>({
    queryKey: companyQueryKey("/api/factory/my-access", selectedCompanyId),
    ...accessQueryPolicy,
    enabled: factoryBootstrapEnabled,
    retry: 2,
  });

  const {
    data: myPermissions = [],
    isFetched: myPermissionsFetched,
    isError: myPermissionsError,
  } = useQuery<Array<{ featureKey: string; enabled: boolean }>>({
    queryKey: companyQueryKey("/api/my-permissions", selectedCompanyId),
    ...accessQueryPolicy,
    enabled: factoryBootstrapEnabled && !privilegedAccountingRole,
  });

  const accountingPermission =
    privilegedAccountingRole
      ? true
      : userRole === "Normal User"
        ? myPermissions.find((row) => row.featureKey === "mod_accounting")?.enabled === true
        : myPermissions.find((row) => row.featureKey === "mod_accounting")?.enabled !== false;
  const accountingPermissionReady =
    !factoryBootstrapEnabled || privilegedAccountingRole || myPermissionsFetched;

  useEffect(() => {
    if (!factoryBootstrapEnabled) {
      setFactoryAccountingModuleAccess(null);
      return;
    }
    if (!accountingPermissionReady) {
      setFactoryAccountingModuleAccess(null);
      return;
    }
    setFactoryAccountingModuleAccess(accountingPermission);
    return () => setFactoryAccountingModuleAccess(null);
  }, [accountingPermission, accountingPermissionReady, factoryBootstrapEnabled]);

  const { data: factorySettings } = useQuery<Record<string, unknown>>({
    queryKey: companyQueryKey("/api/factory/settings", selectedCompanyId),
    queryFn: async () => {
      const response = await fetch("/api/factory/settings");
      return response.ok ? response.json() : {};
    },
    ...stableSettingsQueryPolicy,
    enabled: factoryBootstrapEnabled,
  });

  return {
    chatUnread,
    posImportEnabled: companySettings?.posExcelImportEnabled === true,
    myAccess,
    myAccessLoading: myAccessLoading || (factoryBootstrapEnabled && !accountingPermissionReady),
    myAccessError: myAccessError || myPermissionsError,
    factorySettings,
  };
}
