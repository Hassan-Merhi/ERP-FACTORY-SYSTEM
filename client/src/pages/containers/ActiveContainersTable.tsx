import { Eye, Package, Plus, Check, X, Pencil } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import type { Container } from "@shared/schema";

interface ActiveContainersTableProps {
  containers: Container[];
  allContainers: Container[];
  isLoading: boolean;
  hideContainerCosts: boolean;
  formatDisplayDate: (d: string) => string;
  formatAmount: (n: number) => string;
  editingNumberId: number | null;
  editingNumberValue: string;
  onEditNumberStart: (id: number, number: string) => void;
  onEditNumberChange: (v: string) => void;
  onEditNumberSave: (id: number, containerNumber: string) => void;
  onEditNumberCancel: () => void;
  isEditNumberPending: boolean;
  getSupplierName: (id: number) => string;
}

export function ActiveContainersTable({
  containers,
  allContainers,
  isLoading,
  hideContainerCosts,
  formatDisplayDate,
  formatAmount,
  editingNumberId,
  editingNumberValue,
  onEditNumberStart,
  onEditNumberChange,
  onEditNumberSave,
  onEditNumberCancel,
  isEditNumberPending,
  getSupplierName,
}: ActiveContainersTableProps) {
  /* Container list */
  if (isLoading) {
    return (
      <div className="space-y-2">
        {[1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="h-20 w-full rounded-xl" />
        ))}
      </div>
    );
  }

  if (containers.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <div className="w-14 h-14 rounded-xl bg-muted/60 flex items-center justify-center mb-4">
          <Package className="w-7 h-7 text-muted-foreground" />
        </div>
        <h2 className="text-lg font-semibold mb-1">No containers found</h2>
        <p className="text-sm text-muted-foreground mb-4">
          {allContainers.length === 0
            ? "Import your first purchase order to get started"
            : "Try adjusting your search or filters"}
        </p>
        {allContainers.length === 0 && (
          <Link href="/po-import">
            <Button>
              <Plus className="w-4 h-4 mr-2" />
              Import PO
            </Button>
          </Link>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {containers.map((container) => {
        const statusColors: Record<string, string> = {
          OTW: "bg-blue-500/10 text-blue-700 dark:text-blue-300 border-transparent",
          ARRIVED: "bg-amber-500/10 text-amber-700 dark:text-amber-300 border-transparent",
          OFFLOADED: "bg-green-500/10 text-green-700 dark:text-green-300 border-transparent",
        };
        return (
          <div
            key={container.id}
            className="bg-card border rounded-xl p-4 flex flex-col gap-3 hover-elevate sm:flex-row sm:items-center sm:gap-4"
            data-testid={`row-container-${container.id}`}
          >
            <div className="flex w-full min-w-0 items-start gap-3 sm:flex-1 sm:items-center">
              <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
                <Package className="h-5 w-5 text-primary" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  {editingNumberId === container.id ? (
                    <div className="flex max-w-full flex-wrap items-center gap-1">
                      <Input
                        className="h-9 w-full min-w-0 font-mono text-xs px-2 sm:w-36"
                        value={editingNumberValue}
                        onChange={(e) => onEditNumberChange(e.target.value.toUpperCase())}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") onEditNumberSave(container.id, editingNumberValue);
                          if (e.key === "Escape") onEditNumberCancel();
                        }}
                        autoFocus
                        data-testid={`input-container-number-${container.id}`}
                      />
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => onEditNumberSave(container.id, editingNumberValue)}
                        disabled={isEditNumberPending}
                        data-testid={`button-save-number-${container.id}`}
                        className="erp-mobile-touch-target"
                      >
                        <Check className="h-3 w-3" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={onEditNumberCancel}
                        data-testid={`button-cancel-number-${container.id}`}
                        className="erp-mobile-touch-target"
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    </div>
                  ) : (
                    <div className="flex min-w-0 items-center gap-1 group">
                      <span className="truncate font-mono font-semibold text-sm">{container.containerNumber}</span>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="erp-mobile-touch-visible erp-mobile-touch-target opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={(e) => {
                          e.stopPropagation();
                          onEditNumberStart(container.id, container.containerNumber);
                        }}
                        data-testid={`button-edit-number-${container.id}`}
                      >
                        <Pencil className="h-3 w-3" />
                      </Button>
                    </div>
                  )}
                  <Badge
                    className={statusColors[container.status] || "border-transparent"}
                    data-testid={`badge-status-${container.id}`}
                  >
                    {container.status}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground mt-0.5 break-words">{getSupplierName(container.supplierId)}</p>
              </div>
            </div>
            <div className="flex w-full flex-wrap items-center justify-between gap-2 sm:w-auto sm:flex-shrink-0 sm:justify-end sm:gap-4">
              <div className="text-left sm:text-right">
                <p className="text-xs text-muted-foreground">Import date</p>
                <p className="text-sm font-mono">{formatDisplayDate(container.importDate)}</p>
                {container.status === "OFFLOADED" && container.offloadDate && (
                  <div className="mt-1">
                    <p className="text-xs font-medium text-green-700 dark:text-green-300">Offloaded date</p>
                    <p className="text-sm font-mono text-green-700 dark:text-green-300">
                      {formatDisplayDate(container.offloadDate)}
                    </p>
                  </div>
                )}
              </div>
              {!hideContainerCosts && (
                <div className="text-right">
                  <p className="text-xs text-muted-foreground">Total</p>
                  <p className="text-sm font-mono font-semibold">
                    {formatAmount(parseFloat(container.grandTotal || "0"))}
                  </p>
                </div>
              )}
              <Link href={`/containers/${container.id}`} className="w-full sm:w-auto">
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full sm:w-auto"
                  onClick={(e) => e.stopPropagation()}
                  data-testid={`button-view-${container.id}`}
                >
                  <Eye className="h-4 w-4 mr-1" />
                  View
                </Button>
              </Link>
            </div>
          </div>
        );
      })}
    </div>
  );
}
