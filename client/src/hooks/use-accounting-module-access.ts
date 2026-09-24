import { useQuery } from "@tanstack/react-query";
import { authenticatedUserQueryOptions } from "@/contracts/sessionQueryContracts";

type PermissionRow = {
  featureKey: string;
  enabled: boolean;
};

function roleAllowsAccounting(role: string | undefined, rows: PermissionRow[] | undefined): boolean {
  if (!role) return false;
  if (role === "Developer" || role === "Admin") return true;

  const stored = rows?.find((row) => row.featureKey === "mod_accounting")?.enabled;
  if (role === "Normal User") return stored === true;

  return stored !== false;
}

export function useAccountingModuleAccess(enabled = true) {
  const { data: user } = useQuery(authenticatedUserQueryOptions());
  const privileged = user?.role === "Developer" || user?.role === "Admin";

  const { data: permissions, isFetched } = useQuery<PermissionRow[]>({
    queryKey: ["/api/my-permissions"],
    enabled: enabled && !!user && !privileged,
    staleTime: 5 * 60 * 1000,
  });

  return {
    canAccessAccounting: enabled && roleAllowsAccounting(user?.role, permissions),
    accountingAccessReady: !enabled || privileged || (!!user && isFetched),
  };
}
