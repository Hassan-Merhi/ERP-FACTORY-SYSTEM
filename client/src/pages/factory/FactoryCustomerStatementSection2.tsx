// Extracted from ./FactoryCustomerStatementSection.tsx
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Download, Save, Upload } from "lucide-react";
import { LEGACY_PRICE_DESTINATION } from "./factorycustomerstatement/statementHelpers";
import { useFactoryCustomerStatementState } from "./useFactoryCustomerStatementStatePart2";
import { SelectContent, SelectItem, SelectTrigger, SelectValue, Select } from "@/components/ui/select";

export function FactoryCustomerStatementSection2({
  addPriceDestination,
  deletePriceMutation,
  fileInputRef,
  handleExcelUpload,
  handlePriceListTemplateDownload,
  handleSavePrices,
  hasPriceEdits,
  newDestination,
  priceDestination,
  priceDestinationsQuery,
  recordChanges,
  savePricesMutation,
  selectPriceDestination,
  setNewDestination,
}: Pick<
  ReturnType<typeof useFactoryCustomerStatementState>,
  | "addPriceDestination"
  | "deletePriceMutation"
  | "fileInputRef"
  | "handleExcelUpload"
  | "handlePriceListTemplateDownload"
  | "handleSavePrices"
  | "hasPriceEdits"
  | "newDestination"
  | "priceDestination"
  | "priceDestinationsQuery"
  | "recordChanges"
  | "savePricesMutation"
  | "selectPriceDestination"
  | "setNewDestination"
>) {
  return (
    <div className="mb-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold">Saved Agreed Prices by Destination</p>
          <p className="text-xs text-muted-foreground">
            New proformas use only agreed prices for their own customer and destination.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handlePriceListTemplateDownload}
            data-testid="button-download-pricelist-template"
          >
            <Download className="h-4 w-4 mr-2" /> Download Template
          </Button>
          {recordChanges.allowed && (
            <>
              <input
                type="file"
                accept=".xlsx,.xls,.csv"
                ref={fileInputRef}
                onChange={handleExcelUpload}
                className="hidden"
                data-testid="input-upload-pricelist"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                disabled={!priceDestination || savePricesMutation.isPending || deletePriceMutation.isPending}
                data-testid="button-upload-excel-pricelist"
              >
                <Upload className="h-4 w-4 mr-2" /> Upload Excel
              </Button>
            </>
          )}
          {recordChanges.allowed && hasPriceEdits && (
            <Button
              size="sm"
              onClick={handleSavePrices}
              disabled={!priceDestination || savePricesMutation.isPending || deletePriceMutation.isPending}
              data-testid="button-save-pricelist"
            >
              <Save className="h-4 w-4 mr-2" />
              {savePricesMutation.isPending ? "Saving…" : "Save"}
            </Button>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-3 rounded-xl border bg-muted/20 p-3">
        <div className="min-w-[200px] flex-1 sm:max-w-[320px]">
          <label htmlFor="customer-price-destination" className="mb-1 block text-xs font-semibold">
            Price list destination
          </label>
          <Select
            value={priceDestination}
            onValueChange={(v) => void selectPriceDestination(v)}
            disabled={savePricesMutation.isPending || deletePriceMutation.isPending}
          >
            <SelectTrigger
              id="customer-price-destination"
              data-testid="select-price-destination"
              className="h-9 w-full"
            >
              <SelectValue placeholder="Select destination" />
            </SelectTrigger>
            <SelectContent>
              {(priceDestinationsQuery.data ?? []).map((destination) => (
                <SelectItem key={destination} value={destination}>
                  {destination}
                </SelectItem>
              ))}
              {priceDestination &&
                priceDestination !== LEGACY_PRICE_DESTINATION &&
                !(priceDestinationsQuery.data ?? []).includes(priceDestination) && (
                  <SelectItem value={priceDestination}>{priceDestination}</SelectItem>
                )}
              <SelectItem value={LEGACY_PRICE_DESTINATION}>Legacy / Unassigned (old prices)</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {recordChanges.allowed && (
          <div className="flex min-w-[220px] flex-1 items-end gap-2">
            <div className="flex-1">
              <label htmlFor="customer-new-price-destination" className="mb-1 block text-xs font-semibold">
                Add another destination
              </label>
              <Input
                id="customer-new-price-destination"
                data-testid="input-new-price-destination"
                value={newDestination}
                onChange={(e) => setNewDestination(e.target.value)}
                placeholder="e.g. L'SHI, MALI"
                maxLength={120}
                disabled={savePricesMutation.isPending || deletePriceMutation.isPending}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addPriceDestination();
                  }
                }}
              />
            </div>
            <Button
              size="sm"
              variant="outline"
              data-testid="button-add-price-destination"
              onClick={addPriceDestination}
              disabled={!newDestination.trim() || savePricesMutation.isPending || deletePriceMutation.isPending}
            >
              Use
            </Button>
          </div>
        )}
        {priceDestinationsQuery.isError && (
          <p role="alert" className="w-full text-xs text-destructive">
            Failed to load customer destinations. Please refresh and retry.
          </p>
        )}
        {priceDestination === LEGACY_PRICE_DESTINATION ? (
          <p className="w-full text-xs text-amber-600 dark:text-amber-400">
            Older customer-wide prices are separate and are not applied to new destination-linked proformas.
          </p>
        ) : priceDestination ? (
          <p className="w-full text-xs text-muted-foreground">
            Only {priceDestination} prices will change here. Existing proforma line prices remain unchanged.
          </p>
        ) : null}
      </div>
    </div>
  );
}
