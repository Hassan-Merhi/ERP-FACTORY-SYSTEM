// Extracted from ./FactoryProformas.tsx
import { searchAny } from "@shared/searchNormalization";
import { EmptyState } from "@/components/ui/page-state";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { FileText, Plus, Users } from "lucide-react";
import { ProformaCard } from "./factoryproformas/ProformaCard";
import { useFactoryProformasState } from "./useFactoryProformasState";

export function FactoryProformasContent({
  beginAssignDestination,
  beginInlineQtyEdit,
  beginRename,
  beginTransfer,
  customerId,
  customersLoading,
  expandedProformaIds,
  expandedProformaStateById,
  model,
  navigate,
  openAddLineFor,
  proformas,
  proformaSearch,
  proformasLoading,
  recordChanges,
  setExpandedProformaIds,
  setPendingDelete,
  setShowInactive,
  showInactive,
}: Pick<
  ReturnType<typeof useFactoryProformasState>,
  | "beginAssignDestination"
  | "beginInlineQtyEdit"
  | "beginRename"
  | "beginTransfer"
  | "customerId"
  | "customersLoading"
  | "expandedProformaIds"
  | "expandedProformaStateById"
  | "model"
  | "navigate"
  | "openAddLineFor"
  | "proformas"
  | "proformaSearch"
  | "proformasLoading"
  | "recordChanges"
  | "setExpandedProformaIds"
  | "setPendingDelete"
  | "setShowInactive"
  | "showInactive"
>) {
  return (
    <div className="min-h-0 flex-1 overflow-auto px-4 py-5 sm:px-6">
      {/* Loading skeletons */}
      {customerId && proformasLoading && (
        <div className="space-y-3">
          {[...Array(3)].map((_, i) => (
            <Skeleton key={i} className="h-20 w-full rounded-lg" />
          ))}
        </div>
      )}

      {/* Empty: no customer selected */}
      {!customerId && !customersLoading && (
        <div className="flex flex-col items-center justify-center py-20 text-center" data-testid="text-select-customer">
          <div className="rounded-full bg-muted p-4 mb-4">
            <Users className="h-8 w-8 text-muted-foreground" />
          </div>
          <p className="font-medium text-muted-foreground">No customer selected</p>
          <p className="text-sm text-muted-foreground mt-1">Pick a customer above to view their proformas</p>
        </div>
      )}

      {/* Empty: customer selected but no proformas */}
      {customerId && !proformasLoading && proformas.length === 0 && (
        <EmptyState
          icon={FileText}
          title="No proformas yet"
          description="Create a proforma to define this customer's pricing"
          data-testid="text-no-proformas"
          action={
            !recordChanges.isCreateOnly ? (
              <Button size="sm" onClick={() => model.setIsCreateOpen(true)}>
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                New Proforma
              </Button>
            ) : undefined
          }
        />
      )}

      {/* Proforma list */}
      {customerId && !proformasLoading && proformas.length > 0 && (
        <div className="space-y-4">
          {/* Inactive toggle + search status */}
          {(() => {
            const inactiveCount = proformas.filter((p) => !p.isActive).length;
            const searchTerm = proformaSearch.trim().toLowerCase();
            const visibleProformas = proformas
              .filter((p) => p.isActive || showInactive)
              .filter((p) => searchAny(searchTerm, p.name, p.code));
            const allExpanded =
              visibleProformas.length > 0 && visibleProformas.every((p) => expandedProformaIds.has(p.id));
            return (
              <div className="flex items-center justify-between gap-2 flex-wrap">
                {searchTerm ? (
                  <p className="text-sm text-muted-foreground">
                    {visibleProformas.length === 0
                      ? `No proformas match "${proformaSearch}"`
                      : `${visibleProformas.length} proforma${visibleProformas.length !== 1 ? "s" : ""} matching "${proformaSearch}"`}
                  </p>
                ) : (
                  <div />
                )}
                <div className="flex items-center gap-2 ml-auto">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      if (allExpanded) {
                        setExpandedProformaIds(new Set());
                      } else {
                        setExpandedProformaIds(new Set(visibleProformas.map((p) => p.id)));
                      }
                    }}
                    data-testid="button-expand-collapse-all"
                    className="rounded-lg text-muted-foreground hover:bg-violet-500/10 hover:text-violet-600 dark:hover:text-violet-300"
                  >
                    {allExpanded ? "Collapse all" : "Expand all"}
                  </Button>
                  {inactiveCount > 0 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowInactive((v) => !v)}
                      data-testid="button-toggle-inactive-proformas"
                      className="text-muted-foreground"
                    >
                      {showInactive ? `Hide inactive (${inactiveCount})` : `Show inactive (${inactiveCount})`}
                    </Button>
                  )}
                </div>
              </div>
            );
          })()}

          {proformas
            .filter((p) => p.isActive || showInactive)
            .filter((p) => searchAny(proformaSearch, p.name))
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((proforma) => {
              const isExpanded = expandedProformaIds.has(proforma.id);
              const detailState = expandedProformaStateById.get(proforma.id);
              const detailProforma = detailState?.data;
              const detailLoading = isExpanded && !detailProforma && (detailState?.isLoading ?? true);
              const detailError = isExpanded && !detailProforma && (detailState?.isError ?? false);

              return (
                <ProformaCard
                  key={proforma.id}
                  proforma={proforma}
                  isExpanded={isExpanded}
                  onToggleExpand={() =>
                    setExpandedProformaIds((prev) => {
                      const next = new Set(prev);
                      if (next.has(proforma.id)) next.delete(proforma.id);
                      else next.add(proforma.id);
                      return next;
                    })
                  }
                  detailProforma={detailProforma}
                  detailLoading={detailLoading}
                  detailError={detailError}
                  onDetailRefetch={() => detailState?.refetch()}
                  customerId={customerId}
                  hideProformaPrice={model.hideProformaPrice}
                  canEdit={model.canEdit}
                  recordChanges={recordChanges}
                  formatAmount={model.formatAmount}
                  formatProformaDate={model.formatProformaDate}
                  navigate={navigate}
                  toggleActiveMutation={model.toggleActiveMutation}
                  deleteProformaMutation={model.deleteProformaMutation}
                  renameProforma={beginRename}
                  transferProforma={beginTransfer}
                  onAssignDestination={beginAssignDestination}
                  setPendingDelete={setPendingDelete}
                  onAddLine={() => openAddLineFor(proforma.id)}
                  saveAgreedPricesMutation={model.saveAgreedPricesMutation}
                  applyAgreedPricesMutation={model.applyAgreedPricesMutation}
                  applyProductionPricesMutation={model.applyProductionPricesMutation}
                  applyCatalogPricesMutation={model.applyCatalogPricesMutation}
                  inlineQtyLineId={model.inlineQtyLineId}
                  inlineQtyValue={model.inlineQtyValue}
                  onInlineQtyValueChange={model.setInlineQtyValue}
                  onInlineQtyEdit={beginInlineQtyEdit}
                  onInlineQtyCancel={() => model.setInlineQtyLineId(null)}
                  commitInlineQty={model.commitInlineQty}
                  onEditLine={(line) => {
                    model.setEditingLine(line);
                    model.setEditLineValues({
                      productName: line.productName,
                      quantity: String(line.quantity),
                      pricePerBale: line.pricePerBale,
                      weightPerBaleKg: line.weightPerBaleKg ?? "",
                    });
                  }}
                  deleteLineMutation={model.deleteLineMutation}
                />
              );
            })}
        </div>
      )}
    </div>
  );
}
