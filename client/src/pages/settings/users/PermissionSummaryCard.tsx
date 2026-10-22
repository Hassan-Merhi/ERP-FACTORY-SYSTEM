import { CheckCircle2, AlertTriangle, ShieldOff, ShieldCheck } from "lucide-react";

interface PermissionEntry {
  label: string;
  dangerous: boolean;
}

function getPermissions(
  role: string,
  flags: {
    canDeleteRecords?: boolean;
    canSellNegativeStock?: boolean;
    canAccessCustomers?: boolean;
    daybookEditDays?: number;
  }
): PermissionEntry[] {
  const perms: PermissionEntry[] = [];

  switch (role) {
    case "Admin":
    case "Developer":
      perms.push({ label: "Manage all users and settings", dangerous: false });
      perms.push({ label: "Delete and void any record", dangerous: true });
      perms.push({ label: "Export all company data", dangerous: true });
      perms.push({ label: "Access all financial reports and costs", dangerous: false });
      perms.push({ label: "Change prices and exchange rates", dangerous: true });
      break;

    case "Owner":
      perms.push({ label: "Access all financial reports and costs", dangerous: false });
      perms.push({ label: "View and edit any voucher", dangerous: false });
      break;

    case "Manager":
      perms.push({ label: "Create and edit vouchers", dangerous: false });
      if (flags.canDeleteRecords) {
        perms.push({ label: "Delete and void records", dangerous: true });
      }
      break;

    case "ERP Tester":
      perms.push({ label: "Manager-level operational access in assigned companies", dangerous: false });
      perms.push({ label: "No system Settings or user administration access", dangerous: false });
      if (flags.canDeleteRecords) perms.push({ label: "Delete assigned-company records", dangerous: true });
      break;

    case "Normal User":
      perms.push({ label: "View-only access (no posting)", dangerous: false });
      break;

    case "POS":
      perms.push({ label: "Point-of-sale transactions only", dangerous: false });
      break;
  }

  if (flags.canSellNegativeStock) {
    perms.push({ label: "Sell items even when out of stock", dangerous: true });
  }

  if (flags.canAccessCustomers) {
    perms.push({ label: "Access customer balances and ledger", dangerous: false });
  }

  if ((flags.daybookEditDays ?? 0) > 0) {
    perms.push({
      label: `Back-date entries up to ${flags.daybookEditDays} day${flags.daybookEditDays !== 1 ? "s" : ""}`,
      dangerous: (flags.daybookEditDays ?? 0) > 7,
    });
  }

  return perms;
}

function getDangerWarnings(
  role: string,
  flags: {
    canDeleteRecords?: boolean;
    canSellNegativeStock?: boolean;
    daybookEditDays?: number;
  }
): string[] {
  const warns: string[] = [];

  if (["Admin", "Developer"].includes(role)) {
    warns.push("This role has unrestricted system access including all deletions and exports.");
  }

  if (flags.canDeleteRecords && !["Admin", "Developer"].includes(role)) {
    warns.push("Deletion permission is permanent — deleted records cannot be recovered without a backup.");
  }

  if (flags.canSellNegativeStock) {
    warns.push("Selling below zero can cause inventory and cost discrepancies.");
  }

  if ((flags.daybookEditDays ?? 0) > 30) {
    warns.push("Back-dating more than 30 days can affect closed period reports.");
  }

  return warns;
}

interface Props {
  role: string;
  canDeleteRecords?: boolean;
  canSellNegativeStock?: boolean;
  canAccessCustomers?: boolean;
  daybookEditDays?: number;
}

export function PermissionSummaryCard({
  role,
  canDeleteRecords,
  canSellNegativeStock,
  canAccessCustomers,
  daybookEditDays,
}: Props) {
  const flags = { canDeleteRecords, canSellNegativeStock, canAccessCustomers, daybookEditDays };
  const perms = getPermissions(role, flags);
  const warnings = getDangerWarnings(role, flags);
  const dangerCount = perms.filter((p) => p.dangerous).length;

  if (perms.length === 0) return null;

  return (
    <div className="rounded-md border bg-muted/30 p-3 space-y-2" data-testid="permission-summary-card">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
        {dangerCount > 0 ? (
          <ShieldCheck className="h-3.5 w-3.5 text-amber-500" />
        ) : (
          <ShieldCheck className="h-3.5 w-3.5 text-muted-foreground" />
        )}
        Permission preview
      </div>

      <ul className="space-y-1">
        {perms.map((p, i) => (
          <li key={i} className="flex items-center gap-2 text-xs">
            {p.dangerous ? (
              <AlertTriangle className="h-3 w-3 text-amber-500 shrink-0" />
            ) : (
              <CheckCircle2 className="h-3 w-3 text-green-600 dark:text-green-400 shrink-0" />
            )}
            <span className={p.dangerous ? "text-amber-700 dark:text-amber-300" : ""}>{p.label}</span>
          </li>
        ))}
      </ul>

      {warnings.length > 0 && (
        <div className="space-y-1 pt-1 border-t">
          {warnings.map((w, i) => (
            <p key={i} className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400">
              <ShieldOff className="h-3 w-3 shrink-0 mt-0.5" />
              {w}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
