// Extracted from ./DeletedItems.tsx to keep that module under the source-size cap.
import type { ClientErrorLike } from "@/lib/clientError";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { useAppMode } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import { useToast } from "@/hooks/use-toast";
import { useDateFormat } from "@/contexts/DateFormatContext";
import {
  BookOpen,
  Boxes,
  Building2,
  ClipboardList,
  Container,
  FileText,
  FlaskConical,
  FolderTree,
  Layers,
  type LucideIcon,
  MapPin,
  Package,
  Package2,
  Receipt,
  ShoppingCart,
  Truck,
  User,
  Users,
} from "lucide-react";

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

export const typeLabels: Record<string, string> = {
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

export const typeIcons: Record<string, LucideIcon> = {
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

export function useDeletedItemsState() {
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
        title: "Restore failed",
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
        title: "Delete failed",
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
        title: "Delete failed",
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
  return {
    bulkDeleteMutation,
    confirmAction,
    confirmDialog,
    data,
    detailItem,
    entriesLoading,
    error,
    filterType,
    formatDisplayDate,
    handlePermanentDelete,
    handleRestore,
    isLoading,
    itemKey,
    items,
    permanentDeleteMutation,
    restoreMutation,
    selectedItems,
    setConfirmDialog,
    setDetailItem,
    setFilterType,
    setSelectedItems,
    setShowBulkDeleteDialog,
    showBulkDeleteDialog,
    toggleAll,
    toggleItem,
    voucherEntries,
  };
}
