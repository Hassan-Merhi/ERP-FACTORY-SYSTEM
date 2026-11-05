import type { ChangeEvent, Dispatch, RefObject, SetStateAction } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Plus, Save, Trash2, Upload } from "lucide-react";

export interface PriceListEntry {
  article_code: string;
  item_name: string;
  price_per_bale: string;
  updated_at: string;
}

// Older customer-wide prices are retained for reference, but never used as
// destination-specific agreed prices on new proformas.
export const LEGACY_PRICE_DESTINATION = "__legacy__";

interface Props {
  priceDestination: string;
  destinations: string[];
  destinationsLoading: boolean;
  destinationsError: boolean;
  prices: PriceListEntry[];
  pricesLoading: boolean;
  pricesError: boolean;
  priceEdits: Record<string, string>;
  setPriceEdits: Dispatch<SetStateAction<Record<string, string>>>;
  newDestination: string;
  setNewDestination: (value: string) => void;
  newCode: string;
  setNewCode: (value: string) => void;
  newPrice: string;
  setNewPrice: (value: string) => void;
  hasPriceEdits: boolean;
  /** A save or delete is in flight. */
  busy: boolean;
  /** A save specifically is in flight. */
  saving: boolean;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onExcelUpload: (event: ChangeEvent<HTMLInputElement>) => void;
  onSavePrices: () => void;
  onSelectDestination: (destination: string) => void;
  onAddDestination: () => void;
  onDeletePrice: (articleCode: string) => void;
}

/** Saved agreed prices per destination for one Factory customer. */
export function CustomerPriceListTab({
  priceDestination,
  destinations,
  destinationsLoading,
  destinationsError,
  prices,
  pricesLoading,
  pricesError,
  priceEdits,
  setPriceEdits,
  newDestination,
  setNewDestination,
  newCode,
  setNewCode,
  newPrice,
  setNewPrice,
  hasPriceEdits,
  busy,
  saving,
  fileInputRef,
  onExcelUpload,
  onSavePrices,
  onSelectDestination,
  onAddDestination,
  onDeletePrice,
}: Props) {
  return (
    <>
      <div className="mb-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">Saved Agreed Prices by Destination</p>
            <p className="text-xs text-muted-foreground">
              New proformas use only agreed prices for their own customer and destination.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="file"
              accept=".xlsx,.xls,.csv"
              ref={fileInputRef}
              onChange={onExcelUpload}
              className="hidden"
              data-testid="input-upload-pricelist"
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={!priceDestination || busy}
              data-testid="button-upload-excel-pricelist"
            >
              <Upload className="h-4 w-4 mr-2" /> Upload Excel
            </Button>
            {hasPriceEdits && (
              <Button
                size="sm"
                onClick={onSavePrices}
                disabled={!priceDestination || busy}
                data-testid="button-save-pricelist"
              >
                <Save className="h-4 w-4 mr-2" />
                {saving ? "Saving…" : "Save Changes"}
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
              onChange={(e) => onSelectDestination(e.target.value)}
              disabled={busy}
            >
              <option value="" disabled>
                Select destination
              </option>
              {destinations.map((destination) => (
                <option key={destination} value={destination}>
                  {destination}
                </option>
              ))}
              {priceDestination &&
                priceDestination !== LEGACY_PRICE_DESTINATION &&
                !destinations.includes(priceDestination) && (
                  <option value={priceDestination}>{priceDestination}</option>
                )}
              <option value={LEGACY_PRICE_DESTINATION}>Legacy / Unassigned (old prices)</option>
            </select>
          </div>
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
                disabled={busy}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    onAddDestination();
                  }
                }}
              />
            </div>
            <Button
              size="sm"
              variant="outline"
              data-testid="button-add-price-destination"
              onClick={onAddDestination}
              disabled={!newDestination.trim() || busy}
            >
              Use
            </Button>
          </div>
          {destinationsError && (
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
            {!priceDestination || destinationsLoading ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-muted-foreground py-6">
                  Select a destination to view its agreed prices.
                </TableCell>
              </TableRow>
            ) : pricesError ? (
              <TableRow>
                <TableCell colSpan={5} role="alert" className="text-center text-destructive py-6">
                  Failed to load prices for this destination. Please retry.
                </TableCell>
              </TableRow>
            ) : pricesLoading ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center py-6">
                  <Skeleton className="h-4 w-48 mx-auto" />
                </TableCell>
              </TableRow>
            ) : prices.length === 0 && !newCode ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-muted-foreground py-8" data-testid="text-no-prices">
                  No agreed prices for this destination yet. Upload Excel or add them manually below.
                </TableCell>
              </TableRow>
            ) : (
              prices.map((entry) => (
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
                      onBlur={() => {
                        if (priceEdits[entry.article_code] !== undefined && !saving) {
                          onSavePrices();
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
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-destructive"
                      onClick={() => onDeletePrice(entry.article_code)}
                      disabled={!priceDestination || busy}
                      data-testid={`button-delete-price-${entry.article_code}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}

            {/* Add new row */}
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
                  onClick={onSavePrices}
                  disabled={!priceDestination || !newCode.trim() || !newPrice || busy}
                  data-testid="button-add-price"
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>

      <p className="text-xs text-muted-foreground mt-3">
        Excel format: columns named <span className="font-mono">article_code</span> and{" "}
        <span className="font-mono">price</span> (or <span className="font-mono">price_per_bale</span>). Prices are
        saved only to the selected destination. Use "Save as Agreed Prices" on a proforma to store its prices here.
      </p>
    </>
  );
}
