import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { ChevronRight, ChevronDown, Package, FileText } from "lucide-react";
import {
  StockMovementData,
  OpeningStockSummaryData,
  Location,
  StockGroup,
  OpeningStockItemsData,
} from "./analyticsTypes";
import { Fragment } from "react";

interface StockReportPanelProps {
  activeSection: string;
  reportStartDate: string;
  setReportStartDate: (date: string) => void;
  reportEndDate: string;
  setReportEndDate: (date: string) => void;
  reportLocationId: string;
  setReportLocationId: (id: string) => void;
  locations: Location[];
  reportStockGroupId: string;
  setReportStockGroupId: (id: string) => void;
  stockGroups: StockGroup[];
  loadingStock: boolean;
  stockMovementData?: StockMovementData;
  formatNumber: (num: number) => string;
  formatAmount: (amount: number) => string;
  openingStockLocationId: string;
  handleOpeningStockLocationChange: (id: string) => void;
  loadingOpeningStock: boolean;
  openingStockData?: OpeningStockSummaryData;
  expandedStockGroups: Set<number>;
  toggleStockGroup: (id: number) => void;
  stockGroupItems: Map<number, OpeningStockItemsData>;
}

export function StockReportPanel({
  activeSection,
  reportStartDate,
  setReportStartDate,
  reportEndDate,
  setReportEndDate,
  reportLocationId,
  setReportLocationId,
  locations,
  reportStockGroupId,
  setReportStockGroupId,
  stockGroups,
  loadingStock,
  stockMovementData,
  formatNumber,
  formatAmount,
  openingStockLocationId,
  handleOpeningStockLocationChange,
  loadingOpeningStock,
  openingStockData,
  expandedStockGroups,
  toggleStockGroup,
  stockGroupItems,
}: StockReportPanelProps) {
  if (activeSection === "stock") {
    return (
      <Card className="p-6">
        <div className="flex items-center justify-between -mx-6 px-6 pb-4 mb-4 border-b border-border">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/10 text-primary">
              <Package className="h-4 w-4" />
            </div>
            <h3 className="font-semibold text-base">Stock Movement Report</h3>
          </div>
        </div>

        <div className="flex flex-wrap gap-4 mb-6 items-end">
          <div className="flex flex-col gap-1.5">
            <Label>Start Date</Label>
            <Input
              type="date"
              value={reportStartDate}
              onChange={(e) => setReportStartDate(e.target.value)}
              className="w-auto"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>End Date</Label>
            <Input
              type="date"
              value={reportEndDate}
              onChange={(e) => setReportEndDate(e.target.value)}
              className="w-auto"
            />
          </div>
          <div className="flex flex-col gap-1.5 min-w-[160px]">
            <Label>Location</Label>
            <Select value={reportLocationId} onValueChange={setReportLocationId}>
              <SelectTrigger>
                <SelectValue placeholder="All Locations" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Locations</SelectItem>
                {locations.map((loc) => (
                  <SelectItem key={loc.id} value={loc.id.toString()}>
                    {loc.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5 min-w-[160px]">
            <Label>Stock Group</Label>
            <Select value={reportStockGroupId} onValueChange={setReportStockGroupId}>
              <SelectTrigger>
                <SelectValue placeholder="All Groups" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Groups</SelectItem>
                {stockGroups.map((group) => (
                  <SelectItem key={group.id} value={group.id.toString()}>
                    {group.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {loadingStock ? (
          <div className="space-y-3">
            {[1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : stockMovementData ? (
          <div className="table-responsive">
            <Table>
              <TableHeader className="sticky top-0 z-30 bg-background">
                <TableRow>
                  <TableHead>Item Name</TableHead>
                  <TableHead className="text-right">Total Quantity</TableHead>
                  <TableHead className="text-right">Total Value</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {stockMovementData.items.map((item) => (
                  <TableRow key={item.stockItemId}>
                    <TableCell className="font-medium">{item.stockItemName}</TableCell>
                    <TableCell className="text-right font-mono">{formatNumber(item.totalQuantity)}</TableCell>
                    <TableCell className="text-right font-mono">{formatAmount(item.totalValue)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <TableBody className="font-semibold border-t-2">
                <TableRow>
                  <TableCell>Total</TableCell>
                  <TableCell className="text-right font-mono">
                    {formatNumber(stockMovementData.summary.grandTotalQuantity)}
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {formatAmount(stockMovementData.summary.grandTotalValue)}
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground text-center py-8">Select filters to load stock movement</p>
        )}
      </Card>
    );
  }

  if (activeSection === "opening-stock") {
    return (
      <Card className="p-6">
        <div className="flex items-center justify-between -mx-6 px-6 pb-4 mb-4 border-b border-border">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/10 text-primary">
              <FileText className="h-4 w-4" />
            </div>
            <h3 className="font-semibold text-base">Opening Stock Summary</h3>
          </div>
        </div>

        <div className="flex flex-wrap gap-4 mb-6 items-end">
          <div className="flex flex-col gap-1.5 min-w-[200px]">
            <Label>Location</Label>
            <Select value={openingStockLocationId} onValueChange={handleOpeningStockLocationChange}>
              <SelectTrigger>
                <SelectValue placeholder="All Locations" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Locations</SelectItem>
                {locations.map((loc) => (
                  <SelectItem key={loc.id} value={loc.id.toString()}>
                    {loc.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {loadingOpeningStock ? (
          <div className="space-y-3">
            {[1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : openingStockData ? (
          <div className="table-responsive">
            <Table mobileLayout="cards">
              <TableHeader className="sticky top-0 z-30 bg-background">
                <TableRow>
                  <TableHead>Stock Group</TableHead>
                  <TableHead className="text-right">Opening Qty</TableHead>
                  <TableHead className="text-right">Opening Value</TableHead>
                  <TableHead className="text-right">Closing Qty</TableHead>
                  <TableHead className="text-right">Closing Value</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {openingStockData.stockGroups.map((group) => (
                  <Fragment key={group.id}>
                    <TableRow
                      className="cursor-pointer hover-elevate font-medium"
                      onClick={() => toggleStockGroup(group.id)}
                    >
                      <TableCell>
                        <div className="flex items-center gap-2">
                          {expandedStockGroups.has(group.id) ? (
                            <ChevronDown className="h-4 w-4" />
                          ) : (
                            <ChevronRight className="h-4 w-4" />
                          )}
                          {group.name}
                          <span className="text-xs text-muted-foreground ml-2">({group.itemCount} items)</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-mono">{formatNumber(group.opening.quantity)}</TableCell>
                      <TableCell className="text-right font-mono">{formatAmount(group.opening.value)}</TableCell>
                      <TableCell className="text-right font-mono">{formatNumber(group.closing.quantity)}</TableCell>
                      <TableCell className="text-right font-mono">{formatAmount(group.closing.value)}</TableCell>
                    </TableRow>
                    {expandedStockGroups.has(group.id) && (
                      <>
                        {stockGroupItems.get(group.id)?.items.map((item) => (
                          <TableRow key={item.id} className="bg-muted/30 text-xs">
                            <TableCell className="pl-8">{item.name}</TableCell>
                            <TableCell className="text-right font-mono">
                              {formatNumber(item.opening.quantity)}
                            </TableCell>
                            <TableCell className="text-right font-mono">{formatAmount(item.opening.value)}</TableCell>
                            <TableCell className="text-right font-mono">
                              {formatNumber(item.closing.quantity)}
                            </TableCell>
                            <TableCell className="text-right font-mono">{formatAmount(item.closing.value)}</TableCell>
                          </TableRow>
                        ))}
                        {!stockGroupItems.has(group.id) && (
                          <TableRow>
                            <TableCell colSpan={5} className="py-2 px-8">
                              <Skeleton className="h-4 w-full" />
                            </TableCell>
                          </TableRow>
                        )}
                      </>
                    )}
                  </Fragment>
                ))}
              </TableBody>
              <TableBody className="font-semibold border-t-2">
                <TableRow>
                  <TableCell>Grand Total</TableCell>
                  <TableCell className="text-right font-mono">
                    {formatNumber(openingStockData.grandTotal.opening.quantity)}
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {formatAmount(openingStockData.grandTotal.opening.value)}
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {formatNumber(openingStockData.grandTotal.closing.quantity)}
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {formatAmount(openingStockData.grandTotal.closing.value)}
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground text-center py-8">Load opening stock data</p>
        )}
      </Card>
    );
  }

  return null;
}
