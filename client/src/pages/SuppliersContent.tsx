// Extracted from ./Suppliers.tsx
import { ErpRecordAction } from "@/erp-core";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Edit, FileText } from "lucide-react";
import { getAvatarColor, getInitials } from "./suppliers/supplierDisplay";
import { useSuppliersState } from "./useSuppliersState";

export function SuppliersContent({
  formatAmount,
  handleSupplierClick,
  isProperties,
  navigate,
  recordChanges,
  sortedSuppliers,
}: Pick<
  ReturnType<typeof useSuppliersState>,
  "formatAmount" | "handleSupplierClick" | "isProperties" | "navigate" | "recordChanges" | "sortedSuppliers"
>) {
  return (
    <div className="space-y-2">
      {sortedSuppliers.map((supplier) => (
        <div
          key={supplier.id}
          className="rounded-xl border bg-card p-4 cursor-pointer hover-elevate flex items-center gap-4 group"
          onClick={() => handleSupplierClick(supplier)}
          data-testid={`row-supplier-${supplier.id}`}
        >
          {/* Avatar */}
          <div
            className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 text-sm font-bold ${getAvatarColor(supplier.id)}`}
          >
            {getInitials(supplier.legalName)}
          </div>

          {/* Name + meta */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-sm" data-testid={`button-supplier-name-${supplier.id}`}>
                {supplier.legalName}
              </span>
              {!supplier.active && (
                <Badge variant="secondary" className="text-xs">
                  Inactive
                </Badge>
              )}
            </div>
            {supplier.containerCount > 0 ? (
              <p className="text-xs text-muted-foreground mt-0.5" data-testid={`text-containers-${supplier.id}`}>
                {supplier.containerCount} container{supplier.containerCount !== 1 ? "s" : ""}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground mt-0.5">No containers</p>
            )}
          </div>

          {/* Balance */}
          <div className="shrink-0 text-right hidden sm:block">
            {supplier.balance === 0 ? (
              <span className="text-xs text-muted-foreground" data-testid={`text-balance-${supplier.id}`}>
                —
              </span>
            ) : (
              <span
                className={`inline-flex items-center px-2.5 py-1 rounded-md text-xs font-mono font-semibold ${
                  supplier.balance > 0
                    ? "bg-red-500/10 text-red-600 dark:text-red-400"
                    : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                }`}
                data-testid={`text-balance-${supplier.id}`}
              >
                {formatAmount(Math.abs(supplier.balance))}
                <span className="ml-1 opacity-70 text-[11px]">{supplier.balance > 0 ? "Cr" : "Dr"}</span>
              </span>
            )}
          </div>

          {/* Mobile balance */}
          <div className="shrink-0 sm:hidden">
            {supplier.balance !== 0 && (
              <span
                className={`text-xs font-mono font-semibold ${
                  supplier.balance > 0 ? "text-red-500" : "text-emerald-600 dark:text-emerald-400"
                }`}
                data-testid={`text-balance-mobile-${supplier.id}`}
              >
                {formatAmount(Math.abs(supplier.balance))}
              </span>
            )}
          </div>

          {/* Actions */}
          <div
            className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 touch:opacity-100 transition-opacity"
            onClick={(e) => e.stopPropagation()}
          >
            <Button
              variant="ghost"
              size="icon"
              onClick={() => navigate(`${isProperties ? "/properties" : ""}/suppliers/${supplier.id}/proformas`)}
              data-testid={`button-proformas-supplier-${supplier.id}`}
              title="Proformas"
            >
              <FileText className="h-4 w-4" />
            </Button>
            <ErpRecordAction
              variant="ghost"
              size="icon"
              onClick={() => {
                if (recordChanges.allowed)
                  navigate(`${isProperties ? "/properties" : ""}/suppliers/${supplier.id}/edit`);
              }}
              permitted={recordChanges.allowed}
              deniedReason={recordChanges.reason}
              data-testid={`button-edit-supplier-${supplier.id}`}
              title={recordChanges.reason ?? "Edit"}
              aria-label={recordChanges.reason ?? "Edit supplier"}
            >
              <Edit className="h-4 w-4" />
            </ErpRecordAction>
          </div>
        </div>
      ))}
    </div>
  );
}
