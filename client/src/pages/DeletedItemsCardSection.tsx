// Extracted from ./DeletedItems.tsx to keep that module under the source-size cap.
import { format } from "date-fns";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/page-state";
import { Checkbox } from "@/components/ui/checkbox";
import { Eye, Package, RotateCcw, Trash2, X } from "lucide-react";
import { typeIcons, typeLabels, useDeletedItemsState } from "./useDeletedItemsState";

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
          <>
            <div className="hidden md:block phone-land:hidden">
              <Table>
                <TableHeader className="sticky top-0 z-30 bg-background">
                  <TableRow>
                    <TableHead className="w-10">
                      <Checkbox
                        checked={items.length > 0 && items.every((item) => selectedItems.has(itemKey(item)))}
                        onCheckedChange={() => toggleAll(items)}
                        data-testid="checkbox-select-all"
                      />
                    </TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Code</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Deleted At</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((item) => {
                    const IconComponent = typeIcons[item.type] || Package;
                    return (
                      <TableRow
                        key={`${item.type}-${item.id}`}
                        data-testid={`row-deleted-${item.type}-${item.id}`}
                        className="cursor-pointer hover-elevate"
                        onClick={() => setDetailItem(item)}
                      >
                        <TableCell onClick={(e) => e.stopPropagation()}>
                          <Checkbox
                            checked={selectedItems.has(itemKey(item))}
                            onCheckedChange={() => toggleItem(item)}
                            data-testid={`checkbox-item-${item.type}-${item.id}`}
                          />
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <IconComponent className="h-4 w-4 text-muted-foreground" />
                            <Badge variant="outline">{typeLabels[item.type] || item.type}</Badge>
                          </div>
                        </TableCell>
                        <TableCell className="font-mono text-sm">{item.code || "-"}</TableCell>
                        <TableCell>
                          <div className="flex flex-col">
                            <span>{item.name}</span>
                            {item.accountType && (
                              <span className="text-xs text-muted-foreground">{item.accountType}</span>
                            )}
                            {item.type === "orphanedPosSale" && (
                              <span className="text-xs text-muted-foreground">
                                {item.locationName} | ${item.amount?.toLocaleString() || "0"}
                              </span>
                            )}
                            {item.type === "voucher" && (
                              <span className="text-xs text-muted-foreground">
                                {item.voucherType} | ${item.amount?.toLocaleString() || "0"}
                              </span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          {item.deletedAt
                            ? `${formatDisplayDate(item.deletedAt)} ${format(new Date(item.deletedAt), "h:mm a")}`
                            : "-"}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-2">
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={(e) => {
                                e.stopPropagation();
                                setDetailItem(item);
                              }}
                              data-testid={`button-view-${item.type}-${item.id}`}
                              data-remote-control-safe="true"
                              data-remote-control-action="view-details"
                            >
                              <Eye className="h-4 w-4" />
                            </Button>
                            {item.type !== "orphanedPosSale" && (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleRestore(item);
                                }}
                                disabled={restoreMutation.isPending || permanentDeleteMutation.isPending}
                                data-testid={`button-restore-${item.type}-${item.id}`}
                              >
                                <RotateCcw className="h-4 w-4 mr-1" />
                                Restore
                              </Button>
                            )}
                            <Button
                              variant="destructive"
                              size="sm"
                              onClick={(e) => {
                                e.stopPropagation();
                                handlePermanentDelete(item);
                              }}
                              disabled={restoreMutation.isPending || permanentDeleteMutation.isPending}
                              data-testid={`button-delete-permanent-${item.type}-${item.id}`}
                            >
                              <Trash2 className="h-4 w-4 mr-1" />
                              Delete Forever
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
            <div className="md:hidden phone-land:block space-y-3">
              {items.map((item) => {
                const IconComponent = typeIcons[item.type] || Package;
                return (
                  <Card
                    key={`${item.type}-${item.id}`}
                    className="p-4 cursor-pointer hover-elevate"
                    onClick={() => setDetailItem(item)}
                    data-testid={`card-deleted-${item.type}-${item.id}`}
                  >
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <div className="flex items-center gap-2">
                        <div onClick={(e) => e.stopPropagation()}>
                          <Checkbox
                            checked={selectedItems.has(itemKey(item))}
                            onCheckedChange={() => toggleItem(item)}
                            data-testid={`checkbox-card-${item.type}-${item.id}`}
                          />
                        </div>
                        <IconComponent className="h-4 w-4 text-muted-foreground" />
                        <Badge variant="outline">{typeLabels[item.type] || item.type}</Badge>
                      </div>
                      <span className="font-mono text-xs text-muted-foreground">{item.code || "-"}</span>
                    </div>
                    <p className="font-medium text-sm">{item.name}</p>
                    {item.accountType && <p className="text-xs text-muted-foreground">{item.accountType}</p>}
                    <p className="text-xs text-muted-foreground mt-1">
                      {item.deletedAt
                        ? `${formatDisplayDate(item.deletedAt)} ${format(new Date(item.deletedAt), "h:mm a")}`
                        : "-"}
                    </p>
                    <div className="flex flex-wrap gap-2 mt-3">
                      {item.type !== "orphanedPosSale" && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleRestore(item);
                          }}
                          disabled={restoreMutation.isPending || permanentDeleteMutation.isPending}
                        >
                          <RotateCcw className="h-4 w-4 mr-1" />
                          Restore
                        </Button>
                      )}
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          handlePermanentDelete(item);
                        }}
                        disabled={restoreMutation.isPending || permanentDeleteMutation.isPending}
                      >
                        <Trash2 className="h-4 w-4 mr-1" />
                        Delete
                      </Button>
                    </div>
                  </Card>
                );
              })}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
