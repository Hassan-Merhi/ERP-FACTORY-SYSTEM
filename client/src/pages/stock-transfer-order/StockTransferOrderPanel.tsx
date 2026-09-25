import { useErpPhoneLayout } from "@/hooks/use-erp-phone-layout";
import { VoucherPhoneActionBar, useVoucherEditCancel } from "@/pages/vouchers/VoucherPhoneActionBar";
import { searchAny } from "@shared/searchNormalization";
import { ArrowRight, Check, GitBranch, Package, Plus, Search, Trash2, Upload } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { formatNumber } from "@/lib/formatNumber";
import type { useStockTransferOrderModel } from "./useStockTransferOrderModel";

type Model = ReturnType<typeof useStockTransferOrderModel>;

export function StockTransferOrderPanel({ model }: { model: Model }) {
  const {
    mobileSheetOpen,
    setMobileSheetOpen,
    mobileSearchTerm,
    setMobileSearchTerm,
    stockItems,
    mobileSelectedItemId,
    setMobileSelectedItemId,
    selectedLocations,
    mobileSourceLocationId,
    setMobileSourceLocationId,
    mobileQty,
    setMobileQty,
    handleMobileAddItem,
    destinationLocationId,
    locations,
    orderItems,
    totalBales,
    setImportPreview,
    setImportDialogOpen,
    removeFromOrder,
    editVoucherId,
    autosaveStatus,
    handleValidate,
    handleProcessOrder,
    isProcessing,
    existingTransfer,
    handleSaveAsRevision,
    isSavingRevision,
  } = model;
  const isPhone = useErpPhoneLayout();
  const cancelEdit = useVoucherEditCancel(!!editVoucherId);
  const processLabel = editVoucherId ? "Update Order" : "Process";

  return (
    <div className="min-w-0 flex-1 flex flex-col gap-4">
      <div className="lg:hidden">
        <Sheet open={mobileSheetOpen} onOpenChange={setMobileSheetOpen}>
          <Button className="w-full" onClick={() => setMobileSheetOpen(true)} data-testid="button-mobile-add-item">
            <Plus className="h-4 w-4 mr-2" />
            Add Item
          </Button>
          <SheetContent side="bottom" className="h-[85vh] flex flex-col">
            <SheetHeader className="border-b pb-3 shrink-0">
              <SheetTitle>Add Item to Order</SheetTitle>
            </SheetHeader>
            <div className="flex-1 overflow-y-auto py-4 space-y-4">
              <div className="space-y-2">
                <Label className="text-sm font-medium">Stock Item</Label>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    className="pl-9"
                    placeholder="Search stock items..."
                    value={mobileSearchTerm}
                    onChange={(event) => setMobileSearchTerm(event.target.value)}
                    data-testid="input-mobile-search"
                  />
                </div>
                <ScrollArea className="h-48 border rounded-md">
                  <div className="p-1 space-y-0.5">
                    {stockItems
                      .filter(
                        (item) => mobileSearchTerm.trim() === "" || searchAny(mobileSearchTerm, item.name, item.code)
                      )
                      .map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          className={cn(
                            "w-full text-left px-3 py-2 rounded-md text-sm transition-colors",
                            mobileSelectedItemId === item.id ? "bg-primary text-primary-foreground" : "hover:bg-muted"
                          )}
                          onClick={() => setMobileSelectedItemId(item.id)}
                          data-testid={`mobile-item-option-${item.id}`}
                        >
                          <span className="font-medium">{item.name}</span>
                          <span className="ml-2 text-xs opacity-70">{item.code}</span>
                        </button>
                      ))}
                  </div>
                </ScrollArea>
              </div>

              <div className="space-y-2">
                <Label className="text-sm font-medium">Source Location</Label>
                {selectedLocations.length === 0 ? (
                  <div className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
                    No source locations selected. Close this sheet and tap "Source Locations" to add some.
                  </div>
                ) : (
                  <Select
                    value={mobileSourceLocationId?.toString() || ""}
                    onValueChange={(value) => setMobileSourceLocationId(parseInt(value))}
                  >
                    <SelectTrigger data-testid="select-mobile-source">
                      <SelectValue placeholder="Pick source location" />
                    </SelectTrigger>
                    <SelectContent>
                      {selectedLocations.map((location) => (
                        <SelectItem
                          key={location.id}
                          value={location.id.toString()}
                          data-testid={`mobile-source-option-${location.id}`}
                        >
                          {location.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>

              <div className="space-y-2">
                <Label className="text-sm font-medium">Quantity</Label>
                <Input
                  type="number"
                  step="0.001"
                  min="0"
                  placeholder="0"
                  value={mobileQty}
                  onChange={(event) => setMobileQty(event.target.value)}
                  className="font-mono"
                  data-testid="input-mobile-qty"
                />
              </div>
            </div>
            <SheetFooter className="border-t pt-3 shrink-0">
              <Button className="w-full" onClick={handleMobileAddItem} data-testid="button-mobile-confirm-add">
                <Plus className="h-4 w-4 mr-2" />
                Add to Order
              </Button>
            </SheetFooter>
          </SheetContent>
        </Sheet>
      </div>

      {destinationLocationId && (
        <Card className="bg-primary/5 border-primary/20">
          <CardContent className="py-3">
            <div className="flex items-center gap-2 text-sm">
              <ArrowRight className="h-4 w-4 text-primary" />
              <span className="text-muted-foreground">Sending to:</span>
              <span className="font-medium">
                {locations.find((location) => location.id === destinationLocationId)?.name}
              </span>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-base">Transfer Order</CardTitle>
            <div className="flex items-center gap-2">
              <Badge variant="secondary">{orderItems.length} items</Badge>
              <Badge variant="default" className="font-mono">
                {formatNumber(totalBales, 0)} bales
              </Badge>
              <Button
                size="icon"
                variant="outline"
                onClick={() => {
                  setImportPreview([]);
                  setImportDialogOpen(true);
                }}
                data-testid="button-open-import"
                title="Import from Excel"
              >
                <Upload className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {orderItems.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Package className="w-8 h-8 mx-auto mb-2 opacity-50" />
              <p className="text-sm hidden lg:block">Click on quantities or use arrow keys + spacebar to add items</p>
              <p className="text-sm lg:hidden">Tap "Add Item" above to add items to the order</p>
            </div>
          ) : (
            <>
              <ScrollArea className="h-[300px]">
                <div className="space-y-2">
                  {orderItems.map((item, index) => (
                    <div
                      key={`${item.stockItemId}-${item.sourceLocationId}`}
                      className="flex items-center justify-between gap-2 p-2 rounded-md bg-muted/50"
                      data-testid={`order-item-${index}`}
                    >
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{item.stockItemName}</p>
                        <p className="text-xs text-muted-foreground">
                          From: {item.sourceLocationName} | {formatNumber(item.quantity, 0)} {item.uom}
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => removeFromOrder(index)}
                        data-testid={`button-remove-order-item-${index}`}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  ))}
                </div>
              </ScrollArea>

              <div className="pt-2 border-t space-y-3">
                <div className="flex justify-between text-sm font-medium">
                  <span>Total Bales:</span>
                  <span className="font-mono text-lg">{formatNumber(totalBales, 0)}</span>
                </div>

                {!editVoucherId && autosaveStatus !== "idle" && (
                  <p
                    className={`text-xs text-center ${
                      autosaveStatus === "saved"
                        ? "text-green-600 dark:text-green-400"
                        : autosaveStatus === "failed"
                          ? "text-destructive"
                          : "text-muted-foreground"
                    }`}
                    data-testid="text-autosave-status"
                  >
                    {autosaveStatus === "saving"
                      ? "Saving draft..."
                      : autosaveStatus === "saved"
                        ? "Draft saved"
                        : "Draft save failed"}
                  </p>
                )}

                {!isPhone && (
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleValidate}
                      className="flex-1"
                      data-testid="button-validate-order"
                    >
                      <Check className="h-4 w-4 mr-1" />
                      Validate
                    </Button>
                    <Button
                      size="sm"
                      onClick={handleProcessOrder}
                      disabled={isProcessing || !destinationLocationId}
                      className="flex-1"
                      data-testid="button-process-order"
                    >
                      {isProcessing
                        ? editVoucherId
                          ? "Updating..."
                          : "Processing..."
                        : editVoucherId
                          ? "Update Order"
                          : "Process"}
                    </Button>
                  </div>
                )}

                {!isPhone && editVoucherId && existingTransfer?.id && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleSaveAsRevision}
                    disabled={isSavingRevision || !destinationLocationId}
                    className="w-full"
                    data-testid="button-save-as-revision"
                  >
                    <GitBranch className="h-4 w-4 mr-1" />
                    Save as Revision
                  </Button>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {orderItems.length > 0 && (
        <VoucherPhoneActionBar
          summary={`${orderItems.length} items · ${totalBales} bales`}
          saveLabel={processLabel}
          savingLabel={editVoucherId ? "Updating..." : "Processing..."}
          saving={isProcessing}
          disabled={!destinationLocationId}
          onSave={handleProcessOrder}
          onCancel={cancelEdit}
          extra={
            <>
              <Button variant="outline" onClick={handleValidate} data-testid="button-validate-order">
                <Check className="h-4 w-4 mr-1" />
                Validate
              </Button>
              {editVoucherId && existingTransfer?.id && (
                <Button
                  variant="outline"
                  onClick={handleSaveAsRevision}
                  disabled={isSavingRevision || !destinationLocationId}
                  data-testid="button-save-as-revision"
                >
                  <GitBranch className="h-4 w-4 mr-1" />
                  Revision
                </Button>
              )}
            </>
          }
          data-testid="transfer-order-phone-actions"
        />
      )}
    </div>
  );
}
