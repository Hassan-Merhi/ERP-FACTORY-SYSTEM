// Extracted from ./DeletedItems.tsx to keep that module under the source-size cap.
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/page-state";
import { Trash2, X } from "lucide-react";
import { typeLabels, useDeletedItemsState } from "./useDeletedItemsState";
import { DeletedItemsCardSectionContent } from "./DeletedItemsCardSectionContent";

export function DeletedItemsCardSection({
  data,
  filterType,
  formatDisplayDate,
  handlePermanentDelete,
  handleRestore,
  itemKey,
  items,
  permanentDeleteMutation,
  restoreMutation,
  selectedItems,
  setDetailItem,
  setFilterType,
  setSelectedItems,
  setShowBulkDeleteDialog,
  toggleAll,
  toggleItem,
}: Pick<
  ReturnType<typeof useDeletedItemsState>,
  | "data"
  | "filterType"
  | "formatDisplayDate"
  | "handlePermanentDelete"
  | "handleRestore"
  | "itemKey"
  | "items"
  | "permanentDeleteMutation"
  | "restoreMutation"
  | "selectedItems"
  | "setDetailItem"
  | "setFilterType"
  | "setSelectedItems"
  | "setShowBulkDeleteDialog"
  | "toggleAll"
  | "toggleItem"
>) {
  return (
    <Card>
      <CardHeader className="p-3 sm:p-6">
        <div className="flex flex-wrap items-center justify-end gap-4">
          <div className="flex w-full items-center gap-2 sm:w-auto">
            <span className="text-sm text-muted-foreground">Filter:</span>
            <Select value={filterType} onValueChange={setFilterType}>
              <SelectTrigger className="w-full sm:w-[180px]" data-testid="select-filter-type">
                <SelectValue placeholder="All types" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Types ({data?.totalCount || 0})</SelectItem>
                <SelectItem value="location">Locations ({data?.locations.length || 0})</SelectItem>
                <SelectItem value="stockItem">Stock Items ({data?.stockItems.length || 0})</SelectItem>
                <SelectItem value="stockGroup">Stock Groups ({data?.stockGroups.length || 0})</SelectItem>
                <SelectItem value="ledgerAccount">Ledger Accounts ({data?.ledgerAccounts.length || 0})</SelectItem>
                <SelectItem value="employee">Employees ({data?.employees.length || 0})</SelectItem>
                <SelectItem value="customer">Customers ({data?.customers.length || 0})</SelectItem>
                <SelectItem value="supplier">Suppliers ({data?.suppliers.length || 0})</SelectItem>
                <SelectItem value="bankAccount">Bank Accounts ({data?.bankAccounts.length || 0})</SelectItem>
                <SelectItem value="voucher">Vouchers ({data?.vouchers?.length || 0})</SelectItem>
                <SelectItem value="orphanedPosSale">
                  Orphaned POS Sales ({data?.orphanedPosSales?.length || 0})
                </SelectItem>
                <SelectItem value="factoryCategory">
                  Factory Categories ({data?.factoryCategories?.length || 0})
                </SelectItem>
                <SelectItem value="factoryBaleProduct">
                  Bale Products ({data?.factoryBaleProducts?.length || 0})
                </SelectItem>
                <SelectItem value="factoryContainer">Containers ({data?.factoryContainers?.length || 0})</SelectItem>
                <SelectItem value="factoryRawStock">
                  Raw Stock Receipts ({data?.factoryRawStock?.length || 0})
                </SelectItem>
                <SelectItem value="factoryRawMaterialAdjustment">
                  Raw Material Adjustments ({data?.factoryRawMaterialAdjustments?.length || 0})
                </SelectItem>
                <SelectItem value="factoryMixBatch">Mix Batches ({data?.factoryMixBatches?.length || 0})</SelectItem>
                <SelectItem value="factoryBale">Bales ({data?.factoryBales?.length || 0})</SelectItem>
                <SelectItem value="customerProforma">
                  Proforma Invoices ({data?.customerProformas?.length || 0})
                </SelectItem>
                <SelectItem value="customerOrder">
                  Customer Invoices/Orders ({data?.customerOrders?.length || 0})
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {selectedItems.size > 0 && (
          <div className="flex items-center justify-between gap-3 mb-4 px-3 py-2 rounded-md bg-destructive/10 border border-destructive/20">
            <span className="text-sm font-medium text-destructive">
              {selectedItems.size} item{selectedItems.size !== 1 ? "s" : ""} selected
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setSelectedItems(new Set())}
                data-testid="button-clear-selection"
              >
                <X className="h-4 w-4 mr-1" />
                Clear
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setShowBulkDeleteDialog(true)}
                data-testid="button-bulk-delete"
              >
                <Trash2 className="h-4 w-4 mr-1" />
                Delete All Selected
              </Button>
            </div>
          </div>
        )}
        {items.length === 0 ? (
          <EmptyState
            icon={Trash2}
            title="No deleted items"
            description={
              filterType === "all"
                ? "Items you delete will appear here for recovery."
                : filterType === "orphanedPosSale"
                  ? "No orphaned POS sales found. These are vouchers linked to deleted locations."
                  : `No deleted ${typeLabels[filterType]?.toLowerCase() || filterType}s found.`
            }
            className="py-12"
          />
        ) : (
          <DeletedItemsCardSectionContent
            formatDisplayDate={formatDisplayDate}
            handlePermanentDelete={handlePermanentDelete}
            handleRestore={handleRestore}
            itemKey={itemKey}
            items={items}
            permanentDeleteMutation={permanentDeleteMutation}
            restoreMutation={restoreMutation}
            selectedItems={selectedItems}
            setDetailItem={setDetailItem}
            toggleAll={toggleAll}
            toggleItem={toggleItem}
          />
        )}
      </CardContent>
    </Card>
  );
}
