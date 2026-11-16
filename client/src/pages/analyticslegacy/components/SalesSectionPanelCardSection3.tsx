// Extracted from ./SalesSectionPanel.tsx to keep that module under the source-size cap.
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ChevronRight } from "lucide-react";
import { formatNumber } from "@/lib/formatNumber";
import { useSalesSectionPanelState } from "./useSalesSectionPanelState";

export function SalesSectionPanelCardSection2({
  factoryPosSummary,
  formatAmount,
  loadingFactoryPos,
  setSelectedPosCustomer,
}: Pick<
  ReturnType<typeof useSalesSectionPanelState>,
  "factoryPosSummary" | "formatAmount" | "loadingFactoryPos" | "setSelectedPosCustomer"
>) {
  return (
    <Card className="p-6">
      <div className="mb-4">
        <h3 className="text-lg font-medium">Factory POS</h3>
        <p className="text-sm text-muted-foreground mt-1">Point-of-sale transactions, by customer</p>
      </div>
      {loadingFactoryPos ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : !factoryPosSummary || (factoryPosSummary.byCustomer ?? []).length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-8">No factory POS sales data available</p>
      ) : (
        <div className="table-responsive">
          <Table>
            <TableHeader className="sticky top-0 z-30 bg-background">
              <TableRow>
                <TableHead>Customer</TableHead>
                <TableHead className="text-right hidden sm:table-cell">Transactions</TableHead>
                <TableHead className="text-right">Total Sales</TableHead>
                <TableHead className="text-right hidden sm:table-cell">Cash Sales</TableHead>
                <TableHead className="text-right hidden sm:table-cell">Credit Sales</TableHead>
                <TableHead className="text-right hidden sm:table-cell">Deposit Collected</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(factoryPosSummary.byCustomer ?? []).map((row, idx: number) => (
                <TableRow
                  key={row.customerId ?? `${row.customerName}-${idx}`}
                  className="cursor-pointer hover:bg-muted/50"
                  onClick={() => {
                    setSelectedPosCustomer({
                      customerId: row.customerId,
                      customerName: row.customerName || "Walk-in / Cash",
                    });
                  }}
                  data-testid={`row-pos-customer-${row.customerId ?? idx}`}
                >
                  <TableCell className="font-medium">
                    <button
                      type="button"
                      className="text-left text-primary underline underline-offset-4 hover:no-underline"
                      onClick={(event) => {
                        event.stopPropagation();
                        setSelectedPosCustomer({
                          customerId: row.customerId,
                          customerName: row.customerName || "Walk-in / Cash",
                        });
                      }}
                      data-testid={`button-pos-customer-${row.customerId ?? idx}`}
                    >
                      {row.customerName || "Walk-in / Cash"}
                    </button>
                  </TableCell>
                  <TableCell className="text-right hidden sm:table-cell">{row.sales}</TableCell>
                  <TableCell className="text-right font-mono">{formatAmount(parseFloat(row.totalAmount))}</TableCell>
                  <TableCell className="text-right font-mono text-green-600 dark:text-green-400 hidden sm:table-cell">
                    {formatAmount(parseFloat(row.cashSales))}
                  </TableCell>
                  <TableCell className="text-right font-mono text-blue-600 dark:text-blue-400 hidden sm:table-cell">
                    {formatAmount(parseFloat(row.creditSales))}
                  </TableCell>
                  <TableCell className="text-right font-mono hidden sm:table-cell">
                    {formatAmount(parseFloat(row.depositAmount))}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
            {factoryPosSummary.grand && (
              <TableBody className="font-semibold border-t-2">
                <TableRow>
                  <TableCell>Total</TableCell>
                  <TableCell className="text-right hidden sm:table-cell">{factoryPosSummary.grand.sales}</TableCell>
                  <TableCell className="text-right font-mono">
                    {formatAmount(parseFloat(factoryPosSummary.grand.totalAmount))}
                  </TableCell>
                  <TableCell className="text-right font-mono text-green-600 dark:text-green-400 hidden sm:table-cell">
                    {formatAmount(parseFloat(factoryPosSummary.grand.cashSales))}
                  </TableCell>
                  <TableCell className="text-right font-mono text-blue-600 dark:text-blue-400 hidden sm:table-cell">
                    {formatAmount(parseFloat(factoryPosSummary.grand.creditSales))}
                  </TableCell>
                  <TableCell className="text-right font-mono hidden sm:table-cell">
                    {formatAmount(parseFloat(factoryPosSummary.grand.depositAmount))}
                  </TableCell>
                </TableRow>
              </TableBody>
            )}
          </Table>
        </div>
      )}
    </Card>
  );
}

export function SalesSectionPanelCardSection3({
  formatAmount,
  rangeEnd,
  rangeStart,
  salesData,
  salesLoading,
  selectedPeriod,
  setRangeEnd,
  setRangeStart,
  setSelectedLocationForDetails,
  setSelectedPeriod,
}: Pick<
  ReturnType<typeof useSalesSectionPanelState>,
  | "formatAmount"
  | "rangeEnd"
  | "rangeStart"
  | "salesData"
  | "salesLoading"
  | "selectedPeriod"
  | "setRangeEnd"
  | "setRangeStart"
  | "setSelectedLocationForDetails"
  | "setSelectedPeriod"
>) {
  return (
    <Card className="p-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
        <h3 className="text-lg font-medium">Sales by Location</h3>
        <div className="flex flex-wrap items-center gap-2">
          {selectedPeriod === "range" && (
            <>
              <Input
                type="date"
                className="w-auto"
                value={rangeStart}
                onChange={(e) => setRangeStart(e.target.value)}
                data-testid="input-range-start"
              />
              <span className="text-muted-foreground text-sm">to</span>
              <Input
                type="date"
                className="w-auto"
                value={rangeEnd}
                onChange={(e) => setRangeEnd(e.target.value)}
                data-testid="input-range-end"
              />
            </>
          )}
          <Select value={selectedPeriod} onValueChange={setSelectedPeriod}>
            <SelectTrigger className="w-full sm:w-[180px]" data-testid="select-sales-period">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Time</SelectItem>
              <SelectItem value="today">Today</SelectItem>
              <SelectItem value="month">This Month</SelectItem>
              <SelectItem value="year">This Year</SelectItem>
              <SelectItem value="range">Custom Range</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {salesLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      ) : salesData.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-8">No sales data available</p>
      ) : (
        <>
          <div className="hidden md:block">
            <Table>
              <TableHeader className="sticky top-0 z-30 bg-background">
                <TableRow>
                  <TableHead>Location</TableHead>
                  <TableHead className="text-right">Bales Sold</TableHead>
                  <TableHead className="text-right">Total Sales</TableHead>
                  <TableHead className="text-right">Transactions</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...salesData]
                  .sort((a, b) => (a.locationName ?? "").localeCompare(b.locationName ?? ""))
                  .map((location) => (
                    <TableRow key={location.locationId}>
                      <TableCell className="font-medium">{location.locationName}</TableCell>
                      <TableCell className="text-right font-mono">
                        {formatNumber(location.totalQuantity ?? 0)}
                      </TableCell>
                      <TableCell className="text-right font-mono">{formatAmount(location.totalSales)}</TableCell>
                      <TableCell className="text-right">{location.totalTransactions}</TableCell>
                      <TableCell className="text-right">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setSelectedLocationForDetails(location.locationId)}
                        >
                          View Details
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
              </TableBody>
              <TableBody className="font-semibold border-t-2 bg-muted/40">
                <TableRow>
                  <TableCell>Total</TableCell>
                  <TableCell className="text-right font-mono">
                    {formatNumber(salesData.reduce((s, l) => s + (l.totalQuantity ?? 0), 0))}
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {formatAmount(salesData.reduce((s, l) => s + l.totalSales, 0))}
                  </TableCell>
                  <TableCell className="text-right">{salesData.reduce((s, l) => s + l.totalTransactions, 0)}</TableCell>
                  <TableCell />
                </TableRow>
              </TableBody>
            </Table>
          </div>
          <div className="md:hidden space-y-3">
            {[...salesData]
              .sort((a, b) => (a.locationName ?? "").localeCompare(b.locationName ?? ""))
              .map((location) => (
                <Card
                  key={location.locationId}
                  className="hover-elevate cursor-pointer"
                  onClick={() => setSelectedLocationForDetails(location.locationId)}
                >
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">{location.locationName}</span>
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div className="grid grid-cols-3 mt-2 text-sm gap-2">
                      <span className="text-muted-foreground">
                        Bales:{" "}
                        <span className="font-mono text-foreground">{formatNumber(location.totalQuantity ?? 0)}</span>
                      </span>
                      <span className="text-muted-foreground">
                        Sales: <span className="font-mono text-foreground">{formatAmount(location.totalSales)}</span>
                      </span>
                      <span className="text-muted-foreground text-right">
                        Txns: <span className="text-foreground">{location.totalTransactions}</span>
                      </span>
                    </div>
                  </CardContent>
                </Card>
              ))}
            {/* Mobile totals card */}
            <Card className="bg-muted/40">
              <CardContent className="p-4">
                <div className="font-semibold mb-2">Total</div>
                <div className="grid grid-cols-3 text-sm gap-2">
                  <span className="text-muted-foreground">
                    Bales:{" "}
                    <span className="font-mono text-foreground font-semibold">
                      {formatNumber(salesData.reduce((s, l) => s + (l.totalQuantity ?? 0), 0))}
                    </span>
                  </span>
                  <span className="text-muted-foreground">
                    Sales:{" "}
                    <span className="font-mono text-foreground font-semibold">
                      {formatAmount(salesData.reduce((s, l) => s + l.totalSales, 0))}
                    </span>
                  </span>
                  <span className="text-muted-foreground text-right">
                    Txns:{" "}
                    <span className="text-foreground font-semibold">
                      {salesData.reduce((s, l) => s + l.totalTransactions, 0)}
                    </span>
                  </span>
                </div>
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </Card>
  );
}
