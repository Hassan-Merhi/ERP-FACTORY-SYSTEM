import { VoucherPhoneActionBar } from "@/pages/vouchers/VoucherPhoneActionBar";
import { searchAny } from "@shared/searchNormalization";
import type { ClientErrorLike } from "@/lib/clientError";
import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@/lib/form-resolver";
import { z } from "zod";
import { format } from "date-fns";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { formatNumber } from "@/lib/formatNumber";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Form, FormControl, FormField, FormItem, FormLabel } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Plus, Trash2, Search, Package, MapPin, Pencil } from "lucide-react";
import { cn } from "@/lib/utils";
import { AccountAutocomplete } from "@/components/AccountAutocomplete";
import type { CombinedAccount } from "@/components/AccountAutocomplete";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";

interface StockItem {
  id: number;
  code: string;
  name: string;
  uom: string;
}

interface InventoryItem {
  stockItemId: number;
  quantity: string;
  averageRate: string;
}

interface Location {
  id: number;
  code?: string;
  name: string;
}

interface CreditNoteItem {
  rowKey: string;
  stockItemId: number;
  stockItemName: string;
  locationId: number;
  locationName: string;
  quantity: string;
  refundRate: string;
  inventoryCost: string;
  uom: string;
}

let creditNoteRowSequence = 0;
function nextCreditNoteRowKey(prefix = "row"): string {
  creditNoteRowSequence += 1;
  return `${prefix}-${Date.now()}-${creditNoteRowSequence}`;
}

interface CreditNoteData {
  voucher: {
    id: number;
    voucherNumber: string;
    voucherType: string;
    voucherDate: string;
    description: string;
    totalAmount: string;
  };
  cashAccountId: number;
  cashAccountType: string;
  items: Array<{
    stockItemId: number;
    stockItemName: string;
    stockItemCode: string;
    locationId: number;
    locationName: string;
    quantity: string;
    refundRate: string;
    inventoryCost: string;
    uom: string;
  }>;
}

const creditNoteSchema = z.object({
  noteType: z.enum(["Credit Note", "Debit Note"]),
  voucherDate: z.string().min(1, "Date is required"),
  cashAccountType: z.string().min(1, "Account type is required"),
  cashAccountId: z.number().min(1, "Cash/Bank account is required"),
  cashAccountName: z.string().optional(),
  description: z.string().optional(),
});

type CreditNoteFormData = z.infer<typeof creditNoteSchema>;

interface CreditNoteTabProps {
  allAccounts: CombinedAccount[];
  editVoucherId?: number | null;
}

