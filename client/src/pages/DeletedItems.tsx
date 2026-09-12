import type { ClientErrorLike } from "@/lib/clientError";
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { queryClient } from "@/lib/queryClient";
import { useAppMode } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Trash2,
  RotateCcw,
  AlertTriangle,
  MapPin,
  Package,
  Package2,
  FolderTree,
  BookOpen,
  Users,
  User,
  Truck,
  Building2,
  Loader2,
  Receipt,
  FileText,
  FlaskConical,
  Layers,
  Boxes,
  Container,
  ShoppingCart,
  ClipboardList,
  Eye,
  X,
} from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Separator } from "@/components/ui/separator";
import type { LucideIcon } from "lucide-react";

interface DeletedItem {
  id: number;
  type: string;
  name: string;
  code: string;
  accountType?: string;
  deletedAt: string;
  amount?: number;
  date?: string;
  locationName?: string;
  voucherType?: string;
}

interface DeletedItemsResponse {
  locations: DeletedItem[];
  stockItems: DeletedItem[];
  stockGroups: DeletedItem[];
  ledgerAccounts: DeletedItem[];
  employees: DeletedItem[];
  customers: DeletedItem[];
  suppliers: DeletedItem[];
  bankAccounts: DeletedItem[];
  vouchers: DeletedItem[];
  orphanedPosSales: DeletedItem[];
  factoryCategories?: DeletedItem[];
  factoryBaleProducts?: DeletedItem[];
  factoryContainers?: DeletedItem[];
  factoryRawStock?: DeletedItem[];
  factoryRawMaterialAdjustments?: DeletedItem[];
  factoryMixBatches?: DeletedItem[];
  factoryBales?: DeletedItem[];
  customerProformas?: DeletedItem[];
  customerOrders?: DeletedItem[];
  totalCount: number;
}

const typeLabels: Record<string, string> = {
  location: "Location",
  stockItem: "Stock Item",
  stockGroup: "Stock Group",
  ledgerAccount: "Ledger Account",
  employee: "Employee",
  customer: "Customer",
  supplier: "Supplier",
  bankAccount: "Bank Account",
  voucher: "Voucher",
  orphanedPosSale: "Orphaned POS Sale",
  factoryCategory: "Factory Category",
  factoryBaleProduct: "Bale Product",
  factoryContainer: "Container",
  factoryRawStock: "Raw Stock Receipt",
  factoryRawMaterialAdjustment: "Raw Material Adjustment",
  factoryMixBatch: "Mix Batch",
  factoryBale: "Bale",
  customerProforma: "Proforma Invoice",
  customerOrder: "Customer Invoice/Order",
};

const typeIcons: Record<string, LucideIcon> = {
  location: MapPin,
  stockItem: Package,
  stockGroup: FolderTree,
  ledgerAccount: BookOpen,
  employee: Users,
  customer: User,
  supplier: Truck,
  bankAccount: Building2,
  voucher: FileText,
  orphanedPosSale: Receipt,
  factoryCategory: FolderTree,
  factoryBaleProduct: Package2,
  factoryContainer: Container,
  factoryRawStock: Boxes,
  factoryRawMaterialAdjustment: ClipboardList,
  factoryMixBatch: FlaskConical,
  factoryBale: Layers,
  customerProforma: FileText,
  customerOrder: ShoppingCart,
};

