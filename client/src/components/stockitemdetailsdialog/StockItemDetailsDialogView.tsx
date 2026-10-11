import { DeleteConfirmDialog } from "@/components/ConfirmationDialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatNumber } from "@/lib/formatNumber";
import { Edit, ExternalLink, Package, Plus, Save, Trash2, X } from "lucide-react";

import type { useStockItemDetailsDialog } from "./useStockItemDetailsDialog";

type StockItemDetailsDialogModel = ReturnType<typeof useStockItemDetailsDialog>;

export function StockItemDetailsDialogView({ dialog }: { dialog: StockItemDetailsDialogModel }) {
  const {
    open,
    onOpenChange,
    stockItemName,
    toast,
    navigate,
    isEditingDetails,
    setIsEditingDetails,
    editedCode,
    setEditedCode,
    editedName,
    setEditedName,
    editedUom,
    setEditedUom,
    editedStockGroupId,
    setEditedStockGroupId,
    editedCategoryId,
    setEditedCategoryId,
    editingTransaction,
    editedStockItemId,
    setEditedStockItemId,
    editedQuantity,
    setEditedQuantity,
    editedRate,
    setEditedRate,
    newAliasCode,
    setNewAliasCode,
    newAliasDescription,
    setNewAliasDescription,
    newLocationId,
    setNewLocationId,
    newLocationPrice,
    setNewLocationPrice,
    editingLocationPriceId,
    setEditingLocationPriceId,
    stockItem,
    loadingItem,
    stockGroups,
    stockCategories,
    allStockItems,
    transactions,
    loadingTransactions,
    codeAliases,
    loadingAliases,
    locations,
    locationPrices,
    loadingLocationPrices,
    updateItemMutation,
    updateTransactionMutation,
    createAliasMutation,
    deleteAliasMutation,
    upsertLocationPriceMutation,
    deleteLocationPriceMutation,
    handleEditDetails,
    handleSaveDetails,
    handleEditTransaction,
    handleSaveTransaction,
    handleCancelTransactionEdit,
    handleAddAlias,
    pendingDelete,
    setPendingDelete,
    handleDeleteAlias,
  } = dialog;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Package className="h-5 w-5" />
              {stockItemName}
            </DialogTitle>
          </DialogHeader>

          <Tabs defaultValue="details" className="w-full">
            <TabsList className="grid w-full grid-cols-4">
              <TabsTrigger value="details" data-testid="tab-details">
                Item Details
              </TabsTrigger>
              <TabsTrigger value="prices" data-testid="tab-location-prices">
                Location Prices
              </TabsTrigger>
              <TabsTrigger value="aliases" data-testid="tab-aliases">
                Code Aliases
              </TabsTrigger>
              <TabsTrigger value="transactions" data-testid="tab-transactions">
                Voucher History
              </TabsTrigger>
            </TabsList>

            <TabsContent value="details" className="space-y-4 mt-4">
              <div className="border-b pb-6">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-lg font-semibold">Item Details</h3>
                  {!isEditingDetails ? (
                    <Button onClick={handleEditDetails} variant="outline" size="sm" data-testid="button-edit-details">
                      <Edit className="h-4 w-4 mr-2" />
                      Edit
                    </Button>
                  ) : (
                    <div className="flex gap-2">
                      <Button
                        onClick={handleSaveDetails}
                        size="sm"
                        disabled={updateItemMutation.isPending}
                        data-testid="button-save-details"
                      >
                        <Save className="h-4 w-4 mr-2" />
                        Save
                      </Button>
                      <Button
                        onClick={() => setIsEditingDetails(false)}
                        variant="outline"
                        size="sm"
                        disabled={updateItemMutation.isPending}
                        data-testid="button-cancel-details"
                      >
                        <X className="h-4 w-4 mr-2" />
                        Cancel
                      </Button>
                    </div>
                  )}
                </div>

                {loadingItem ? (
                  <div className="flex items-center justify-center py-8">
                    <p className="text-muted-foreground">Loading...</p>
                  </div>
                ) : stockItem ? (
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="code">Code</Label>
                      {isEditingDetails ? (
                        <Input
                          id="code"
                          value={editedCode}
                          onChange={(e) => setEditedCode(e.target.value)}
                          data-testid="input-code"
                        />
                      ) : (
                        <p className="text-sm font-mono p-2 bg-muted rounded-sm" data-testid="text-code">
                          {stockItem.code}
                        </p>
                      )}
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="name">Name</Label>
                      {isEditingDetails ? (
                        <Input
                          id="name"
                          value={editedName}
                          onChange={(e) => setEditedName(e.target.value)}
                          data-testid="input-name"
                        />
                      ) : (
                        <p className="text-sm p-2 bg-muted rounded-sm" data-testid="text-name">
                          {stockItem.name}
                        </p>
                      )}
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="uom">Unit of Measure</Label>
                      {isEditingDetails ? (
                        <Input
                          id="uom"
                          value={editedUom}
                          onChange={(e) => setEditedUom(e.target.value)}
                          data-testid="input-uom"
                        />
                      ) : (
                        <p className="text-sm p-2 bg-muted rounded-sm" data-testid="text-uom">
                          {stockItem.uom}
                        </p>
                      )}
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="stockGroup">Stock Group</Label>
                      {isEditingDetails ? (
                        <Select
                          value={editedStockGroupId?.toString() || ""}
                          onValueChange={(value) => setEditedStockGroupId(value ? parseInt(value) : null)}
                        >
                          <SelectTrigger data-testid="select-stock-group">
                            <SelectValue placeholder="Select stock group" />
                          </SelectTrigger>
                          <SelectContent>
                            {stockGroups.map((group) => (
                              <SelectItem key={group.id} value={group.id.toString()}>
                                {group.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <p className="text-sm p-2 bg-muted rounded-sm" data-testid="text-stock-group">
                          {stockGroups.find((g) => g.id === stockItem.stockGroupId)?.name || "Uncategorized"}
                        </p>
                      )}
                    </div>

                    {stockCategories.length > 0 && (
                      <div className="space-y-2">
                        <Label htmlFor="category">Category</Label>
                        {isEditingDetails ? (
                          <Select
                            value={editedCategoryId?.toString() || "none"}
                            onValueChange={(value) => setEditedCategoryId(value === "none" ? null : parseInt(value))}
                          >
                            <SelectTrigger data-testid="select-category">
                              <SelectValue placeholder="Select category" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="none">— No Category —</SelectItem>
                              {stockCategories.map((cat) => (
                                <SelectItem key={cat.id} value={cat.id.toString()}>
                                  {cat.name}
                                  {!cat.active ? " (inactive)" : ""}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <p className="text-sm p-2 bg-muted rounded-sm" data-testid="text-category">
                            {stockCategories.find((c) => c.id === stockItem.categoryId)?.name || "—"}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            </TabsContent>

            <TabsContent value="prices" className="space-y-4 mt-4">
              <h3 className="text-lg font-semibold mb-4" data-testid="tab-location-prices">
                Location Prices
              </h3>
              <div className="space-y-4">
                <Card className="p-4">
                  <h4 className="font-medium mb-3">Add Location Price</h4>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="locationSelect">Location *</Label>
                      <Select value={newLocationId} onValueChange={setNewLocationId}>
                        <SelectTrigger data-testid="select-location-price">
                          <SelectValue placeholder="Select location" />
                        </SelectTrigger>
                        <SelectContent>
                          {locations.map((loc) => (
                            <SelectItem key={loc.id} value={loc.id.toString()}>
                              {loc.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="locationPrice">Selling Price *</Label>
                      <Input
                        id="locationPrice"
                        type="number"
                        step="0.01"
                        value={newLocationPrice}
                        onChange={(e) => setNewLocationPrice(e.target.value)}
                        placeholder="0.00"
                        data-testid="input-location-price"
                      />
                    </div>
                  </div>
                  <div className="flex justify-end mt-4">
                    <Button
                      onClick={() => {
                        if (!newLocationId || !newLocationPrice) {
                          toast({
                            title: "Error",
                            description: "Please fill in all fields",
                            variant: "destructive",
                          });
                          return;
                        }
                        upsertLocationPriceMutation.mutate({
                          locationId: parseInt(newLocationId),
                          sellingPrice: newLocationPrice,
                        });
                      }}
                      size="sm"
                      data-testid="button-add-location-price"
                    >
                      <Plus className="h-4 w-4 mr-2" />
                      Add Price
                    </Button>
                  </div>
                </Card>

                {loadingLocationPrices ? (
                  <div className="text-center py-4 text-muted-foreground">Loading...</div>
                ) : locationPrices.length === 0 ? (
                  <div className="text-center py-4 text-muted-foreground">No location prices added yet</div>
                ) : (
                  <div className="space-y-2">
                    {locationPrices.map((price) => (
                      <Card key={price.id} className="p-3 flex items-center justify-between">
                        {editingLocationPriceId === price.id ? (
                          <>
                            <div className="flex-1">
                              <p className="text-sm font-medium">{price.locationName}</p>
                            </div>
                            <div className="flex items-center gap-2">
                              <Input
                                type="number"
                                step="0.01"
                                value={newLocationPrice}
                                onChange={(e) => setNewLocationPrice(e.target.value)}
                                className="w-24"
                                data-testid="input-edit-location-price"
                              />
                              <Button
                                size="sm"
                                onClick={() => {
                                  if (!newLocationPrice) {
                                    toast({
                                      title: "Error",
                                      description: "Please enter a price",
                                      variant: "destructive",
                                    });
                                    return;
                                  }
                                  upsertLocationPriceMutation.mutate({
                                    locationId: price.locationId,
                                    sellingPrice: newLocationPrice,
                                  });
                                }}
                                data-testid="button-save-location-price"
                              >
                                Save
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => {
                                  setEditingLocationPriceId(null);
                                  setNewLocationPrice("");
                                }}
                                data-testid="button-cancel-location-price"
                              >
                                Cancel
                              </Button>
                            </div>
                          </>
                        ) : (
                          <>
                            <div className="flex-1">
                              <p className="text-sm font-medium">{price.locationName}</p>
                              <p className="text-sm text-muted-foreground">{price.sellingPrice}</p>
                            </div>
                            <div className="flex items-center gap-2">
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => {
                                  setEditingLocationPriceId(price.id);
                                  setNewLocationPrice(price.sellingPrice);
                                }}
                                data-testid={`button-edit-location-price-${price.id}`}
                              >
                                <Edit className="h-4 w-4" />
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => deleteLocationPriceMutation.mutate(price.id)}
                                disabled={deleteLocationPriceMutation.isPending}
                                data-testid={`button-delete-location-price-${price.id}`}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                          </>
                        )}
                      </Card>
                    ))}
                  </div>
                )}
              </div>
            </TabsContent>

            <TabsContent value="aliases" className="space-y-4 mt-4">
              <h3 className="text-lg font-semibold mb-4" data-testid="tab-aliases">
                Code Aliases
              </h3>
              <div className="space-y-4">
                <Card className="p-4">
                  <h4 className="font-medium mb-3">Add Code Alias</h4>
                  <div className="space-y-3">
                    <div className="space-y-2">
                      <Label htmlFor="aliasCode">Alias Code *</Label>
                      <Input
                        id="aliasCode"
                        value={newAliasCode}
                        onChange={(e) => setNewAliasCode(e.target.value)}
                        placeholder="Enter alias code"
                        data-testid="input-alias-code"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="aliasDescription">Description</Label>
                      <Input
                        id="aliasDescription"
                        value={newAliasDescription}
                        onChange={(e) => setNewAliasDescription(e.target.value)}
                        placeholder="Optional description"
                        data-testid="input-alias-description"
                      />
                    </div>
                  </div>
                  <div className="flex justify-end mt-4">
                    <Button
                      onClick={handleAddAlias}
                      size="sm"
                      disabled={createAliasMutation.isPending}
                      data-testid="button-add-alias"
                    >
                      <Plus className="h-4 w-4 mr-2" />
                      Add Alias
                    </Button>
                  </div>
                </Card>

                {loadingAliases ? (
                  <div className="text-center py-4 text-muted-foreground">Loading...</div>
                ) : codeAliases.length === 0 ? (
                  <div className="text-center py-4 text-muted-foreground">No code aliases added yet</div>
                ) : (
                  <div className="space-y-2">
                    {codeAliases.map((alias) => (
                      <Card key={alias.id} className="p-3 flex items-center justify-between">
                        <div className="flex-1">
                          <p className="text-sm font-mono font-medium">{alias.aliasCode}</p>
                          {alias.description && <p className="text-sm text-muted-foreground">{alias.description}</p>}
                        </div>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => handleDeleteAlias(alias.id)}
                          disabled={deleteAliasMutation.isPending}
                          data-testid={`button-delete-alias-${alias.id}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </Card>
                    ))}
                  </div>
                )}
              </div>
            </TabsContent>

            <TabsContent value="transactions" className="space-y-4 mt-4">
              <h3 className="text-lg font-semibold mb-4" data-testid="tab-transactions">
                Voucher History
              </h3>
              {loadingTransactions ? (
                <div className="text-center py-8 text-muted-foreground">Loading...</div>
              ) : transactions.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">No transactions found</div>
              ) : (
                <div className="space-y-2 max-h-[400px] overflow-y-auto">
                  {transactions.map((transaction) => (
                    <Card key={transaction.id} className="p-3">
                      {editingTransaction === transaction.id ? (
                        <div className="space-y-3">
                          <div className="grid grid-cols-2 gap-4">
                            <div className="space-y-2">
                              <Label>Stock Item</Label>
                              <Select
                                value={editedStockItemId?.toString() || ""}
                                onValueChange={(value) => setEditedStockItemId(parseInt(value))}
                              >
                                <SelectTrigger data-testid="select-transaction-item">
                                  <SelectValue placeholder="Select item" />
                                </SelectTrigger>
                                <SelectContent>
                                  {allStockItems.map((item) => (
                                    <SelectItem key={item.id} value={item.id.toString()}>
                                      {item.code} - {item.name}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>
                            <div className="space-y-2">
                              <Label>Quantity</Label>
                              <Input
                                type="number"
                                step="0.001"
                                value={editedQuantity}
                                onChange={(e) => setEditedQuantity(e.target.value)}
                                data-testid="input-transaction-quantity"
                              />
                            </div>
                            <div className="space-y-2">
                              <Label>Rate</Label>
                              <Input
                                type="number"
                                step="0.01"
                                value={editedRate}
                                onChange={(e) => setEditedRate(e.target.value)}
                                data-testid="input-transaction-rate"
                              />
                            </div>
                          </div>
                          <div className="flex justify-end gap-2">
                            <Button
                              size="sm"
                              onClick={() => handleSaveTransaction(transaction)}
                              disabled={updateTransactionMutation.isPending}
                              data-testid="button-save-transaction"
                            >
                              Save
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={handleCancelTransactionEdit}
                              disabled={updateTransactionMutation.isPending}
                              data-testid="button-cancel-transaction"
                            >
                              Cancel
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-center justify-between">
                          <div className="flex-1">
                            <div className="flex items-center gap-2 mb-1">
                              <p className="text-sm font-mono font-medium">{transaction.voucherNumber}</p>
                              <span className="text-xs bg-muted px-2 py-1 rounded-sm">{transaction.type}</span>
                            </div>
                            <p className="text-xs text-muted-foreground">{transaction.voucherDate}</p>
                            <p className="text-sm mt-1">
                              Qty: {formatNumber(parseFloat(transaction.quantity))} @{" "}
                              {formatNumber(parseFloat(transaction.rate))}
                            </p>
                          </div>
                          <div className="flex items-center gap-2">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => handleEditTransaction(transaction)}
                              data-testid={`button-edit-transaction-${transaction.id}`}
                            >
                              <Edit className="h-4 w-4" />
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => navigate(`/vouchers/${transaction.voucherId}`)}
                              data-testid={`button-view-voucher-${transaction.id}`}
                            >
                              <ExternalLink className="h-4 w-4" />
                            </Button>
                          </div>
                        </div>
                      )}
                    </Card>
                  ))}
                </div>
              )}
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>
      <DeleteConfirmDialog
        open={!!pendingDelete}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setPendingDelete(null);
        }}
        onConfirm={() => {
          pendingDelete?.();
          setPendingDelete(null);
        }}
      />
    </>
  );
}
