import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Users, ChevronRight, Shield } from "lucide-react";
import { FACTORY_NAV_PAGES } from "@/components/FactorySidebar";
import { FEATURE_KEYS } from "@shared/schema";
import type { SettingsUserRow } from "../settingsTypes";

const FACTORY_PAGE_COUNT = FACTORY_NAV_PAGES.length;
const ERP_PAGE_COUNT = FEATURE_KEYS.length;

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
    case "view only":
      return "border-sky-300 bg-sky-100 text-sky-700 dark:border-sky-700 dark:bg-sky-950 dark:text-sky-300";
    default:
      return "border-border bg-muted text-muted-foreground";
  }
}

function accessSummary(user: SettingsUserRow): { label: string; variant: "default" | "secondary" | "outline" } {
  const privileged = ["admin", "owner", "developer"].includes(user.role?.toLowerCase() ?? "");
  const hasERP = privileged || (user.hasErpAccess ?? true);
  const hasFactory = privileged || (user.hasFactoryAccess ?? true);
  if (hasERP && hasFactory) return { label: "ERP + Factory", variant: "default" };
  if (hasERP) return { label: "ERP only", variant: "secondary" };
  if (hasFactory) return { label: "Factory only", variant: "secondary" };
  return { label: "No access", variant: "outline" };
}

function pagesSummary(user: SettingsUserRow): string {
  const privileged = ["admin", "owner", "developer"].includes(user.role?.toLowerCase() ?? "");
  if (privileged || !user.pageAccess || user.pageAccess.length === 0) return "Full access";
  const factoryKeys = new Set(FACTORY_NAV_PAGES.map((p) => p.key));
  const erpKeys = new Set<string>(FEATURE_KEYS);
  const fCount = user.pageAccess.filter((k: string) => factoryKeys.has(k)).length;
  const eCount = user.pageAccess.filter((k: string) => erpKeys.has(k)).length;
  const parts: string[] = [];
  if (fCount > 0) parts.push(`Factory: ${fCount}/${FACTORY_PAGE_COUNT}`);
  if (eCount > 0) parts.push(`ERP: ${eCount}/${ERP_PAGE_COUNT}`);
  return parts.length > 0 ? `Custom — ${parts.join(" · ")}` : "Full access";
}

interface UserListTableProps {
  users: SettingsUserRow[];
  isLoading: boolean;
  selectedUserId?: string | null;
  onSelectUser: (user: SettingsUserRow) => void;
}

export function UserListTable({ users, isLoading, selectedUserId, onSelectUser }: UserListTableProps) {
  if (isLoading) {
    return (
      <div className="space-y-2">
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-16 w-full rounded-md" />
        ))}
      </div>
    );
  }

  if (users.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <Users className="h-10 w-10 mx-auto mb-3 opacity-40" />
        <p className="font-medium">No users yet</p>
        <p className="text-sm mt-1">Click "Add User" to create the first one</p>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {users.map((user) => {
        const privileged = ["admin", "owner", "developer"].includes(user.role?.toLowerCase() ?? "");
        const access = accessSummary(user);
        const pages = pagesSummary(user);
        const isSelected = selectedUserId === user.id;
        return (
          <button
            key={user.id}
            type="button"
            className={`w-full text-left rounded-md border px-4 py-3 flex items-center gap-4 transition-colors hover-elevate ${
              isSelected ? "border-primary bg-accent" : "bg-card"
            }`}
            onClick={() => onSelectUser(user)}
            data-testid={`row-user-${user.id}`}
          >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted font-semibold text-sm text-muted-foreground uppercase">
              {(user.displayName || user.username).charAt(0)}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium text-sm">{user.displayName || user.username}</span>
                {user.displayName && <span className="text-xs text-muted-foreground font-mono">{user.username}</span>}
                {user.role && (
                  <Badge variant="outline" className={`text-xs capitalize gap-1 ${getRoleBadgeClass(user.role)}`}>
                    {privileged && <Shield className="h-3 w-3" />}
                    {user.role}
                  </Badge>
                )}
              </div>
              <div className="flex items-center gap-3 mt-0.5 flex-wrap">
                <span
                  className={`text-xs ${access.variant === "outline" ? "text-destructive" : "text-muted-foreground"}`}
                >
                  {access.label}
                </span>
                <span className="text-xs text-muted-foreground">·</span>
                <span className="text-xs text-muted-foreground">{pages}</span>
              </div>
            </div>
            <ChevronRight
              className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${isSelected ? "text-primary rotate-90" : ""}`}
            />
          </button>
        );
      })}
    </div>
  );
}