export default function DeletedItems() {
  const { toast } = useToast();
  const appMode = useAppMode();
  const modeApiRequest = getApiRequest(appMode);
  const { formatDisplayDate } = useDateFormat();
  const [filterType, setFilterType] = useState<string>("all");
  const [confirmDialog, setConfirmDialog] = useState<{
    open: boolean;
    action: "restore" | "delete";
    item: DeletedItem | null;
  }>({ open: false, action: "restore", item: null });
  const [detailItem, setDetailItem] = useState<DeletedItem | null>(null);
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  const [showBulkDeleteDialog, setShowBulkDeleteDialog] = useState(false);

  const { data, isLoading, error } = useQuery<DeletedItemsResponse>({
    queryKey: ["/api/deleted-items"],
  });

  // Fetch journal entries for the selected voucher (to show accounts + descriptions)
  const { data: voucherEntries = [], isLoading: entriesLoading } = useQuery<
    { id?: number; accountName?: string; description?: string; debitAmount?: string; creditAmount?: string }[]
  >({
    queryKey: ["/api/vouchers", detailItem?.id, "view-entries"],
    queryFn: async () => {
      const res = await fetch(`/api/vouchers/${detailItem!.id}/view-entries`, { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!detailItem && detailItem.type === "voucher",
  });

  const restoreMutation = useMutation({
    mutationFn: async ({ type, id }: { type: string; id: number }) => {
      return modeApiRequest("POST", `/api/deleted-items/${type}/${id}/restore`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/deleted-items"] });
      queryClient.invalidateQueries({ queryKey: ["/api/locations"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stock-items"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stock-items/light"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stock-groups"] });
      queryClient.invalidateQueries({ queryKey: ["/api/ledger-accounts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/employees"] });
      queryClient.invalidateQueries({ queryKey: ["/api/customers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/suppliers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/bank-accounts"] });
      toast({
        title: "Item Restored",
        description: "The item has been restored successfully.",
      });
      setConfirmDialog({ open: false, action: "restore", item: null });
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({
        title: "Error",
        description: error.message || "Failed to restore item",
        variant: "destructive",
      });
    },
  });

  const permanentDeleteMutation = useMutation({
    mutationFn: async ({ type, id }: { type: string; id: number }) => {
      return modeApiRequest("DELETE", `/api/deleted-items/${type}/${id}/permanent`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/deleted-items"] });
      toast({
        title: "Permanently Deleted",
        description: "The item has been permanently removed.",
        variant: "destructive",
      });
      setConfirmDialog({ open: false, action: "delete", item: null });
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({
        title: "Error",
        description: error.message || "Failed to permanently delete item",
        variant: "destructive",
      });
    },
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: async (itemsToDelete: { type: string; id: number }[]) => {
      await Promise.all(
        itemsToDelete.map(({ type, id }) => modeApiRequest("DELETE", `/api/deleted-items/${type}/${id}/permanent`))
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/deleted-items"] });
      setSelectedItems(new Set());
      setShowBulkDeleteDialog(false);
      toast({
        title: "Permanently Deleted",
        description: "All selected items have been permanently removed.",
        variant: "destructive",
      });
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({
        title: "Error",
        description: error.message || "Failed to delete some items",
        variant: "destructive",
      });
    },
  });

  const itemKey = (item: DeletedItem) => `${item.type}-${item.id}`;

  const toggleItem = (item: DeletedItem) => {
    setSelectedItems((prev) => {
      const next = new Set(prev);
      const key = itemKey(item);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleAll = (currentItems: DeletedItem[]) => {
    const allKeys = currentItems.map(itemKey);
    const allSelected = allKeys.every((k) => selectedItems.has(k));
    if (allSelected) {
      setSelectedItems((prev) => {
        const next = new Set(prev);
        allKeys.forEach((k) => next.delete(k));
        return next;
      });
    } else {
      setSelectedItems((prev) => {
        const next = new Set(prev);
        allKeys.forEach((k) => next.add(k));
        return next;
      });
    }
  };

  const getAllItems = (): DeletedItem[] => {
    if (!data) return [];
    const allItems = [
      ...data.locations,
      ...data.stockItems,
      ...data.stockGroups,
      ...data.ledgerAccounts,
      ...data.employees,
      ...data.customers,
      ...data.suppliers,
      ...data.bankAccounts,
      ...(data.vouchers || []),
      ...(data.orphanedPosSales || []),
      ...(data.factoryCategories || []),
      ...(data.factoryBaleProducts || []),
      ...(data.factoryContainers || []),
      ...(data.factoryRawStock || []),
      ...(data.factoryRawMaterialAdjustments || []),
      ...(data.factoryMixBatches || []),
      ...(data.factoryBales || []),
      ...(data.customerProformas || []),
      ...(data.customerOrders || []),
    ];
    if (filterType === "all") return allItems;
    return allItems.filter((item) => item.type === filterType);
  };

  const items = getAllItems();

  const handleRestore = (item: DeletedItem) => {
    setConfirmDialog({ open: true, action: "restore", item });
  };

  const handlePermanentDelete = (item: DeletedItem) => {
    setConfirmDialog({ open: true, action: "delete", item });
  };

  const confirmAction = () => {
    if (!confirmDialog.item) return;
    if (confirmDialog.action === "restore") {
      restoreMutation.mutate({
        type: confirmDialog.item.type,
        id: confirmDialog.item.id,
      });
    } else {
      permanentDeleteMutation.mutate({
        type: confirmDialog.item.type,
        id: confirmDialog.item.id,
      });
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-destructive">Failed to load deleted items</p>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 space-y-4 md:space-y-6">
      <Card>
        <CardHeader>
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 flex-wrap">
            <div>
              <CardTitle className="flex items-center gap-2" data-testid="title-deleted-items">
                <Trash2 className="h-5 w-5" />
                Deleted Items
              </CardTitle>
              <CardDescription>
                View and manage deleted records. You can restore items or permanently delete them.
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
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
            <div className="text-center py-12">
              <Trash2 className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
              <h3 className="text-lg font-medium text-muted-foreground">No deleted items</h3>
              <p className="text-sm text-muted-foreground mt-1">
                {filterType === "all"
                  ? "Items you delete will appear here for recovery."
                  : filterType === "orphanedPosSale"
                    ? "No orphaned POS sales found. These are vouchers linked to deleted locations."
                    : `No deleted ${typeLabels[filterType]?.toLowerCase() || filterType}s found.`}
              </p>
            </div>
          ) : (
            <>
              <div className="hidden md:block">
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
              <div className="md:hidden space-y-3">
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

      <AlertDialog open={showBulkDeleteDialog} onOpenChange={setShowBulkDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              Permanently Delete {selectedItems.size} Item{selectedItems.size !== 1 ? "s" : ""}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove all {selectedItems.size} selected item{selectedItems.size !== 1 ? "s" : ""}.
              This action cannot be undone and all associated data will be lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-bulk-delete">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                const toDelete = items
                  .filter((item) => selectedItems.has(itemKey(item)))
                  .map(({ type, id }) => ({ type, id }));
                bulkDeleteMutation.mutate(toDelete);
              }}
              data-testid="button-confirm-bulk-delete"
            >
              {bulkDeleteMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Delete Forever
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmDialog.open} onOpenChange={(open) => setConfirmDialog({ ...confirmDialog, open })}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              {confirmDialog.action === "delete" && <AlertTriangle className="h-5 w-5 text-destructive" />}
              {confirmDialog.action === "restore" ? "Restore Item?" : "Permanently Delete Item?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmDialog.action === "restore" ? (
                <>
                  This will restore{" "}
                  <strong>
                    {confirmDialog.item?.name} ({confirmDialog.item?.code || "no code"})
                  </strong>{" "}
                  and make it active again.
                </>
              ) : (
                <>
                  This will permanently delete{" "}
                  <strong>
                    {confirmDialog.item?.name} ({confirmDialog.item?.code || "no code"})
                  </strong>
                  . This action cannot be undone and all associated data will be lost.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-dialog">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmAction}
              className={
                confirmDialog.action === "delete"
                  ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  : ""
              }
              data-testid="button-confirm-dialog"
            >
              {restoreMutation.isPending || permanentDeleteMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : null}
              {confirmDialog.action === "restore" ? "Restore" : "Delete Forever"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Sheet open={!!detailItem} onOpenChange={(open) => !open && setDetailItem(null)}>
        <SheetContent className="w-[95vw] sm:w-[400px] md:w-[540px]">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              {detailItem &&
                (() => {
                  const IconComponent = typeIcons[detailItem.type] || Package;
                  return <IconComponent className="h-5 w-5" />;
                })()}
              {typeLabels[detailItem?.type || ""] || detailItem?.type} Details
            </SheetTitle>
            <SheetDescription>Viewing deleted item information</SheetDescription>
          </SheetHeader>
          {detailItem && (
            <div className="mt-6 space-y-4 overflow-y-auto max-h-[calc(100vh-10rem)] pr-1">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm text-muted-foreground">Type</p>
                  <p className="font-medium">{typeLabels[detailItem.type] || detailItem.type}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">ID</p>
                  <p className="font-medium font-mono">{detailItem.id}</p>
                </div>
              </div>
              <Separator />
              <div>
                <p className="text-sm text-muted-foreground">Code</p>
                <p className="font-medium font-mono">{detailItem.code || "-"}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Name</p>
                <p className="font-medium">{detailItem.name}</p>
              </div>
              {detailItem.accountType && (
                <div>
                  <p className="text-sm text-muted-foreground">Account Type</p>
                  <p className="font-medium">{detailItem.accountType}</p>
                </div>
              )}
              {detailItem.voucherType && (
                <div>
                  <p className="text-sm text-muted-foreground">Voucher Type</p>
                  <p className="font-medium">{detailItem.voucherType}</p>
                </div>
              )}
              {detailItem.amount !== undefined && (
                <div>
                  <p className="text-sm text-muted-foreground">Amount</p>
                  <p className="font-medium">${detailItem.amount?.toLocaleString() || "0"}</p>
                </div>
              )}
              {detailItem.date && (
                <div>
                  <p className="text-sm text-muted-foreground">Date</p>
                  <p className="font-medium">{formatDisplayDate(detailItem.date)}</p>
                </div>
              )}
              {detailItem.locationName && (
                <div>
                  <p className="text-sm text-muted-foreground">Location</p>
                  <p className="font-medium">{detailItem.locationName}</p>
                </div>
              )}
              {detailItem.type === "voucher" && (
                <>
                  <Separator />
                  <div>
                    <p className="text-sm font-medium mb-2">Journal Entries</p>
                    {entriesLoading ? (
                      <div className="space-y-2">
                        {[1, 2, 3].map((i) => (
                          <Skeleton key={i} className="h-10 w-full" />
                        ))}
                      </div>
                    ) : voucherEntries.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No entries found</p>
                    ) : (
                      <div className="rounded-md border overflow-hidden">
                        <table className="w-full text-sm">
                          <thead className="sticky top-0 z-30 bg-muted/50">
                            <tr className="border-b bg-muted/40">
                              <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Account</th>
                              <th className="text-right px-3 py-2 text-xs font-medium text-muted-foreground">Debit</th>
                              <th className="text-right px-3 py-2 text-xs font-medium text-muted-foreground">Credit</th>
                            </tr>
                          </thead>
                          <tbody>
                            {voucherEntries.map((entry, i: number) => (
                              <tr key={entry.id ?? i} className="border-b last:border-0">
                                <td className="px-3 py-2">
                                  <p className="font-medium text-xs">{entry.accountName || "—"}</p>
                                  {entry.description && (
                                    <p className="text-xs text-muted-foreground mt-0.5">{entry.description}</p>
                                  )}
                                </td>
                                <td className="px-3 py-2 text-right font-mono text-xs">
                                  {parseFloat(entry.debitAmount || "0") > 0
                                    ? `$${parseFloat(entry.debitAmount || "0").toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                                    : "—"}
                                </td>
                                <td className="px-3 py-2 text-right font-mono text-xs">
                                  {parseFloat(entry.creditAmount || "0") > 0
                                    ? `$${parseFloat(entry.creditAmount || "0").toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                                    : "—"}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                          <tfoot className="sticky bottom-0 z-20 bg-background">
                            <tr className="bg-muted/50 font-semibold">
                              <td className="px-3 py-2 text-xs">Total</td>
                              <td className="px-3 py-2 text-right font-mono text-xs">
                                $
                                {voucherEntries
                                  .reduce((s: number, e) => s + parseFloat(e.debitAmount || "0"), 0)
                                  .toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                              </td>
                              <td className="px-3 py-2 text-right font-mono text-xs">
                                $
                                {voucherEntries
                                  .reduce((s: number, e) => s + parseFloat(e.creditAmount || "0"), 0)
                                  .toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                              </td>
                            </tr>
                          </tfoot>
                        </table>
                      </div>
                    )}
                  </div>
                </>
              )}
              <Separator />
              <div>
                <p className="text-sm text-muted-foreground">Deleted At</p>
                <p className="font-medium">
                  {detailItem.deletedAt
                    ? `${formatDisplayDate(detailItem.deletedAt)} ${format(new Date(detailItem.deletedAt), "h:mm a")}`
                    : "-"}
                </p>
              </div>
              <div className="flex gap-2 pt-4">
                {detailItem.type !== "orphanedPosSale" && (
                  <Button
                    variant="outline"
                    onClick={() => {
                      handleRestore(detailItem);
                      setDetailItem(null);
                    }}
                    disabled={restoreMutation.isPending}
                    data-testid="button-restore-detail"
                  >
                    <RotateCcw className="h-4 w-4 mr-2" />
                    Restore
                  </Button>
                )}
                <Button
                  variant="destructive"
                  onClick={() => {
                    handlePermanentDelete(detailItem);
                    setDetailItem(null);
                  }}
                  disabled={permanentDeleteMutation.isPending}
                  data-testid="button-delete-detail"
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  Delete Forever
                </Button>
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
