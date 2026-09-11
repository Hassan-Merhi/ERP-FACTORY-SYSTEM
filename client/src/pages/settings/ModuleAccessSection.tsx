import type { ClientErrorLike } from "@/lib/clientError";
import { Fragment } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useCompany } from "@/contexts/CompanyContext";
import { useToast } from "@/hooks/use-toast";
import { Switch } from "@/components/ui/switch";
import { Loader2, Info } from "lucide-react";
import { FEATURE_PAGE_INFO, FEATURE_KEYS, type FeatureKey } from "@shared/schema";
import type { SettingsRolePermissionRow } from "./settingsTypes";

const CONFIGURABLE_ROLES = ["Owner", "Manager", "POS", "Normal User"];

export function ModuleAccessSection() {
  const { selectedCompany } = useCompany();
  const { toast } = useToast();

  const { data: rolePermissions = [], isLoading } = useQuery<SettingsRolePermissionRow[]>({
    queryKey: ["/api/settings/role-permissions", selectedCompany?.id],
    enabled: !!selectedCompany?.id,
  });

  const permissionMap = new Map<string, boolean>();
  rolePermissions.forEach((p) => {
    permissionMap.set(`${p.role}:${p.featureKey}`, p.enabled);
  });

  const getPermission = (role: string, featureKey: string): boolean => {
    if (role === "Admin" || role === "Developer") return true;
    const key = `${role}:${featureKey}`;
    return permissionMap.has(key) ? permissionMap.get(key)! : false;
  };

  const updatePermissionMutation = useMutation({
    mutationFn: async ({ role, featureKey, enabled }: { role: string; featureKey: string; enabled: boolean }) => {
      if (!selectedCompany?.id) throw new Error("No company selected");
      const res = await apiRequest("PUT", "/api/settings/role-permissions", {
        companyId: selectedCompany.id,
        permissions: [{ role, featureKey, enabled }],
      });
      return await res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings/role-permissions", selectedCompany?.id] });
    },
    onError: (error: ClientErrorLike) => {
      toast({ title: "Error", description: error.message || "Failed to update permission", variant: "destructive" });
    },
  });

  if (!selectedCompany) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <Info className="h-8 w-8 mx-auto mb-3 opacity-50" />
        <p>Select a company to manage module access</p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const groups: Record<string, FeatureKey[]> = {};
  FEATURE_KEYS.forEach((key) => {
    const group = FEATURE_PAGE_INFO[key].group;
    if (!groups[group]) groups[group] = [];
    groups[group].push(key);
  });

  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm text-muted-foreground">
          Control which modules each role can access. Admin and Developer always have full access.
        </p>
      </div>

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40">
            <tr className="border-b">
              <th className="text-left py-2.5 px-4 font-medium text-muted-foreground">Module</th>
              {CONFIGURABLE_ROLES.map((role) => (
                <th key={role} className="text-center py-2.5 px-3 font-medium text-muted-foreground min-w-[70px]">
                  {role}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Object.entries(groups).map(([groupName, keys]) => (
              <Fragment key={groupName}>
                <tr className="bg-muted/20">
                  <td colSpan={CONFIGURABLE_ROLES.length + 1} className="px-4 py-1.5">
                    <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      {groupName}
                    </span>
                  </td>
                </tr>
                {keys.map((featureKey) => (
                  <tr key={featureKey} className="border-b last:border-0 hover:bg-muted/20 transition-colors">
                    <td className="py-2.5 px-4 font-medium">{FEATURE_PAGE_INFO[featureKey].label}</td>
                    {CONFIGURABLE_ROLES.map((role) => (
                      <td key={role} className="text-center py-2.5 px-3">
                        <div className="flex justify-center">
                          <Switch
                            checked={getPermission(role, featureKey)}
                            onCheckedChange={(enabled) =>
                              updatePermissionMutation.mutate({ role, featureKey, enabled })
                            }
                            disabled={updatePermissionMutation.isPending}
                            data-testid={`switch-permission-${role}-${featureKey}`}
                          />
                        </div>
                      </td>
                    ))}
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-muted-foreground">
        Changes take effect immediately. Users may need to refresh their page to see updated access.
      </p>
    </div>
  );
}
