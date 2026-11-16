import { DeleteConfirmDialog } from "@/components/ConfirmationDialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatNumber } from "@/lib/formatNumber";
import { Edit, ExternalLink, Package, Plus, Trash2 } from "lucide-react";
import {
  useStockItemDetailsDialogViewState,
  type StockItemDetailsDialogModel,
} from "./useStockItemDetailsDialogViewState";
import { StockItemDetailsDialogViewTabsContentSection } from "./StockItemDetailsDialogViewTabsContentSection";
import { StockItemDetailsDialogViewTabsContentSection2 } from "./StockItemDetailsDialogViewTabsContentSection2";

export function StockItemDetailsDialogView(props: { dialog: StockItemDetailsDialogModel }) {
  const {
    allStockItems,
    codeAliases,
    createAliasMutation,
    deleteAliasMutation,
    deleteLocationPriceMutation,
    editedCategoryId,
    editedCode,
    editedName,
    editedQuantity,
    editedRate,
    editedStockGroupId,
    editedStockItemId,
    editedUom,
    editingLocationPriceId,
    editingTransaction,
    handleAddAlias,
    handleCancelTransactionEdit,
    handleDeleteAlias,
    handleEditDetails,
    handleEditTransaction,
    handleSaveDetails,
    handleSaveTransaction,
    isEditingDetails,
    loadingAliases,
    loadingItem,
    loadingLocationPrices,
    loadingTransactions,
    locationPrices,
    locations,
    navigate,
    newAliasCode,
    newAliasDescription,
    newLocationId,
    newLocationPrice,
    onOpenChange,
    open,
    pendingDelete,
    setEditedCategoryId,
    setEditedCode,
    setEditedName,
    setEditedQuantity,
    setEditedRate,
    setEditedStockGroupId,
    setEditedStockItemId,
    setEditedUom,
    setEditingLocationPriceId,
    setIsEditingDetails,
    setNewAliasCode,
    setNewAliasDescription,
    setNewLocationId,
    setNewLocationPrice,
    setPendingDelete,
    stockCategories,
    stockGroups,
    stockItem,
    stockItemName,
    toast,
    transactions,
    updateItemMutation,
    updateTransactionMutation,
    upsertLocationPriceMutation,
  } = useStockItemDetailsDialogViewState(props);

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
            <div className="erp-mobile-scroll-tabs pb-1">
              <TabsList className="w-max min-w-full sm:min-w-0 sm:w-fit" aria-label="Dialog sections">
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
            </div>

            <StockItemDetailsDialogViewTabsContentSection2
              editedCategoryId={editedCategoryId}
              editedCode={editedCode}
              editedName={editedName}
              editedStockGroupId={editedStockGroupId}
              editedUom={editedUom}
              handleEditDetails={handleEditDetails}
              handleSaveDetails={handleSaveDetails}
              isEditingDetails={isEditingDetails}
              loadingItem={loadingItem}
              setEditedCategoryId={setEditedCategoryId}
              setEditedCode={setEditedCode}
              setEditedName={setEditedName}
              setEditedStockGroupId={setEditedStockGroupId}
              setEditedUom={setEditedUom}
              setIsEditingDetails={setIsEditingDetails}
              stockCategories={stockCategories}
              stockGroups={stockGroups}
              stockItem={stockItem}
              updateItemMutation={updateItemMutation}
            />

            <StockItemDetailsDialogViewTabsContentSection
              deleteLocationPriceMutation={deleteLocationPriceMutation}
              editingLocationPriceId={editingLocationPriceId}
              loadingLocationPrices={loadingLocationPrices}
              locationPrices={locationPrices}
              locations={locations}
              newLocationId={newLocationId}
              newLocationPrice={newLocationPrice}
              setEditingLocationPriceId={setEditingLocationPriceId}
              setNewLocationId={setNewLocationId}
              setNewLocationPrice={setNewLocationPrice}
              toast={toast}
              upsertLocationPriceMutation={upsertLocationPriceMutation}
            />

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