export function CreditNoteTab({ allAccounts, editVoucherId }: CreditNoteTabProps) {
  const { toast } = useToast();
  const { formatDisplayDate: _formatDisplayDate } = useDateFormat();
  const [items, setItems] = useState<CreditNoteItem[]>([]);
  const [selectedLocationId, setSelectedLocationId] = useState<number>(0);
  const [searchTerm, setSearchTerm] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [itemQuantity, setItemQuantity] = useState("1");
  const [refundRate, setRefundRate] = useState("");
  const [isEditMode, setIsEditMode] = useState(false);
  const [editingVoucherId, setEditingVoucherId] = useState<number | null>(null);
  const itemListRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const form = useForm<CreditNoteFormData>({
    resolver: zodResolver(creditNoteSchema),
    defaultValues: {
      noteType: "Credit Note",
      voucherDate: format(new Date(), "yyyy-MM-dd"),
      cashAccountType: "",
      cashAccountId: 0,
      cashAccountName: "",
      description: "",
    },
  });

  const { data: locations = [] } = useQuery<Location[]>({
    queryKey: ["/api/locations"],
  });

  const { data: allStockItems = [] } = useQuery<StockItem[]>({
    queryKey: ["/api/stock-items/light"],
    staleTime: 10 * 60 * 1000,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    refetchOnReconnect: false,
  });

  const { data: locationInventory = [] } = useQuery<InventoryItem[]>({
    queryKey: selectedLocationId ? ["/api/locations", selectedLocationId, "inventory"] : [],
    enabled: selectedLocationId > 0,
  });

  const { data: editData, isLoading: editLoading } = useQuery<CreditNoteData>({
    queryKey: editVoucherId ? ["/api/credit-notes", editVoucherId] : [],
    enabled: !!editVoucherId,
  });

  useEffect(() => {
    if (editData && editVoucherId && !isEditMode) {
      setIsEditMode(true);
      setEditingVoucherId(editVoucherId);

      form.reset({
        noteType: editData.voucher.voucherType as "Credit Note" | "Debit Note",
        voucherDate: editData.voucher.voucherDate,
        cashAccountType: editData.cashAccountType,
        cashAccountId: editData.cashAccountId,
        cashAccountName: "",
        description: editData.voucher.description || "",
      });

      const firstLocationId = editData.items[0]?.locationId || 0;
      setSelectedLocationId(firstLocationId);

      const loadedItems: CreditNoteItem[] = editData.items.map((item, index) => ({
        rowKey: `existing-${editVoucherId}-${index}-${item.stockItemId}-${item.locationId}`,
        stockItemId: item.stockItemId,
        stockItemName: item.stockItemName,
        locationId: item.locationId,
        locationName: item.locationName,
        quantity: item.quantity,
        refundRate: item.refundRate,
        inventoryCost: item.inventoryCost || "0",
        uom: item.uom,
      }));
      setItems(loadedItems);
    }
  }, [editData, editVoucherId, isEditMode, form]);

  const inventoryMap = useMemo(() => {
    const map = new Map<number, { quantity: number; rate: number }>();
    for (const inv of locationInventory) {
      map.set(inv.stockItemId, {
        quantity: parseFloat(inv.quantity || "0"),
        rate: parseFloat(inv.averageRate || "0"),
      });
    }
    return map;
  }, [locationInventory]);

  const itemsWithStock = useMemo(() => {
    return allStockItems.map((item) => {
      const inv = inventoryMap.get(item.id);
      return {
        ...item,
        stockQty: inv?.quantity || 0,
        avgRate: inv?.rate || 0,
      };
    });
  }, [allStockItems, inventoryMap]);

  const filteredItems = useMemo(() => {
    if (searchTerm.length === 0) return itemsWithStock;
    return itemsWithStock.filter((item) => searchAny(searchTerm, item.name, item.code));
  }, [itemsWithStock, searchTerm]);

  useEffect(() => {
    setHighlightedIndex(0);
  }, [searchTerm, selectedLocationId]);

  useEffect(() => {
    const list = itemListRef.current;
    if (!list) return;
    const highlighted = list.querySelector(`[data-index="${highlightedIndex}"]`) as HTMLElement | null;
    if (!highlighted) return;
    const itemTop = highlighted.offsetTop;
    const itemBottom = itemTop + highlighted.offsetHeight;
    const visibleTop = list.scrollTop;
    const visibleBottom = visibleTop + list.clientHeight;
    if (itemTop < visibleTop) list.scrollTop = itemTop;
    else if (itemBottom > visibleBottom) list.scrollTop = itemBottom - list.clientHeight;
  }, [highlightedIndex]);

  const createCreditNoteMutation = useMutation({
    mutationFn: async (data: {
      noteType: string;
      voucherDate: string;
      cashAccountId: number;
      cashAccountType: string;
      description: string;
      items: Array<{
        stockItemId: number;
        locationId: number;
        quantity: string;
        refundRate: string;
        inventoryCost: string;
      }>;
    }) => {
      const response = await apiRequest("POST", "/api/credit-notes", data);
      return response.json();
    },
    onSuccess: (data) => {
      toast({ title: "Success", description: data.message || "Credit/Debit note created successfully" });
      resetForm();
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/locations", selectedLocationId, "inventory"] });
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({
        title: "Error",
        description: error.message || "Failed to create credit/debit note",
        variant: "destructive",
      });
    },
  });

  const updateCreditNoteMutation = useMutation({
    mutationFn: async (data: {
      voucherDate: string;
      cashAccountId: number;
      cashAccountType: string;
      description: string;
      items: Array<{
        stockItemId: number;
        locationId: number;
        quantity: string;
        refundRate: string;
        inventoryCost: string;
      }>;
    }) => {
      const response = await apiRequest("PATCH", `/api/credit-notes/${editingVoucherId}`, data);
      return response.json();
    },
    onSuccess: (data) => {
      toast({ title: "Success", description: data.message || "Credit/Debit note updated successfully" });
      resetForm();
      window.history.pushState({}, "", "/vouchers?tab=credit-note");
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/locations", selectedLocationId, "inventory"] });
      queryClient.invalidateQueries({ queryKey: ["/api/credit-notes", editingVoucherId] });
    },
    onError: (error: ClientErrorLike) => {
      if (error?._handledGlobally) return;
      toast({
        title: "Error",
        description: error.message || "Failed to update credit/debit note",
        variant: "destructive",
      });
    },
  });

  const resetForm = () => {
    form.reset({
      noteType: "Credit Note",
      voucherDate: format(new Date(), "yyyy-MM-dd"),
      cashAccountType: "",
      cashAccountId: 0,
      cashAccountName: "",
      description: "",
    });
    setItems([]);
    setItemQuantity("1");
    setRefundRate("");
    setSearchTerm("");
    setIsEditMode(false);
    setEditingVoucherId(null);
  };

  const addItemToCart = useCallback(
    (item: (typeof itemsWithStock)[0]) => {
      if (!selectedLocationId) {
        toast({ title: "No location selected", description: "Please select a location first", variant: "destructive" });
        return;
      }
      const qty = parseFloat(itemQuantity);
      const rate = parseFloat(refundRate) || item.avgRate;
      if (isNaN(qty) || qty <= 0) {
        toast({ title: "Invalid quantity", description: "Please enter a valid quantity", variant: "destructive" });
        return;
      }
      const location = locations.find((candidate) => candidate.id === selectedLocationId);
      if (!location) return;
      setItems((previous) => [
        ...previous,
        {
          rowKey: nextCreditNoteRowKey(`item-${item.id}-${selectedLocationId}`),
          stockItemId: item.id,
          stockItemName: item.name,
          locationId: selectedLocationId,
          locationName: location.name,
          quantity: qty.toString(),
          refundRate: rate.toFixed(2),
          inventoryCost: item.avgRate.toFixed(2),
          uom: item.uom,
        },
      ]);
      setItemQuantity("1");
      setRefundRate("");
      searchInputRef.current?.focus();
    },
    [itemQuantity, locations, refundRate, selectedLocationId, toast]
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (filteredItems.length === 0) return;
      const target = event.target;
      const isEditable =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable);
      if (isEditable && target !== searchInputRef.current) return;

      if (event.key === "ArrowDown") {
        event.preventDefault();
        setHighlightedIndex((previous) => (previous < filteredItems.length - 1 ? previous + 1 : 0));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setHighlightedIndex((previous) => (previous > 0 ? previous - 1 : filteredItems.length - 1));
      } else if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        const selectedItem = filteredItems[highlightedIndex];
        if (selectedItem) addItemToCart(selectedItem);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [addItemToCart, filteredItems, highlightedIndex]);

  const removeItem = (index: number) => setItems((previous) => previous.filter((_, itemIndex) => itemIndex !== index));
  const updateItemInventoryCost = (index: number, newCost: string) =>
    setItems((previous) =>
      previous.map((item, itemIndex) => (itemIndex === index ? { ...item, inventoryCost: newCost } : item))
    );

  const totalRefund = items.reduce((sum, item) => sum + parseFloat(item.quantity) * parseFloat(item.refundRate), 0);
  const totalInventoryValue = items.reduce(
    (sum, item) => sum + parseFloat(item.quantity) * parseFloat(item.inventoryCost),
    0
  );

  const onSubmit = (values: CreditNoteFormData) => {
    if (items.length === 0) {
      toast({ title: "No items", description: "Please add at least one item", variant: "destructive" });
      return;
    }
    const payload = {
      voucherDate: values.voucherDate,
      cashAccountId: values.cashAccountId,
      cashAccountType: values.cashAccountType,
      description: values.description || "",
      items: items.map((item) => ({
        stockItemId: item.stockItemId,
        locationId: item.locationId,
        quantity: item.quantity,
        refundRate: item.refundRate,
        inventoryCost: item.inventoryCost,
      })),
    };
    if (isEditMode && editingVoucherId) updateCreditNoteMutation.mutate(payload);
    else createCreditNoteMutation.mutate({ ...payload, noteType: values.noteType });
  };

  const noteType = form.watch("noteType");
  const cashAccountId = form.watch("cashAccountId");
  const cashAccountType = form.watch("cashAccountType");
  const cashAccountName = form.watch("cashAccountName");
  const isPending = createCreditNoteMutation.isPending || updateCreditNoteMutation.isPending;

  if (editLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-muted-foreground">Loading credit note...</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col lg:flex-row gap-4 lg:h-[calc(100vh-200px)]">
      <Card className="flex-1 flex flex-col">
        <CardHeader className="pb-3 flex-shrink-0">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <CardTitle className="flex items-center gap-2">
              {isEditMode ? (
                <>
                  <Pencil className="h-5 w-5" />
                  Edit {noteType}
                </>
              ) : (
                <>
                  <Package className="h-5 w-5" />
                  {noteType === "Credit Note" ? "Credit Note (Customer Return)" : "Debit Note"}
                </>
              )}
            </CardTitle>
            {/* Phones save from the pinned action bar at the bottom of the tab. */}
            <div className="hidden w-full flex-wrap gap-2 sm:flex sm:w-auto">
              {isEditMode && (
                <Button type="button" variant="outline" onClick={resetForm} data-testid="button-cancel-edit">
                  Cancel
                </Button>
              )}
              <Button
                type="button"
                onClick={form.handleSubmit(onSubmit)}
                disabled={items.length === 0 || isPending}
                data-testid="button-create-credit-note"
              >
                <Plus className="h-4 w-4 mr-1" />
                {isPending ? "Saving..." : isEditMode ? "Update Note" : "Create Note"}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="flex-1 overflow-auto">
          <Form {...form}>
            <form className="space-y-4" noValidate>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <FormField
                  control={form.control}
                  name="noteType"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Type</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value} disabled={isEditMode}>
                        <FormControl>
                          <SelectTrigger data-testid="select-note-type">
                            <SelectValue placeholder="Select type" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="Credit Note">Credit Note</SelectItem>
                          <SelectItem value="Debit Note">Debit Note</SelectItem>
                        </SelectContent>
                      </Select>
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="voucherDate"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Date</FormLabel>
                      <FormControl>
                        <Input
                          type="date"
                          value={field.value || ""}
                          onChange={(event) => field.onChange(event.target.value)}
                          data-testid="input-credit-note-date"
                        />
                      </FormControl>
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="cashAccountId"
                  render={() => (
                    <FormItem className="sm:col-span-2">
                      <FormLabel>{noteType === "Credit Note" ? "Refund From (Cash/Bank)" : "Receive Into"}</FormLabel>
                      <FormControl>
                        <AccountAutocomplete
                          value={
                            cashAccountId > 0
                              ? { type: cashAccountType, id: cashAccountId, name: cashAccountName || "" }
                              : null
                          }
                          onChange={(type, id, name) => {
                            form.setValue("cashAccountType", type);
                            form.setValue("cashAccountId", id);
                            form.setValue("cashAccountName", name);
                          }}
                          allAccounts={allAccounts}
                          rowIndex={-1}
                          placeholder="Select cash/bank account..."
                          testId="input-credit-note-account"
                        />
                      </FormControl>
                    </FormItem>
                  )}
                />
              </div>

              {items.length > 0 && (
                <Card>
                  <CardContent className="p-0">
                    <Table mobileLayout="cards">
                      <TableHeader>
                        <TableRow>
                          <TableHead>Item</TableHead>
                          <TableHead>Location</TableHead>
                          <TableHead className="text-right">Qty</TableHead>
                          <TableHead className="text-right">Refund Rate</TableHead>
                          <TableHead className="text-right">Refund Amt</TableHead>
                          <TableHead className="text-right">Inv. Cost</TableHead>
                          <TableHead className="text-right">Inv. Value</TableHead>
                          <TableHead></TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {items.map((item, index) => {
                          const qty = parseFloat(item.quantity);
                          const refundAmt = qty * parseFloat(item.refundRate);
                          const invValue = qty * parseFloat(item.inventoryCost);
                          return (
                            <TableRow key={item.rowKey} data-testid={`credit-note-item-${index}`}>
                              <TableCell className="font-medium">{item.stockItemName}</TableCell>
                              <TableCell>{item.locationName}</TableCell>
                              <TableCell className="text-right font-mono">
                                {formatNumber(qty, 0)} {item.uom}
                              </TableCell>
                              <TableCell className="text-right font-mono">
                                {formatNumber(parseFloat(item.refundRate))}
                              </TableCell>
                              <TableCell className="text-right font-mono text-primary">
                                {formatNumber(refundAmt)}
                              </TableCell>
                              <TableCell className="text-right">
                                <Input
                                  type="number"
                                  step="0.01"
                                  value={item.inventoryCost}
                                  onChange={(event) => updateItemInventoryCost(index, event.target.value)}
                                  className="w-20 h-8 text-right font-mono text-sm"
                                  data-testid={`input-inv-cost-${index}`}
                                />
                              </TableCell>
                              <TableCell className="text-right font-mono text-muted-foreground">
                                {formatNumber(invValue)}
                              </TableCell>
                              <TableCell>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => removeItem(index)}
                                  data-testid={`button-remove-item-${index}`}
                                >
                                  <Trash2 className="h-4 w-4 text-destructive" />
                                </Button>
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>
              )}

              <FormField
                control={form.control}
                name="description"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Notes</FormLabel>
                    <FormControl>
                      <Textarea
                        {...field}
                        placeholder="Enter notes..."
                        className="resize-none"
                        rows={2}
                        data-testid="input-credit-note-description"
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
              <div className="flex flex-wrap justify-between items-center pt-4 border-t gap-2">
                <div className="space-y-1">
                  <div className="text-lg font-semibold">
                    Refund Total: <span className="font-mono text-primary">{formatNumber(totalRefund)}</span>
                  </div>
                  <div className="text-sm text-muted-foreground">
                    Inventory Value: <span className="font-mono">{formatNumber(totalInventoryValue)}</span>
                    {Math.abs(totalRefund - totalInventoryValue) > 0.01 && (
                      <span className="ml-2">(Variance: {formatNumber(totalRefund - totalInventoryValue)})</span>
                    )}
                  </div>
                </div>
              </div>
            </form>
          </Form>
        </CardContent>
      </Card>

      <Card className="w-full lg:w-80 flex flex-col">
        <CardHeader className="pb-3 flex-shrink-0">
          <div className="flex items-center gap-2 mb-3">
            <MapPin className="h-4 w-4" />
            <span className="font-medium text-sm">Location</span>
          </div>
          <Select
            value={selectedLocationId?.toString() || ""}
            onValueChange={(value) => {
              setSelectedLocationId(parseInt(value));
              setSearchTerm("");
              setHighlightedIndex(0);
            }}
          >
            <SelectTrigger data-testid="select-location">
              <SelectValue placeholder="Choose location..." />
            </SelectTrigger>
            <SelectContent>
              {locations.map((location) => (
                <SelectItem key={location.id} value={location.id.toString()}>
                  {location.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="mt-3">
            <div className="relative">
              <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                ref={searchInputRef}
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                placeholder="Search items..."
                className="pl-8"
                data-testid="input-search-item"
              />
            </div>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Qty</label>
              <Input
                type="number"
                step="1"
                value={itemQuantity}
                onChange={(event) => setItemQuantity(event.target.value)}
                placeholder="1"
                data-testid="input-item-quantity"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Refund Rate</label>
              <Input
                type="number"
                step="0.01"
                value={refundRate}
                onChange={(event) => setRefundRate(event.target.value)}
                placeholder="Auto"
                data-testid="input-refund-rate"
              />
            </div>
          </div>
        </CardHeader>
        {/* Phones bound the item picker so a long catalogue does not push the voucher away. */}
        <CardContent className="flex-1 overflow-hidden p-0 max-sm:h-[min(60dvh,28rem)] max-sm:flex-none">
          <ScrollArea className="h-full">
            <div ref={itemListRef} className="p-2 space-y-1">
              {filteredItems.length === 0 ? (
                <div className="text-center py-4 text-muted-foreground text-sm">
                  {searchTerm ? "No items match your search" : "No stock items found"}
                </div>
              ) : (
                filteredItems.map((item, index) => {
                  const isHighlighted = index === highlightedIndex;
                  return (
                    <div
                      key={item.id}
                      data-index={index}
                      className={cn(
                        "p-3 rounded-md cursor-pointer border transition-colors",
                        isHighlighted ? "bg-primary/10 border-primary" : "hover:bg-accent border-transparent"
                      )}
                      onClick={() => addItemToCart(item)}
                      data-testid={`item-${item.id}`}
                    >
                      <div className="flex justify-between items-start">
                        <div className="flex-1 min-w-0">
                          <p className="font-medium truncate text-sm">{item.name}</p>
                          <p className="text-xs text-muted-foreground">{item.code}</p>
                        </div>
                        <Badge variant={item.stockQty > 0 ? "default" : "secondary"} className="ml-2 shrink-0">
                          {formatNumber(item.stockQty, 0)} {item.uom}
                        </Badge>
                      </div>
                      {item.avgRate > 0 && (
                        <div className="mt-1 text-xs text-muted-foreground">Avg Cost: {formatNumber(item.avgRate)}</div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>

      <VoucherPhoneActionBar
        summary={`${items.length} items · Refund ${formatNumber(totalRefund)}`}
        saveLabel={isEditMode ? "Update Note" : "Create Note"}
        saving={isPending}
        disabled={items.length === 0}
        onSave={form.handleSubmit(onSubmit)}
        onCancel={isEditMode ? resetForm : undefined}
        data-testid="credit-note-phone-actions"
      />
    </div>
  );
}
