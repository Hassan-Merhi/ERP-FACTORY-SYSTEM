import { DeleteConfirmDialog } from "@/components/ConfirmationDialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EmptyState, LoadingState } from "@/components/ui/page-state";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Package, Plus, Trash2 } from "lucide-react";
import {
  useStockItemDetailsDialogViewState,
  type StockItemDetailsDialogModel,
} from "./useStockItemDetailsDialogViewState";
import { StockItemDetailsDialogViewTabsContentSection } from "./StockItemDetailsDialogViewTabsContentSection";
import { StockItemDetailsDialogViewTabsContentSection2 } from "./StockItemDetailsDialogViewTabsContentSection2";
import { StockItemDetailsDialogViewTabsContent } from "./StockItemDetailsDialogViewTabsContent";

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
                  <LoadingState className="py-4" />
                ) : codeAliases.length === 0 ? (
                  <EmptyState title="No code aliases added yet" className="py-4" />
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

            <StockItemDetailsDialogViewTabsContent
              allStockItems={allStockItems}
              editedQuantity={editedQuantity}
              editedRate={editedRate}
              editedStockItemId={editedStockItemId}
              editingTransaction={editingTransaction}
              handleCancelTransactionEdit={handleCancelTransactionEdit}
              handleEditTransaction={handleEditTransaction}
              handleSaveTransaction={handleSaveTransaction}
              loadingTransactions={loadingTransactions}
              navigate={navigate}
              setEditedQuantity={setEditedQuantity}
              setEditedRate={setEditedRate}
              setEditedStockItemId={setEditedStockItemId}
              transactions={transactions}
              updateTransactionMutation={updateTransactionMutation}
            />
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
