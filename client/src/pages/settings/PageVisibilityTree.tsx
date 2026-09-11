import type { ClientErrorLike } from "@/lib/clientError";
import { useState, Fragment } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useCompany } from "@/contexts/CompanyContext";
import { useToast } from "@/hooks/use-toast";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { ChevronRight, ChevronDown, AlertTriangle, Loader2, Info } from "lucide-react";
import { type FeatureKey } from "@shared/schema";
import type { SettingsRolePermissionRow } from "./settingsTypes";

const CONFIGURABLE_ROLES = ["Owner", "Manager"];

type PageNode = {
  label: string;
  featureKey: FeatureKey | null;
  missingKey?: string;
  children?: PageNode[];
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

const FACTORY_GROUPS: PageGroup[] = [
  {
    label: "Factory Overview",
    pages: [
      { label: "Dashboard", featureKey: "dashboard" },
      { label: "Factory Production", featureKey: "factory_production" },
    ],
  },
  {
    label: "Factory Operations",
    pages: [
      { label: "Production", featureKey: null, missingKey: "factory_sheets_production", children: [] },
      { label: "Stock In", featureKey: null, missingKey: "factory_stock_in", children: [] },
      { label: "In / Out Gate", featureKey: null, missingKey: "factory_in_out_gate", children: [] },
      {
        label: "Factory Sheets",
        featureKey: null,
        missingKey: "factory_sheets",
        children: [
          { label: "Status tab", featureKey: null, missingKey: "factory_sheets_status" },
          { label: "Production tab", featureKey: null, missingKey: "factory_sheets_prod" },
          { label: "Stock In tab", featureKey: null, missingKey: "factory_sheets_stock_in" },
          { label: "In/Out Gate tab", featureKey: null, missingKey: "factory_sheets_gate" },
          { label: "Add Sheet button", featureKey: null, missingKey: "factory_sheets_add" },
        ],
      },
      { label: "Stock Allocation", featureKey: null, missingKey: "factory_stock_alloc", children: [] },
      { label: "Stock Allocation V2", featureKey: null, missingKey: "factory_stock_alloc_v2", children: [] },
      { label: "Stock Allocation V3", featureKey: null, missingKey: "factory_stock_alloc_v3", children: [] },
      { label: "Stock Allocation V5", featureKey: null, missingKey: "factory_stock_alloc_v5", children: [] },
    ],
  },
  {
    label: "Factory Accounting",
    pages: [
      { label: "Accounts", featureKey: "accounts" },
      { label: "Vouchers", featureKey: "vouchers" },
      { label: "Daybook", featureKey: "daybook" },
      { label: "Payroll", featureKey: "payroll" },
    ],
  },
];

function PageRow({
  page,
  depth,
  rolePermissions,
  permissionMap,
  onToggle,
  isPending,
}: {
  page: PageNode;
  depth: number;
  rolePermissions: Record<string, unknown>[];
  permissionMap: Map<string, boolean>;
  onToggle: (role: string, featureKey: string, enabled: boolean) => void;
  isPending: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasChildren = page.children && page.children.length > 0;
  const isMissing = page.featureKey === null;

  const getPermission = (role: string): boolean => {
    if (!page.featureKey) return false;
    const key = `${role}:${page.featureKey}`;
    return permissionMap.has(key) ? permissionMap.get(key)! : false;
  };

  return (
    <>
      <tr className="border-b last:border-0 hover:bg-muted/20 transition-colors">
        <td className="py-2 px-4">
          <div className="flex items-center gap-1" style={{ paddingLeft: `${depth * 16}px` }}>
            {hasChildren ? (
              <button
                onClick={() => setExpanded(!expanded)}
                className="p-0.5 rounded hover:bg-muted/50 shrink-0"
                data-testid={`button-expand-${page.missingKey || page.featureKey}`}
              >
                {expanded ? (
                  <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                )}
              </button>
            ) : (
              <span className="w-5 shrink-0" />
            )}
            <span className={`text-sm ${depth > 0 ? "text-muted-foreground" : "font-medium"}`}>{page.label}</span>
            {isMissing && (
              <Badge
                variant="outline"
                className="ml-1 text-xs text-amber-600 border-amber-300 bg-amber-50 dark:bg-amber-950/30"
              >
                Needs mapping
              </Badge>
            )}
          </div>
        </td>
        {CONFIGURABLE_ROLES.map((role) => (
          <td key={role} className="text-center py-2 px-3">
            {isMissing ? (
              <div className="flex justify-center">
                <AlertTriangle className="h-4 w-4 text-amber-400 opacity-60" />
              </div>
            ) : (
              <div className="flex justify-center">
                <Switch
                  checked={getPermission(role)}
                  onCheckedChange={(enabled) => onToggle(role, page.featureKey!, enabled)}
                  disabled={isPending}
                  data-testid={`switch-visibility-${role}-${page.featureKey}`}
                />
              </div>
            )}
          </td>
        ))}
      </tr>
      {hasChildren &&
        expanded &&
        page.children!.map((child, i) => (
          <PageRow
            key={i}
            page={child}
            depth={depth + 1}
            rolePermissions={rolePermissions}
            permissionMap={permissionMap}
            onToggle={onToggle}
            isPending={isPending}
          />
        ))}
    </>
  );
}

export function PageVisibilityTree({ appMode }: { appMode?: string }) {
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

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const groups = appMode === "factory" ? FACTORY_GROUPS : ERP_GROUPS;

  const handleToggle = (role: string, featureKey: string, enabled: boolean) => {
    updatePermissionMutation.mutate({ role, featureKey, enabled });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 p-3 bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 rounded-md">
        <AlertTriangle className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
        <div className="text-sm text-amber-700 dark:text-amber-300">
          <span className="font-medium">Needs mapping</span> items are not yet connected to the permission system. Only
          Owner and Manager role visibility is configurable here.
        </div>
      </div>

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
            {groups.map((group) => (
              <Fragment key={group.label}>
                <tr className="bg-muted/20">
                  <td colSpan={CONFIGURABLE_ROLES.length + 1} className="px-4 py-1.5">
                    <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      {group.label}
                    </span>
                  </td>
                </tr>
                {group.pages.map((page, i) => (
                  <PageRow
                    key={i}
                    page={page}
                    depth={0}
                    rolePermissions={rolePermissions}
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
    </div>
  );
}
