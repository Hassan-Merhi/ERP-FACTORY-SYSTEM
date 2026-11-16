// Extracted from ./FactoryPendingLoadings.tsx to keep that module under the source-size cap.
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ChevronDown, ChevronRight, Package, Users, Weight, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { fmtKg } from "./FactoryPendingLoadingsTypes";
import { useFactoryPendingLoadingsState } from "./useFactoryPendingLoadingsState";

export function FactoryPendingLoadingsListPendingLoadings({
  collapsedCustomers,
  groups,
  renderLoadCard,
  toggleCustomer,
}: Pick<
  ReturnType<typeof useFactoryPendingLoadingsState>,
  "collapsedCustomers" | "groups" | "renderLoadCard" | "toggleCustomer"
>) {
  return (
    <div className="space-y-3" data-testid="list-pending-loadings">
      {Array.from(groups.values()).map((group) => {
        if (group.loads.length === 1) return renderLoadCard(group.loads[0]);
        const isExpanded = !collapsedCustomers.has(group.customerId);
        const groupBales = group.loads.reduce((sum, load) => sum + (load.totalQtyBales || 0), 0);
        const groupKg = group.loads.reduce((sum, load) => sum + (Number.parseFloat(load.totalWeightKg || "0") || 0), 0);
        return (
          <div
            key={"group-" + group.customerId}
            className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm"
          >
            <button
              type="button"
              onClick={() => toggleCustomer(group.customerId)}
              aria-expanded={isExpanded}
              aria-label={(isExpanded ? "Collapse " : "Expand ") + group.customerName + " loadings"}
              className="flex w-full flex-wrap items-center justify-between gap-2 bg-primary/5 px-4 py-3 text-left transition-colors hover:bg-primary/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
              data-testid={"card-group-" + group.customerId}
            >
              <span className="flex min-w-0 flex-wrap items-center gap-2.5">
                {isExpanded ? (
                  <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                <Users className="h-4 w-4 shrink-0 text-primary" />
                <span className="font-bold tracking-tight" data-testid={"text-group-customer-" + group.customerId}>
                  {group.customerName}
                </span>
                <Badge variant="secondary" className="rounded-lg border border-border/70">
                  {group.loads.length} loadings
                </Badge>
              </span>
              <span className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground sm:text-sm">
                <span className="inline-flex items-center gap-1">
                  <Package className="h-3.5 w-3.5" /> {groupBales.toLocaleString()} bales total
                </span>
                <span className="inline-flex items-center gap-1">
                  <Weight className="h-3.5 w-3.5" /> {fmtKg(groupKg)}
                </span>
                <span className="hidden text-xs lg:inline">{isExpanded ? "Click to collapse" : "Click to expand"}</span>
              </span>
            </button>
            {isExpanded && (
              <div className="space-y-2 border-t border-border/70 p-2.5 sm:p-3">
                {group.loads.map((load) => renderLoadCard(load, true))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function FactoryPendingLoadingsDialogSection({
  closeLinkDialog,
  formatDisplayDate,
  handleConfirmLink,
  linkProformaMutation,
  linkTarget,
  proformas,
  proformasLoading,
  selectedProformaId,
  setSelectedProformaId,
}: Pick<
  ReturnType<typeof useFactoryPendingLoadingsState>,
  | "closeLinkDialog"
  | "formatDisplayDate"
  | "handleConfirmLink"
  | "linkProformaMutation"
  | "linkTarget"
  | "proformas"
  | "proformasLoading"
  | "selectedProformaId"
  | "setSelectedProformaId"
>) {
  return (
    <Dialog
      open={!!linkTarget}
      onOpenChange={(open) => {
        if (!open) closeLinkDialog();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Link Proforma to Loading #{linkTarget?.id}</DialogTitle>
          <DialogDescription>
            Select a proforma for <strong>{linkTarget?.customerName}</strong> to link to this loading. The proforma will
            be used to validate scanned bales.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2 max-h-[400px] overflow-y-auto py-2">
          {proformasLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          ) : proformas.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">No proformas found for this customer.</p>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setSelectedProformaId(null)}
                className={`w-full text-left rounded-md border p-3 transition-colors ${
                  selectedProformaId === null ? "border-primary bg-primary/5" : "border-border hover-elevate"
                }`}
                data-testid="option-no-proforma"
              >
                <div className="flex items-center gap-2">
                  <X className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm font-medium text-muted-foreground">No proforma (unlink)</span>
                </div>
              </button>

              {proformas.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setSelectedProformaId(p.id)}
                  className={`w-full text-left rounded-md border p-3 transition-colors ${
                    selectedProformaId === p.id ? "border-primary bg-primary/5" : "border-border hover-elevate"
                  }`}
                  data-testid={`option-proforma-${p.id}`}
                >
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm">{p.name || `Proforma #${p.id}`}</span>
                      <Badge
                        variant={p.status === "ACTIVE" ? "default" : "secondary"}
                        className="text-xs no-default-active-elevate"
                      >
                        {p.status}
                      </Badge>
                    </div>
                    <span className="text-xs text-muted-foreground">{p.lines?.length ?? 0} lines</span>
                  </div>
                  {p.createdAt && (
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Created {formatDisplayDate(p.createdAt.split("T")[0])}
                    </p>
                  )}
                </button>
              ))}
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={closeLinkDialog} data-testid="button-cancel-link">
            Cancel
          </Button>
          <Button
            onClick={handleConfirmLink}
            disabled={linkProformaMutation.isPending}
            data-testid="button-confirm-link"
          >
            {linkProformaMutation.isPending ? "Linking…" : "Confirm"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
