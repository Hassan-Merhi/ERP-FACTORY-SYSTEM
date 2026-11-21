import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Download, Package } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { StockNameUpdateImport } from "@/components/StockNameUpdateImport";
import { useCombinedImportDialogState, type CombinedImportDialogProps } from "./useCombinedImportDialogState";

export function CombinedImportDialog({ open, onOpenChange }: CombinedImportDialogProps) {
  const {
    pricesFile,
    openingFile,
    selectedLocation,
    setSelectedLocation,
    isProcessing,
    isProcessingOpening,
    newItemsImportHref,
    locations,
    downloadPricesTemplate,
    handlePricesFileChange,
    handleImportPrices,
    downloadOpeningTemplate,
    handleOpeningFileChange,
    handleImportOpening,
  } = useCombinedImportDialogState({ onOpenChange });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl" data-testid="dialog-combined-import">
        <DialogHeader>
          <DialogTitle>Import Data</DialogTitle>
          <DialogDescription>Choose what you'd like to import</DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="opening" className="w-full">
          <div className="erp-mobile-scroll-tabs pb-1">
            <TabsList className="w-max min-w-full sm:min-w-0 sm:w-fit" aria-label="Dialog sections">
              <TabsTrigger value="opening">Opening Stock</TabsTrigger>
              <TabsTrigger value="prices">Prices</TabsTrigger>
              <TabsTrigger value="items">Items / Names</TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="opening" className="space-y-4">
            <div className="space-y-4 mt-4">
              <Alert className="bg-blue-50 dark:bg-blue-950 border-blue-200 dark:border-blue-800">
                <Package className="h-4 w-4" />
                <AlertDescription>
                  Import opening stock balances for P&L reports. This updates the frozen opening values in stock items -
                  it does NOT affect current inventory.
                </AlertDescription>
              </Alert>

              <div className="space-y-2">
                <label className="text-sm font-medium">File</label>
                <Input
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  onChange={handleOpeningFileChange}
                  data-testid="input-import-opening-file"
                />
                <p className="text-xs text-muted-foreground">Excel columns: "Barcode", "Qty", "Rate", "Total Value"</p>
              </div>

              <Button
                variant="outline"
                className="w-full gap-2"
                onClick={downloadOpeningTemplate}
                data-testid="button-download-opening-template"
              >
                <Download className="h-4 w-4" />
                Download Template
              </Button>

              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                  data-testid="button-cancel-opening-import"
                >
                  Cancel
                </Button>
                <Button
                  onClick={handleImportOpening}
                  disabled={!openingFile || isProcessingOpening}
                  data-testid="button-confirm-opening-import"
                >
                  {isProcessingOpening ? "Importing..." : "Import Opening Balances"}
                </Button>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="prices" className="space-y-4">
            <div className="space-y-4 mt-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Location</label>
                <Select value={selectedLocation} onValueChange={setSelectedLocation}>
                  <SelectTrigger data-testid="select-location-import">
                    <SelectValue placeholder="Select a location" />
                  </SelectTrigger>
                  <SelectContent>
                    {locations.map((location) => (
                      <SelectItem key={location.id} value={location.id.toString()}>
                        {location.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">Prices will be applied to this location</p>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">File</label>
                <Input
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  onChange={handlePricesFileChange}
                  data-testid="input-import-prices-file"
                />
                <p className="text-xs text-muted-foreground">
                  Excel columns: "Barcode (Item Code)" and "Selling Price". Use the item's code (e.g. ITEM-001) as the
                  barcode.
                </p>
              </div>

              <Button
                variant="outline"
                className="w-full gap-2"
                onClick={downloadPricesTemplate}
                data-testid="button-download-prices-template"
              >
                <Download className="h-4 w-4" />
                Download Template
              </Button>

              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => onOpenChange(false)} data-testid="button-cancel-prices-import">
                  Cancel
                </Button>
                <Button
                  onClick={handleImportPrices}
                  disabled={!pricesFile || isProcessing}
                  data-testid="button-confirm-prices-import"
                >
                  {isProcessing ? "Importing..." : "Import"}
                </Button>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="items" className="space-y-4">
            <StockNameUpdateImport />
            <div className="p-4 bg-muted/50 rounded-md space-y-3">
              <p className="text-sm font-medium">Need to create brand-new stock items?</p>
              <p className="text-sm text-muted-foreground">
                Use the dedicated import page for new items with stock-group validation and preview.
              </p>
              <a href={newItemsImportHref}>
                <Button variant="outline" className="w-full" data-testid="button-go-to-import-items">
                  Go to New Items Import Page
                </Button>
              </a>
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
