import { ArrowRight, Info, Loader2, RefreshCw, Replace } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { StockItemCombobox } from "@/components/vouchers/StockItemCombobox";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { displayMoney, displayQty } from "./POSItemReplacementTypes";
import { usePOSItemReplacementState } from "./usePOSItemReplacementState";
import { POSItemReplacementCardSection } from "./POSItemReplacementCardSection";

export default function POSItemReplacement() {
  const {
    activeStockItems,
    affectedVoucherCount,
    canSubmit,
    candidateData,
    candidatesFetching,
    candidatesLoading,
    fromDate,
    locationId,
    recordChanges,
    refetchCandidates,
    replaceQuantities,
    replacementItem,
    replacementLastSoldPrice,
    replacementLastSoldPriceLoading,
    replacementMutation,
    replacementStockItems,
    rows,
    selectedReplacements,
    setFromDate,
    setLocationId,
    setReplaceQuantities,
    setReplacementItem,
    setSourceItem,
    setToDate,
    sourceItem,
    toDate,
    totalReplaceQty,
    updateQty,
    visibleLocations,
  } = usePOSItemReplacementState();

  return (
    <div className="p-3 sm:p-6 space-y-4 sm:space-y-6 max-w-[1500px] mx-auto">
      <PageHeader
        title="POS Item Replacement"
        subtitle="Correct items entered on POS sales in bulk without opening each sale one by one"
      />

      <Alert>
        <Info className="h-4 w-4" />
        <AlertTitle>Correction only</AlertTitle>
        <AlertDescription>
          The original selling price and sale total stay unchanged. The tool replaces only the quantity you enter,
          returns that quantity to the wrong item, deducts it from the correct item, and recalculates item cost/profit
          through the normal POS edit flow.
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Replace className="h-4 w-4" />
            Choose what to replace
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-4 items-end">
            <div className="space-y-2">
              <Label>Location</Label>
              <Select
                value={locationId ? String(locationId) : ""}
                onValueChange={(value) => {
                  setLocationId(Number(value));
                  setReplaceQuantities({});
                }}
              >
                <SelectTrigger data-testid="select-pos-replacement-location">
                  <SelectValue placeholder="Choose location" />
                </SelectTrigger>
                <SelectContent>
                  {visibleLocations.map((location) => (
                    <SelectItem key={location.id} value={String(location.id)}>
                      {location.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Wrong item in POS</Label>
              <StockItemCombobox
                value={sourceItem}
                onChange={(id, name) => {
                  setSourceItem({ id, name });
                  if (replacementItem?.id === id) setReplacementItem(null);
                  setReplaceQuantities({});
                }}
                stockItems={activeStockItems}
                rowIndex={0}
                testIdPrefix="button-pos-replacement-source"
              />
            </div>

            <div className="hidden xl:flex justify-center pb-2">
              <ArrowRight className="h-5 w-5 text-muted-foreground" />
            </div>

            <div className="space-y-2">
              <Label>Correct item</Label>
              <StockItemCombobox
                value={replacementItem}
                onChange={(id, name) => setReplacementItem({ id, name })}
                stockItems={replacementStockItems}
                rowIndex={0}
                testIdPrefix="button-pos-replacement-target"
              />
              {replacementItem && (
                <div className="min-h-5 text-xs text-muted-foreground flex items-center gap-1.5">
                  {replacementLastSoldPriceLoading ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <>
                      <span>Last sold at this location:</span>
                      <span className="font-mono font-medium text-foreground">
                        {replacementLastSoldPrice === null ? "No prior sale" : displayMoney(replacementLastSoldPrice)}
                      </span>
                    </>
                  )}
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="pos-replacement-from">From</Label>
                <Input
                  id="pos-replacement-from"
                  type="date"
                  value={fromDate}
                  onChange={(event) => {
                    setFromDate(event.target.value);
                    setReplaceQuantities({});
                  }}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="pos-replacement-to">To</Label>
                <Input
                  id="pos-replacement-to"
                  type="date"
                  value={toDate}
                  onChange={(event) => {
                    setToDate(event.target.value);
                    setReplaceQuantities({});
                  }}
                />
              </div>
            </div>
          </div>

          {locationId && sourceItem && (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void refetchCandidates()}
                disabled={candidatesFetching}
              >
                <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${candidatesFetching ? "animate-spin" : ""}`} />
                Refresh sales
              </Button>
              <Badge variant="secondary">
                {candidateData?.count ?? 0} matching POS line{candidateData?.count === 1 ? "" : "s"}
              </Badge>
              {candidateData?.capped && (
                <Badge variant="destructive">Showing newest 500 rows — narrow the date range</Badge>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <POSItemReplacementCardSection
        candidatesLoading={candidatesLoading}
        locationId={locationId}
        replaceQuantities={replaceQuantities}
        replacementItem={replacementItem}
        replacementLastSoldPrice={replacementLastSoldPrice}
        replacementLastSoldPriceLoading={replacementLastSoldPriceLoading}
        rows={rows}
        selectedReplacements={selectedReplacements}
        setReplaceQuantities={setReplaceQuantities}
        sourceItem={sourceItem}
        updateQty={updateQty}
      />

      {selectedReplacements.length > 0 && (
        <Card className="sticky bottom-3 shadow-lg border-primary/30">
          <CardContent className="p-4 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
            <div>
              <p className="font-medium text-sm">
                Replace {displayQty(totalReplaceQty)} qty from {sourceItem?.name} →{" "}
                {replacementItem?.name || "choose correct item"}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                {selectedReplacements.length} sale line{selectedReplacements.length === 1 ? "" : "s"} across{" "}
                {affectedVoucherCount} POS sale{affectedVoucherCount === 1 ? "" : "s"}. Original sale prices stay
                unchanged.
              </p>
            </div>
            {recordChanges.allowed && (
              <Button
                type="button"
                onClick={() => replacementMutation.mutate()}
                disabled={!canSubmit}
                data-testid="button-apply-pos-item-replacements"
                className="min-w-[210px]"
              >
                {replacementMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Replace className="h-4 w-4 mr-2" />
                )}
                Apply {selectedReplacements.length} replacement{selectedReplacements.length === 1 ? "" : "s"}
              </Button>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
