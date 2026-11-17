// Extracted from ./FactoryCustomerStatement.tsx to keep that module under the source-size cap.
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Download, Plus, Save, Trash2, Upload } from "lucide-react";
import { LEGACY_PRICE_DESTINATION } from "./factorycustomerstatement/statementHelpers";
import { useFactoryCustomerStatementState } from "./useFactoryCustomerStatementStatePart2";

export function FactoryCustomerStatementSection({
  deletePriceMutation,
  handleSavePrices,
  newCode,
  newPrice,
  priceDestination,
  priceDestinationsQuery,
  priceEdits,
  priceListQuery,
  recordChanges,
  savePricesMutation,
  setNewCode,
  setNewPrice,
  setPriceEdits,
}: Pick<
  ReturnType<typeof useFactoryCustomerStatementState>,
  | "deletePriceMutation"
  | "handleSavePrices"
  | "newCode"
  | "newPrice"
  | "priceDestination"
  | "priceDestinationsQuery"
  | "priceEdits"
  | "priceListQuery"
  | "recordChanges"
  | "savePricesMutation"
  | "setNewCode"
  | "setNewPrice"
  | "setPriceEdits"
>) {
  return (
    <div className="rounded-xl border overflow-hidden">
      <Table mobileLayout="cards">
        <TableHeader className="sticky top-0 z-30">
          <TableRow className="bg-muted border-b-2 border-border/60 hover:bg-muted">
            <TableHead className="text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
              Article Code
            </TableHead>
            <TableHead className="text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
              Name
            </TableHead>
            <TableHead className="text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
              Price per Bale ($)
            </TableHead>
            <TableHead className="text-right text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2">
              Last Updated
            </TableHead>
            <TableHead className="w-[50px] py-2"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {!priceDestination || priceDestinationsQuery.isLoading ? (
            <TableRow>
              <TableCell colSpan={5} className="text-center text-muted-foreground py-6">
                Select a destination to view its agreed prices.
              </TableCell>
            </TableRow>
          ) : priceListQuery.isError ? (
            <TableRow>
              <TableCell colSpan={5} role="alert" className="text-center text-destructive py-6">
                Failed to load prices for this destination. Please retry.
              </TableCell>
            </TableRow>
          ) : priceListQuery.isLoading ? (
            <TableRow>
              <TableCell colSpan={5} className="text-center py-6">
                <Skeleton className="h-4 w-48 mx-auto" />
              </TableCell>
            </TableRow>
          ) : (priceListQuery.data ?? []).length === 0 && !newCode ? (
            <TableRow>
              <TableCell colSpan={5} className="text-center text-muted-foreground py-8" data-testid="text-no-prices">
                No agreed prices for this destination yet. Upload Excel or add them manually below.
              </TableCell>
            </TableRow>
          ) : (
            (priceListQuery.data ?? []).map((entry) => (
              <TableRow key={entry.article_code} data-testid={`row-price-${entry.article_code}`}>
                <TableCell
                  className="font-mono text-sm font-medium"
                  data-testid={`text-price-code-${entry.article_code}`}
                >
                  {entry.article_code}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">{entry.item_name || "-"}</TableCell>
                <TableCell className="text-right">
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    value={
                      priceEdits[entry.article_code] !== undefined
                        ? priceEdits[entry.article_code]
                        : entry.price_per_bale
                    }
                    onChange={(e) => setPriceEdits((prev) => ({ ...prev, [entry.article_code]: e.target.value }))}
                    readOnly={!recordChanges.allowed}
                    title={recordChanges.reason ?? undefined}
                    onBlur={() => {
                      if (
                        recordChanges.allowed &&
                        priceEdits[entry.article_code] !== undefined &&
                        !savePricesMutation.isPending
                      ) {
                        handleSavePrices();
                      }
                    }}
                    className="w-32 ml-auto text-right font-mono"
                    data-testid={`input-price-${entry.article_code}`}
                  />
                </TableCell>
                <TableCell className="text-right text-xs text-muted-foreground whitespace-nowrap">
                  {entry.updated_at ? new Date(entry.updated_at).toLocaleDateString() : "-"}
                </TableCell>
                <TableCell>
                  {recordChanges.allowed && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-destructive"
                      onClick={() =>
                        deletePriceMutation.mutate({
                          articleCode: entry.article_code,
                          destination: priceDestination,
                        })
                      }
                      disabled={!priceDestination || deletePriceMutation.isPending || savePricesMutation.isPending}
                      data-testid={`button-delete-price-${entry.article_code}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))
          )}

          {/* Add new row */}
          {recordChanges.allowed && (
            <TableRow data-testid="row-add-price">
              <TableCell>
                <Input
                  placeholder="Article code…"
                  value={newCode}
                  onChange={(e) => setNewCode(e.target.value)}
                  className="font-mono"
                  data-testid="input-new-price-code"
                />
              </TableCell>
              <TableCell />
              <TableCell className="text-right">
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  placeholder="0.00"
                  value={newPrice}
                  onChange={(e) => setNewPrice(e.target.value)}
                  className="w-32 ml-auto text-right font-mono"
                  data-testid="input-new-price-value"
                />
              </TableCell>
              <TableCell />
              <TableCell>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handleSavePrices}
                  disabled={
                    !priceDestination ||
                    !newCode.trim() ||
                    !newPrice ||
                    savePricesMutation.isPending ||
                    deletePriceMutation.isPending
                  }
                  data-testid="button-add-price"
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}

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
          <select
            id="customer-price-destination"
            data-testid="select-price-destination"
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
            value={priceDestination}
            onChange={(e) => void selectPriceDestination(e.target.value)}
            disabled={savePricesMutation.isPending || deletePriceMutation.isPending}
          >
            <option value="" disabled>
              Select destination
            </option>
            {(priceDestinationsQuery.data ?? []).map((destination) => (
              <option key={destination} value={destination}>
                {destination}
              </option>
            ))}
            {priceDestination &&
              priceDestination !== LEGACY_PRICE_DESTINATION &&
              !(priceDestinationsQuery.data ?? []).includes(priceDestination) && (
                <option value={priceDestination}>{priceDestination}</option>
              )}
            <option value={LEGACY_PRICE_DESTINATION}>Legacy / Unassigned (old prices)</option>
          </select>
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
