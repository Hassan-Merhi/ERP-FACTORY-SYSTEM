import { EmptyState, ErrorState } from "@/components/ui/page-state";
import { Package, Pencil } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { RowsExportMenu } from "@/components/export/RowsExportMenu";
import { baleHistoryExportColumns } from "./baleHistoryExport";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { BaleHistoryStatusBadge } from "./BaleHistoryStatusBadge";

import { BaleWeightEditDialog } from "@/components/BaleWeightEditDialog";
import { SearchField } from "@/components/ui/search-field";
import { useFactoryBaleProductMonthDetailState } from "./useFactoryBaleProductMonthDetailState";
import { FactoryBaleProductMonthDetailContent } from "./FactoryBaleProductMonthDetailContent";

// ── Month-detail view ─────────────────────────────────────────────────────────
export function FactoryBaleProductMonthDetail() {
  const {
    navigate,
    formatAmount,
    productId,
    locationId,
    year,
    backPath,
    searchTerm,
    setSearchTerm,
    statusFilter,
    setStatusFilter,
    weightEditBale,
    setWeightEditBale,
    hiddenCost,
    isLoading,
    isError,
    responseData,
    refetch,
    data,
    sellingPricePerBale,
    filteredData,
    monthName,
    formatNumber,
    formatDateTime,
    handleWeightSuccess,
  } = useFactoryBaleProductMonthDetailState();

  if (isLoading) {
    return (
      <div className="container mx-auto p-3 sm:p-6 space-y-6">
        <Skeleton className="h-8 w-64" data-testid="skeleton-title" />
        <Skeleton className="h-[400px] w-full" data-testid="skeleton-table" />
      </div>
    );
  }

  if (isError && !responseData) {
    return (
      <div className="container mx-auto p-3 sm:p-6">
        <ErrorState onAction={() => void refetch()} actionLabel="Try again" />
      </div>
    );
  }

  return (
    <div className="container mx-auto p-3 sm:p-6 space-y-4 sm:space-y-6">
      <BaleWeightEditDialog
        bale={weightEditBale}
        onClose={() => setWeightEditBale(null)}
        onSuccess={handleWeightSuccess}
      />

      <PageHeader
        title={`Bale Details — ${monthName} ${year}`}
        backTarget={backPath}
        meta={
          <span data-testid="text-bale-count">
            <Package className="inline h-4 w-4 mr-1" />
            {data?.length || 0} bale(s)
          </span>
        }
      >
        <Button
          variant="outline"
          size="sm"
          className="shrink-0 sm:ml-auto"
          onClick={() => navigate(`/factory/bale-product-history/${productId}/${locationId}/${year}/all`)}
          data-testid="button-show-all-months"
        >
          Show All Months
        </Button>
        <RowsExportMenu
          title={`Bale Details ${monthName} ${year}`}
          sheetName="Bale Details"
          rows={filteredData}
          columns={baleHistoryExportColumns({ hiddenCost, sellingPricePerBale, formatDateTime })}
          filters={statusFilter === "all" ? undefined : [{ label: "Status", value: statusFilter }]}
          resource="factory.bales"
        />
      </PageHeader>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-lg" data-testid="text-detail-title">
            Bales for {monthName} {year}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* Filter bar */}
          <div className="flex items-center gap-2 flex-wrap">
            <SearchField
              placeholder="Search bale code or ref #..."
              value={searchTerm}
              onValueChange={setSearchTerm}
              wrapperClassName="flex-1 min-w-[180px]"
              data-testid="input-bale-search"
            />
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-[160px]" data-testid="select-status-filter">
                <SelectValue placeholder="All Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Status</SelectItem>
                <SelectItem value="IN_STOCK">In Stock</SelectItem>
                <SelectItem value="LOADING">Loading</SelectItem>
                <SelectItem value="SOLD">Sold</SelectItem>
                <SelectItem value="RESERVED_FOR_ORDER">Reserved for Order</SelectItem>
                <SelectItem value="DISPATCHED">Dispatched</SelectItem>
                <SelectItem value="DELETED">Deleted</SelectItem>
              </SelectContent>
            </Select>
            {(searchTerm || statusFilter !== "all") && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setSearchTerm("");
                  setStatusFilter("all");
                }}
                data-testid="button-clear-filters"
              >
                Clear
              </Button>
            )}
            <span className="text-sm text-muted-foreground ml-auto">{filteredData.length} bale(s)</span>
          </div>

          {/* Desktop table */}
          <FactoryBaleProductMonthDetailContent
            data={data}
            filteredData={filteredData}
            formatAmount={formatAmount}
            formatDateTime={formatDateTime}
            formatNumber={formatNumber}
            hiddenCost={hiddenCost}
            navigate={navigate}
            sellingPricePerBale={sellingPricePerBale}
            setWeightEditBale={setWeightEditBale}
          />

          {/* Mobile cards */}
          <div className="md:hidden space-y-2">
            {filteredData.map((bale) => (
              <div key={bale.id} className="p-3 rounded-md border text-sm" data-testid={`card-bale-${bale.id}`}>
                <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
                  <span className="font-medium font-mono" data-testid={`text-mobile-bale-code-${bale.id}`}>
                    {bale.baleCode}
                  </span>
                  <span data-testid={`text-mobile-status-${bale.id}`}>
                    <BaleHistoryStatusBadge bale={bale} />
                  </span>
                </div>
                <div className="text-xs mb-2">
                  <button
                    className="font-mono text-primary underline-offset-2 hover:underline cursor-pointer"
                    onClick={() => navigate(`/factory/barcode-lookup?ref=${encodeURIComponent(bale.referenceNumber)}`)}
                    data-testid={`button-ref-lookup-mobile-${bale.id}`}
                  >
                    {bale.referenceNumber}
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <div className="text-muted-foreground flex items-center gap-1">
                      Weight
                      <button
                        onClick={() =>
                          setWeightEditBale({
                            id: bale.id,
                            referenceNumber: bale.referenceNumber,
                            weightKg: bale.weightKg,
                          })
                        }
                        className="p-0.5 rounded-sm hover:bg-muted"
                        title="Correct weight"
                        data-testid={`button-edit-weight-mobile-${bale.id}`}
                      >
                        <Pencil className="h-2.5 w-2.5 text-muted-foreground" />
                      </button>
                    </div>
                    <div className="font-mono">{formatNumber(Number(bale.weightKg))} KG</div>
                  </div>
                  {!hiddenCost.includes("bale_history_cost_per_kg") && (
                    <div>
                      <div className="text-muted-foreground">Cost/KG</div>
                      <div className="font-mono">{formatAmount(bale.costPerKg)}</div>
                    </div>
                  )}
                  {!hiddenCost.includes("bale_history_total_cost") && (
                    <div>
                      <div className="text-muted-foreground">Cost Price</div>
                      <div className="font-mono">{formatAmount(bale.totalCost)}</div>
                    </div>
                  )}
                  {!hiddenCost.includes("bale_history_total_cost") && (
                    <div>
                      <div className="text-muted-foreground">Sell Price</div>
                      <div className="font-mono">
                        {sellingPricePerBale > 0 ? formatAmount(sellingPricePerBale) : "—"}
                      </div>
                    </div>
                  )}
                </div>
                <div className="text-xs text-muted-foreground mt-2">{formatDateTime(bale.createdAt)}</div>
              </div>
            ))}
            {(!data || data.length === 0) && <EmptyState title="No bales found for this month" />}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
