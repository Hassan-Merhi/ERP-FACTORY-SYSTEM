import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ArrowLeft, Package, TrendingUp, MapPin, X, Calendar, ChevronDown } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/PageHeader";
import {
  PRESET_LABELS,
  StockItemDetailCardSection,
  formatSmartNumber,
  useStockItemDetailState,
  type DatePreset,
} from "./useStockItemDetailState";

export default function StockItemDetail() {
  const {
    applyPreset,
    detailsError,
    detailsLoading,
    filteredInventoryLocations,
    filteredSales,
    formatAmount,
    formatDisplayDate,
    fromDate,
    handleBack,
    handleSaleClick,
    itemDetails,
    itemId,
    locationOptions,
    preset,
    refetchDetails,
    selectedItem,
    selectedLocation,
    setFromDate,
    setSelectedLocation,
    setToDate,
    stockItems,
    toDate,
  } = useStockItemDetailState();

  if (!itemId || (stockItems.length > 0 && !selectedItem)) {
    return (
      <div className="p-3 sm:p-6 space-y-6">
        <Button variant="ghost" onClick={handleBack} className="gap-2">
          <ArrowLeft className="h-4 w-4" />
          Back to Stock Query
        </Button>
        <Card>
          <CardContent className="p-6 text-center text-muted-foreground">Stock item not found</CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4 sm:space-y-6 sm:p-6">
      <PageHeader
        title={selectedItem?.name || "Loading..."}
        subtitle="Purchase history, sales history, and current inventory locations"
        onBack={handleBack}
        backButtonTestId="button-back-to-stock-query"
      />

      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-3">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="gap-2" data-testid="button-date-preset">
                <Calendar className="h-4 w-4 text-muted-foreground" />
                {PRESET_LABELS[preset]}
                <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {(
                [
                  "all",
                  "today",
                  "yesterday",
                  "this-month",
                  "last-1-month",
                  "last-6-months",
                  "this-year",
                ] as DatePreset[]
              ).map((option) => (
                <DropdownMenuItem
                  key={option}
                  onClick={() => applyPreset(option)}
                  className={preset === option ? "bg-accent" : ""}
                >
                  {PRESET_LABELS[option]}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => applyPreset("custom")}
                className={preset === "custom" ? "bg-accent" : ""}
              >
                Custom Range...
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="gap-2" data-testid="button-location-filter">
                <MapPin className="h-4 w-4 text-muted-foreground" />
                <span>{selectedLocation === "all" ? "All Locations" : selectedLocation}</span>
                <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-52">
              <DropdownMenuItem
                onClick={() => setSelectedLocation("all")}
                className={selectedLocation === "all" ? "bg-accent" : ""}
              >
                All Locations
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {locationOptions.map((location) => (
                <DropdownMenuItem
                  key={location}
                  onClick={() => setSelectedLocation(location)}
                  className={selectedLocation === location ? "bg-accent" : ""}
                >
                  {location}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {preset === "custom" && (
            <>
              <div className="flex flex-col gap-1">
                <Label htmlFor="filter-from" className="text-xs text-muted-foreground">
                  From
                </Label>
                <Input
                  id="filter-from"
                  type="date"
                  value={fromDate}
                  onChange={(e) => setFromDate(e.target.value)}
                  className="w-40"
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="filter-to" className="text-xs text-muted-foreground">
                  To
                </Label>
                <Input
                  id="filter-to"
                  type="date"
                  value={toDate}
                  onChange={(e) => setToDate(e.target.value)}
                  className="w-40"
                />
              </div>
              <Button variant="ghost" size="sm" onClick={() => applyPreset("all")} className="gap-1.5 self-end">
                <X className="h-3.5 w-3.5" />
                Clear dates
              </Button>
            </>
          )}
          {(preset !== "all" || selectedLocation !== "all") && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                applyPreset("all");
                setSelectedLocation("all");
              }}
              className="gap-1.5"
            >
              <X className="h-3.5 w-3.5" />
              Clear filters
            </Button>
          )}
          {selectedLocation !== "all" && (
            <span className="text-xs text-muted-foreground">
              Filtering all location-based tables by {selectedLocation}
            </span>
          )}
        </div>
      </Card>

      {detailsLoading ? (
        <div className="space-y-6">
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      ) : detailsError ? (
        <div className="flex flex-col items-center justify-center py-16 gap-3 text-muted-foreground">
          <Package className="h-10 w-10 opacity-25" />
          <p className="text-sm font-medium text-foreground">Failed to load stock item details</p>
          <p className="text-xs text-destructive">{(detailsError as Error).message}</p>
          <Button variant="outline" size="sm" onClick={() => refetchDetails()}>
            Try again
          </Button>
        </div>
      ) : !itemDetails ? (
        <Card>
          <CardContent className="p-6 text-center text-muted-foreground">
            No details available for this stock item.
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
          <Card className="flex flex-col">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Package className="h-4 w-4" />
                Purchases
              </CardTitle>
            </CardHeader>
            <CardContent className="flex-1 overflow-hidden">
              {itemDetails.purchases.length ? (
                <div className="h-64 overflow-y-auto">
                  <Table>
                    <TableHeader className="sticky top-0 bg-background">
                      <TableRow>
                        <TableHead>Container</TableHead>
                        <TableHead className="text-right">Qty</TableHead>
                        <TableHead className="text-right">Rate</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {itemDetails.purchases.map((purchase, index) => (
                        <TableRow key={index}>
                          <TableCell className="text-sm font-mono">
                            {purchase.containerNumber || purchase.supplierName || "-"}
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm">
                            {formatSmartNumber(purchase.quantity)}
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm">
                            {formatAmount(parseFloat(purchase.rate))}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                    <TableFooter>
                      <TableRow className="font-semibold">
                        <TableCell>Total</TableCell>
                        <TableCell className="text-right font-mono">
                          {formatSmartNumber(
                            itemDetails.purchases.reduce(
                              (sum, purchase) => sum + parseFloat(purchase.quantity || "0"),
                              0
                            )
                          )}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {formatAmount(
                            itemDetails.purchases.reduce((sum, purchase) => sum + parseFloat(purchase.amount || "0"), 0)
                          )}
                        </TableCell>
                      </TableRow>
                    </TableFooter>
                  </Table>
                </div>
              ) : (
                <div className="h-64 flex items-center justify-center text-muted-foreground">No purchase history</div>
              )}
            </CardContent>
          </Card>

          <Card className="flex flex-col">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <TrendingUp className="h-4 w-4" />
                Sales
              </CardTitle>
            </CardHeader>
            <CardContent className="flex-1 overflow-hidden">
              {filteredSales.length ? (
                <div className="h-64 overflow-y-auto">
                  <Table>
                    <TableHeader className="sticky top-0 bg-background">
                      <TableRow>
                        <TableHead>Date</TableHead>
                        <TableHead>Location</TableHead>
                        <TableHead className="text-right">Qty</TableHead>
                        <TableHead className="text-right">Rate</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredSales.map((sale, index) => (
                        <TableRow
                          key={index}
                          onClick={() => handleSaleClick(sale)}
                          className={sale.voucherId ? "cursor-pointer hover-elevate" : ""}
                        >
                          <TableCell className="text-sm">{formatDisplayDate(new Date(sale.saleDate))}</TableCell>
                          <TableCell className="text-sm">{sale.locationName || "-"}</TableCell>
                          <TableCell className="text-right font-mono text-sm">
                            {formatSmartNumber(sale.quantity)}
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm">
                            {formatAmount(parseFloat(sale.sellingPrice))}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                    <TableFooter>
                      <TableRow className="font-semibold">
                        <TableCell>Total</TableCell>
                        <TableCell />
                        <TableCell className="text-right font-mono">
                          {formatSmartNumber(
                            filteredSales.reduce((sum, sale) => sum + parseFloat(sale.quantity || "0"), 0)
                          )}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {formatAmount(
                            filteredSales.reduce((sum, sale) => sum + parseFloat(sale.totalSales || "0"), 0)
                          )}
                        </TableCell>
                      </TableRow>
                    </TableFooter>
                  </Table>
                </div>
              ) : (
                <div className="h-64 flex items-center justify-center text-muted-foreground">
                  No sales history for this location
                </div>
              )}
            </CardContent>
          </Card>

          <StockItemDetailCardSection
            filteredInventoryLocations={filteredInventoryLocations}
            formatAmount={formatAmount}
          />
        </div>
      )}
    </div>
  );
}
