// Extracted from ./FactoryDispatchBatches.tsx to keep that module under the source-size cap.
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { ChevronRight, Filter, Plus, Search, Truck } from "lucide-react";
import { StatusBadge, fmt, useFactoryDispatchBatchesState } from "./useFactoryDispatchBatchesState";

export function FactoryDispatchBatchesSection({
  canCreateBatch,
  customers,
  effectiveActiveTab,
  filterCustomer,
  filterStatus,
  filtered,
  formatDisplayDate,
  isLoading,
  navigate,
  reportsLoading,
  reportsSummary,
  search,
  setActiveTab,
  setCreateOpen,
  setFilterCustomer,
  setFilterStatus,
  setSearch,
  showBatches,
  showReports,
}: Pick<
  ReturnType<typeof useFactoryDispatchBatchesState>,
  | "canCreateBatch"
  | "customers"
  | "effectiveActiveTab"
  | "filterCustomer"
  | "filterStatus"
  | "filtered"
  | "formatDisplayDate"
  | "isLoading"
  | "navigate"
  | "reportsLoading"
  | "reportsSummary"
  | "search"
  | "setActiveTab"
  | "setCreateOpen"
  | "setFilterCustomer"
  | "setFilterStatus"
  | "setSearch"
  | "showBatches"
  | "showReports"
>) {
  return (
    <div className="flex-1 overflow-auto p-4 space-y-4">
      {!effectiveActiveTab && (
        <div className="rounded-md border p-6 text-sm text-muted-foreground">
          No Dispatch Batches tabs are available for this user.
        </div>
      )}
      {/* ── Reports tab ─────────────────────────────────────────────────────── */}
      {showReports &&
        effectiveActiveTab === "reports" &&
        (reportsLoading ? (
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            {[...Array(6)].map((_, i) => (
              <Skeleton key={i} className="h-24" />
            ))}
          </div>
        ) : reportsSummary ? (
          <div className="space-y-5">
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              <Card
                className="cursor-pointer hover-elevate"
                onClick={() => {
                  setActiveTab("list");
                  setFilterStatus("");
                }}
                data-testid="card-report-uninvoiced"
              >
                <CardContent className="pt-4 pb-4">
                  <p className="text-xs text-muted-foreground mb-1">Uninvoiced Batches</p>
                  <p className="text-3xl font-bold" data-testid="text-uninvoiced-count">
                    {reportsSummary.uninvoicedCount}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">Draft + Loading + Dispatched</p>
                </CardContent>
              </Card>
              <Card
                className="cursor-pointer hover-elevate"
                onClick={() => {
                  setActiveTab("list");
                  setFilterStatus("LOADING");
                }}
                data-testid="card-report-loading"
              >
                <CardContent className="pt-4 pb-4">
                  <p className="text-xs text-muted-foreground mb-1">Loading</p>
                  <p className="text-3xl font-bold text-blue-600 dark:text-blue-400">{reportsSummary.loadingCount}</p>
                  <p className="text-xs text-muted-foreground mt-1">Batches currently being loaded</p>
                </CardContent>
              </Card>
              <Card
                className="cursor-pointer hover-elevate"
                onClick={() => {
                  setActiveTab("list");
                  setFilterStatus("DISPATCHED");
                }}
                data-testid="card-report-dispatched"
              >
                <CardContent className="pt-4 pb-4">
                  <p className="text-xs text-muted-foreground mb-1">Dispatched — Pending Invoice</p>
                  <p className="text-3xl font-bold text-amber-600 dark:text-amber-400">
                    {reportsSummary.dispatchedCount}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">Trucks dispatched, no invoice yet</p>
                </CardContent>
              </Card>
              <Card
                className="cursor-pointer hover-elevate"
                onClick={() => {
                  setActiveTab("list");
                  setFilterStatus("INVOICED");
                }}
                data-testid="card-report-invoiced"
              >
                <CardContent className="pt-4 pb-4">
                  <p className="text-xs text-muted-foreground mb-1">Invoiced Batches</p>
                  <p className="text-3xl font-bold text-green-600 dark:text-green-400">
                    {reportsSummary.invoicedCount}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">Completed &amp; invoiced</p>
                </CardContent>
              </Card>
              <Card data-testid="card-report-reserved-bales">
                <CardContent className="pt-4 pb-4">
                  <p className="text-xs text-muted-foreground mb-1">Reserved Bales</p>
                  <p className="text-3xl font-bold">{reportsSummary.reservedBalesCount}</p>
                  <p className="text-xs text-muted-foreground mt-1">Bales scanned, not yet invoiced</p>
                </CardContent>
              </Card>
              <Card data-testid="card-report-dispatched-rides">
                <CardContent className="pt-4 pb-4">
                  <p className="text-xs text-muted-foreground mb-1">Dispatched Rides</p>
                  <p className="text-3xl font-bold">{reportsSummary.dispatchedRidesNotInvoiced}</p>
                  <p className="text-xs text-muted-foreground mt-1">Rides dispatched, batch not invoiced</p>
                </CardContent>
              </Card>
            </div>
            <p className="text-xs text-muted-foreground">Click a card to filter the batch list.</p>
          </div>
        ) : null)}

      {showBatches && effectiveActiveTab === "list" && (
        <>
          <Card>
            <CardContent className="pt-4">
              <div className="flex flex-wrap gap-3 items-end">
                <div className="flex items-center gap-2">
                  <Filter className="w-4 h-4 text-muted-foreground" />
                  <span className="text-sm font-medium">Filters</span>
                </div>
                <div className="flex flex-col gap-1">
                  <Label className="text-xs text-muted-foreground">Customer</Label>
                  <Select value={filterCustomer} onValueChange={setFilterCustomer}>
                    <SelectTrigger className="w-48" data-testid="select-filter-customer">
                      <SelectValue placeholder="All customers" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="_all">All customers</SelectItem>
                      {customers.map((c) => (
                        <SelectItem key={c.id} value={String(c.id)}>
                          {c.legalName}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-1">
                  <Label className="text-xs text-muted-foreground">Status</Label>
                  <Select value={filterStatus} onValueChange={setFilterStatus}>
                    <SelectTrigger className="w-36" data-testid="select-filter-status">
                      <SelectValue placeholder="All statuses" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="_all">All statuses</SelectItem>
                      <SelectItem value="DRAFT">Draft</SelectItem>
                      <SelectItem value="LOADING">Loading</SelectItem>
                      <SelectItem value="DISPATCHED">Dispatched</SelectItem>
                      <SelectItem value="INVOICED">Invoiced</SelectItem>
                      <SelectItem value="CANCELLED">Cancelled</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-1">
                  <Label className="text-xs text-muted-foreground">Search</Label>
                  <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                    <Input
                      className="pl-8 w-52"
                      placeholder="Batch #, customer, invoice..."
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      data-testid="input-search-batches"
                    />
                  </div>
                </div>
                {(filterCustomer !== "_all" || filterStatus !== "_all" || search) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setFilterCustomer("_all");
                      setFilterStatus("_all");
                      setSearch("");
                    }}
                  >
                    Clear
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-0">
              {isLoading ? (
                <div className="p-4 space-y-2">
                  {[...Array(5)].map((_, i) => (
                    <Skeleton key={i} className="h-12 w-full" />
                  ))}
                </div>
              ) : filtered.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-3">
                  <Truck className="w-10 h-10 opacity-40" />
                  <p className="text-sm">No dispatch batches found</p>
                  {canCreateBatch && (
                    <Button variant="outline" size="sm" onClick={() => setCreateOpen(true)}>
                      <Plus className="w-4 h-4 mr-1" /> Create first batch
                    </Button>
                  )}
                </div>
              ) : (
                <Table mobileLayout="cards">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Batch #</TableHead>
                      <TableHead>Customer</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead>Proforma</TableHead>
                      <TableHead className="text-center">Rides</TableHead>
                      <TableHead className="text-right">Bales</TableHead>
                      <TableHead className="text-right">Weight (kg)</TableHead>
                      <TableHead className="text-right">Value</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Invoice</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filtered.map((b) => (
                      <TableRow
                        key={b.id}
                        className="cursor-pointer hover-elevate"
                        onClick={() => navigate(`/factory/dispatch-batches/${b.id}`)}
                        data-testid={`row-dispatch-batch-${b.id}`}
                      >
                        <TableCell className="font-mono font-medium" data-testid={`text-batch-number-${b.id}`}>
                          {b.batchNumber}
                        </TableCell>
                        <TableCell data-testid={`text-batch-customer-${b.id}`}>{b.customerName || "—"}</TableCell>
                        <TableCell>{formatDisplayDate(b.batchDate)}</TableCell>
                        <TableCell className="text-muted-foreground text-sm">{b.proformaName || "—"}</TableCell>
                        <TableCell className="text-center">{b.rideCount}</TableCell>
                        <TableCell className="text-right">{fmt(b.baleCount)}</TableCell>
                        <TableCell className="text-right">{fmt(b.totalWeightKg)}</TableCell>
                        <TableCell className="text-right font-medium">
                          {b.currency} {fmt(b.totalAmount)}
                        </TableCell>
                        <TableCell>
                          <StatusBadge status={b.status} />
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground font-mono">
                          {b.invoiceNumber || "—"}
                        </TableCell>
                        <TableCell>
                          <ChevronRight className="w-4 h-4 text-muted-foreground" />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
