import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Edit, Trash2, MapPin, Monitor, Calendar, PackageMinus, ShieldCheck, Users } from "lucide-react";
import { AdvancedRestrictionsPanel } from "@/components/AdvancedRestrictionsPanel";
import type { UserCompanyRole } from "@shared/schema";

interface RoleSummaryRowProps {
  role: UserCompanyRole;
  companyName: string;
  locationNames: string[];
  isEditing: boolean;
  onEdit: () => void;
  onDelete: () => void;
}

const NON_RESTRICTABLE_ROLES = ["Developer", "Admin"];

function countActivePermissions(role: string, permissions: Record<string, unknown>[]): number {
  const isNormal = role === "Normal User";
  return permissions.filter((p) => {
    if (p.role !== role) return false;
    return isNormal ? p.enabled === true : p.enabled === false;
  }).length;
}

function getRoleBadgeClass(role: string): string {
  switch (role?.toLowerCase()) {
    case "developer":
      return "border-slate-300 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300";
    case "admin":
      return "border-blue-300 bg-blue-100 text-blue-700 dark:border-blue-700 dark:bg-blue-950 dark:text-blue-300";
    case "owner":
      return "border-violet-300 bg-violet-100 text-violet-700 dark:border-violet-700 dark:bg-violet-950 dark:text-violet-300";
    case "manager":
      return "border-amber-300 bg-amber-100 text-amber-700 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300";
    case "pos":
      return "border-emerald-300 bg-emerald-100 text-emerald-700 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-300";
    default:
      return "border-border bg-muted text-muted-foreground";
  }
}

export function RoleSummaryRow({ role, companyName, locationNames, isEditing, onEdit, onDelete }: RoleSummaryRowProps) {
  const [restrictionsOpen, setRestrictionsOpen] = useState(false);
  const isPOS = role.role === "POS";
  const _isPrivileged = ["Admin", "Owner", "Developer"].includes(role.role);
  const canShowRestrictions = !NON_RESTRICTABLE_ROLES.includes(role.role) && !!role.companyId;

  const { data: allPermissions = [] } = useQuery({
    queryKey: ["/api/settings/role-permissions", role.companyId],
    queryFn: async () => {
      const res = await fetch(`/api/settings/role-permissions?companyId=${role.companyId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load permissions");
      return res.json();
    },
    enabled: canShowRestrictions,
  });

  const customCount = useMemo(
    () => (canShowRestrictions ? countActivePermissions(role.role, allPermissions) : 0),
    [role.role, allPermissions, canShowRestrictions]
  );

  return (
    <div
      className={`rounded-md border bg-card transition-colors ${isEditing ? "border-primary/50 bg-accent/30" : ""}`}
      data-testid={`role-item-${role.id}`}
    >
      {/* Main row */}
      <div className="flex items-start gap-2 px-3 py-2.5">
        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm">{companyName}</span>
            <Badge variant="outline" className={`text-xs ${getRoleBadgeClass(role.role)}`}>
              {role.role}
            </Badge>
            {customCount > 0 && (
              <Badge variant="secondary" className="text-xs font-normal">
                Custom · {customCount} {role.role === "Normal User" ? "granted" : "restricted"}
              </Badge>
            )}
          </div>

          {(isPOS || role.daybookEditDays > 0 || role.canSellNegativeStock) && (
            <div className="flex items-center gap-3 flex-wrap">
              {isPOS && locationNames.length > 0 && (
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <MapPin className="h-3 w-3 shrink-0" />
                  {locationNames.length === 1 ? locationNames[0] : `${locationNames.length} locations`}
                </span>
              )}
              {isPOS && role.posStation && (
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Monitor className="h-3 w-3 shrink-0" />
                  Station {role.posStation}
                </span>
              )}
              {role.daybookEditDays > 0 && (
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Calendar className="h-3 w-3 shrink-0" />
                  {role.daybookEditDays}d edit window
                </span>
              )}
              {role.canSellNegativeStock && (
                <span className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
                  <PackageMinus className="h-3 w-3 shrink-0" />
                  Can sell 0-stock
                </span>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center gap-0.5 shrink-0">
          {canShowRestrictions && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setRestrictionsOpen((v) => !v)}
              title="Advanced Restrictions"
              data-testid={`button-restrictions-${role.id}`}
              className={restrictionsOpen ? "text-primary" : ""}
            >
              <ShieldCheck className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button variant="ghost" size="icon" onClick={onEdit} data-testid={`button-edit-role-${role.id}`}>
            <Edit className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="text-destructive"
            onClick={onDelete}
            data-testid={`button-delete-role-${role.id}`}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Advanced Restrictions collapsible */}
      {canShowRestrictions && restrictionsOpen && (
        <div className="border-t px-3 py-3">
          <div className="flex items-center justify-between gap-2 mb-3">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Advanced Restrictions
              </span>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-xs px-2"
              onClick={() => setRestrictionsOpen(false)}
              data-testid={`button-close-restrictions-${role.id}`}
            >
              Close
            </Button>
          </div>
          <div className="flex items-start gap-2 rounded-md border border-violet-200 dark:border-violet-800 bg-violet-50 dark:bg-violet-950/30 px-3 py-2 text-xs text-violet-700 dark:text-violet-300 mb-3">
            <Users className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span>
              These restrictions apply to <strong>all {role.role} users</strong> at {companyName} — not just this user.
            </span>
          </div>
          <AdvancedRestrictionsPanel role={role.role} companyId={role.companyId} companyName={companyName} />
        </div>
      )}
    </div>
  );
}
