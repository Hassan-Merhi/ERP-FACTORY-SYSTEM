// Extracted from ./StockItemDetailsDialogView.tsx to keep that module under the source-size cap.
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TabsContent } from "@/components/ui/tabs";
import { Edit, Plus, Trash2 } from "lucide-react";
import { useStockItemDetailsDialogViewState } from "./useStockItemDetailsDialogViewState";

export function StockItemDetailsDialogViewTabsContentSection({
  deleteLocationPriceMutation,
  editingLocationPriceId,
  loadingLocationPrices,
  locationPrices,
  locations,
  newLocationId,
  newLocationPrice,
  setEditingLocationPriceId,
  setNewLocationId,
  setNewLocationPrice,
  toast,
  upsertLocationPriceMutation,
}: Pick<
  ReturnType<typeof useStockItemDetailsDialogViewState>,
  | "deleteLocationPriceMutation"
  | "editingLocationPriceId"
  | "loadingLocationPrices"
  | "locationPrices"
  | "locations"
  | "newLocationId"
  | "newLocationPrice"
  | "setEditingLocationPriceId"
  | "setNewLocationId"
  | "setNewLocationPrice"
  | "toast"
  | "upsertLocationPriceMutation"
>) {
  return (
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
                    title: "Missing information",
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
                              title: "Missing information",
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
  );
}
