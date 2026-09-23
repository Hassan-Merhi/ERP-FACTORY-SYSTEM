import type { ClientErrorLike } from "@/lib/clientError";
import { Fragment } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useCompany } from "@/contexts/CompanyContext";
import { useToast } from "@/hooks/use-toast";
import { Switch } from "@/components/ui/switch";
import { Loader2, Info, ShieldCheck } from "lucide-react";
import { type FeatureKey } from "@shared/schema";
import type { SettingsRolePermissionRow } from "./settingsTypes";

const CONFIGURABLE_ROLES = ["Owner", "Manager"];

type PageNode = {
  label: string;
  featureKey: FeatureKey;
};

type PageGroup = {
  label: string;
  pages: PageNode[];
};

const ERP_GROUPS: PageGroup[] = [
  {
    label: "Overview",
    pages: [
      { label: "Dashboard / Tracking", featureKey: "dashboard" },
      { label: "Analytics", featureKey: "analytics" },
    ],
  },
  {
    label: "Sales & POS",
    pages: [
      { label: "Point of Sale", featureKey: "pos" },
      { label: "POS Daybook", featureKey: "pos_daybook" },
      { label: "Sales Report", featureKey: "sales_report" },
    ],
  },
  {
    label: "Inventory",
    pages: [
      { label: "Stock Items", featureKey: "stock_items" },
      { label: "Location Inventory", featureKey: "location_inventory" },
      { label: "Containers (OTW)", featureKey: "containers" },
      { label: "Stock OTW", featureKey: "stock_otw" },
      { label: "Stock Query", featureKey: "stock_query" },
      { label: "Location Summary", featureKey: "location_summary" },
      { label: "Optional Vouchers", featureKey: "optional_vouchers" },
    ],
  },
  {
    label: "Accounting",
    pages: [
      { label: "Accounts", featureKey: "accounts" },
      { label: "Suppliers", featureKey: "suppliers" },
      { label: "Customers", featureKey: "customers" },
      { label: "Vouchers", featureKey: "vouchers" },
      { label: "Create Voucher", featureKey: "create" },
      { label: "Daybook", featureKey: "daybook" },
      { label: "Payroll", featureKey: "payroll" },
    ],
  },
  {
    label: "System",
    pages: [{ label: "Settings", featureKey: "settings" }],
  },
];

function PageRow({
  page,
  permissionMap,
  onToggle,
  isPending,
}: {
  page: PageNode;
  permissionMap: Map<string, boolean>;
  onToggle: (role: string, featureKey: string, enabled: boolean) => void;
  isPending: boolean;
}) {
  const getPermission = (role: string): boolean => permissionMap.get(`${role}:${page.featureKey}`) ?? false;

  return (
    <tr className="border-b last:border-0 hover:bg-muted/20 transition-colors">
      <td className="py-2 px-4">
        <span className="text-sm font-medium">{page.label}</span>
      </td>
      {CONFIGURABLE_ROLES.map((role) => (
        <td key={role} className="text-center py-2 px-3">
          <div className="flex justify-center">
            <Switch
              checked={getPermission(role)}
              onCheckedChange={(enabled) => onToggle(role, page.featureKey, enabled)}
              disabled={isPending}
              data-testid={`switch-visibility-${role}-${page.featureKey}`}
            />
          </div>
        </td>
      ))}
    </tr>
  );
}

/**
 * ERP role-feature visibility remains managed here.
 *
 * Factory page/tab permissions are intentionally not mirrored into this role
 * tree. They are user-specific and are managed by Users & Permissions from the
 * shared Factory page/tab registries. Keeping a second Factory tree here was the
 * source of "Needs mapping", V2/V3 duplicates and permission drift.
 */
export function PageVisibilityTree({ appMode }: { appMode?: string }) {
  const { selectedCompany } = useCompany();
  const { toast } = useToast();

  const { data: rolePermissions = [], isLoading } = useQuery<SettingsRolePermissionRow[]>({
    queryKey: ["/api/settings/role-permissions", selectedCompany?.id],
    enabled: !!selectedCompany?.id && appMode !== "factory",
  });

  const permissionMap = new Map<string, boolean>();
  rolePermissions.forEach((permission) => {
    permissionMap.set(`${permission.role}:${permission.featureKey}`, permission.enabled);
  });

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
        <p>Select a company to manage page visibility</p>
      </div>
    );
  }

  if (appMode === "factory") {
    return (
      <div className="rounded-md border bg-muted/20 p-5" data-testid="factory-visibility-managed-per-user">
        <div className="flex items-start gap-3">
          <ShieldCheck className="h-5 w-5 mt-0.5 text-muted-foreground shrink-0" />
          <div className="space-y-1">
            <p className="font-medium">Factory access is managed per user</p>
            <p className="text-sm text-muted-foreground">
              Use Users &amp; Permissions → Advanced Restrictions for Factory pages and tabs. The sidebar, direct routes
              and Factory APIs all use the same canonical permission registry.
            </p>
          </div>
        </div>
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

  const handleToggle = (role: string, featureKey: string, enabled: boolean) => {
    updatePermissionMutation.mutate({ role, featureKey, enabled });
  };

  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-sm">
        <thead className="bg-muted/40">
          <tr className="border-b">
            <th className="text-left py-2.5 px-4 font-medium text-muted-foreground">Page / Feature</th>
            {CONFIGURABLE_ROLES.map((role) => (
              <th key={role} className="text-center py-2.5 px-3 font-medium text-muted-foreground min-w-[80px]">
                {role}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ERP_GROUPS.map((group) => (
            <Fragment key={group.label}>
              <tr className="bg-muted/20">
                <td colSpan={CONFIGURABLE_ROLES.length + 1} className="px-4 py-1.5">
                  <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {group.label}
                  </span>
                </td>
              </tr>
              {group.pages.map((page) => (
                <PageRow
                  key={page.featureKey}
                  page={page}
                  permissionMap={permissionMap}
                  onToggle={handleToggle}
                  isPending={updatePermissionMutation.isPending}
                />
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
