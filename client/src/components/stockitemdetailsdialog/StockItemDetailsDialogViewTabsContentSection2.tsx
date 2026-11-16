// Extracted from ./StockItemDetailsDialogView.tsx to keep that module under the source-size cap.
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TabsContent } from "@/components/ui/tabs";
import { Edit, Save, X } from "lucide-react";
import { useStockItemDetailsDialogViewState } from "./useStockItemDetailsDialogViewState";

export function StockItemDetailsDialogViewTabsContentSection2({
  editedCategoryId,
  editedCode,
  editedName,
  editedStockGroupId,
  editedUom,
  handleEditDetails,
  handleSaveDetails,
  isEditingDetails,
  loadingItem,
  setEditedCategoryId,
  setEditedCode,
  setEditedName,
  setEditedStockGroupId,
  setEditedUom,
  setIsEditingDetails,
  stockCategories,
  stockGroups,
  stockItem,
  updateItemMutation,
}: Pick<
  ReturnType<typeof useStockItemDetailsDialogViewState>,
  | "editedCategoryId"
  | "editedCode"
  | "editedName"
  | "editedStockGroupId"
  | "editedUom"
  | "handleEditDetails"
  | "handleSaveDetails"
  | "isEditingDetails"
  | "loadingItem"
  | "setEditedCategoryId"
  | "setEditedCode"
  | "setEditedName"
  | "setEditedStockGroupId"
  | "setEditedUom"
  | "setIsEditingDetails"
  | "stockCategories"
  | "stockGroups"
  | "stockItem"
  | "updateItemMutation"
>) {
  return (
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
  );
}
