import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useSalesReportDetailModel } from "./salesreportdetail/useSalesReportDetailModel";
import { SalesReportDetailHeader } from "./salesreportdetail/components/SalesReportDetailHeader";
import { SalesReportSummaryCards } from "./salesreportdetail/components/SalesReportSummaryCards";
import { SalesReportItemMobileView } from "./salesreportdetail/components/SalesReportItemMobileView";
import { SalesReportBySaleView } from "./salesreportdetail/components/SalesReportBySaleView";
import { SalesReportItemsView } from "./salesreportdetail/components/SalesReportItemsView";

export default function SalesReportDetail() {
  const {
    handleBack,
    formatAmount,
    plFilter,
    setPlFilter,
    plBasis,
    setPlBasis,
    expandedItems,
    setExpandedItems,
    expandedLocations,
    setExpandedLocations,
    viewMode,
    setViewMode,
    expandedVouchers,
    setExpandedVouchers,
    ITEM_COLUMNS,
    hiddenColumns,
    setHiddenColumns,
    col,
    toggleColumn,
    displayDate,
    grouping,
    allCompanies: _allCompanies,
    isCreditSaleParam,
    searchTerm,
    items,
    isLoading,
    filteredItems: _filteredItems,
    itemGroups,
    locationColorMap,
    multipleLocations,
    toggleItem,
    toggleLocation,
    creditCustomerLabel,
    totalQty,
    totalSales,
    totalCost,
    totalConfiguredCost,
    costProfit,
    configuredProfit,
    voucherGroups,
    toggleVoucher,
  } = useSalesReportDetailModel();

  return (
    <div className="flex flex-col gap-4 p-3 sm:p-6 w-full min-w-0">
      <SalesReportDetailHeader
        handleBack={handleBack}
        displayDate={displayDate}
        isCreditSaleParam={isCreditSaleParam}
        creditCustomerLabel={creditCustomerLabel}
        grouping={grouping}
        searchTerm={searchTerm}
        plFilter={plFilter}
        setPlFilter={setPlFilter}
        viewMode={viewMode}
        setViewMode={setViewMode}
        voucherGroups={voucherGroups}
        expandedVouchers={expandedVouchers}
        setExpandedVouchers={setExpandedVouchers}
        itemGroups={itemGroups}
        expandedItems={expandedItems}
        setExpandedItems={setExpandedItems}
        setExpandedLocations={setExpandedLocations}
        hiddenColumns={hiddenColumns}
        setHiddenColumns={setHiddenColumns}
        ITEM_COLUMNS={ITEM_COLUMNS}
        toggleColumn={toggleColumn}
        plBasis={plBasis}
        setPlBasis={setPlBasis}
      />

      {isLoading ? (
        <div className="space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-20" />
            ))}
          </div>
          <Skeleton className="h-64" />
        </div>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            No sales data found for this period.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          <SalesReportSummaryCards
            totalQty={totalQty}
            totalSales={totalSales}
            totalCost={totalCost}
            costProfit={costProfit}
            totalConfiguredCost={totalConfiguredCost}
            configuredProfit={configuredProfit}
            formatAmount={formatAmount}
          />

          {/* By-Sale table */}
          {viewMode === "bySale" && (
            <SalesReportBySaleView
              voucherGroups={voucherGroups}
              expandedVouchers={expandedVouchers}
              toggleVoucher={toggleVoucher}
              col={col}
              plFilter={plFilter}
              formatAmount={formatAmount}
            />
          )}

          {/* Item-grouped table */}
          {viewMode === "items" && (
            <Card>
              <CardContent className="p-0">
                <SalesReportItemsView
                  itemGroups={itemGroups}
                  expandedItems={expandedItems}
                  toggleItem={toggleItem}
                  expandedLocations={expandedLocations}
                  toggleLocation={toggleLocation}
                  locationColorMap={locationColorMap}
                  multipleLocations={multipleLocations}
                  col={col}
                  plFilter={plFilter}
                  totalQty={totalQty}
                  totalSales={totalSales}
                  totalCost={totalCost}
                  totalConfiguredCost={totalConfiguredCost}
                  costProfit={costProfit}
                  configuredProfit={configuredProfit}
                  formatAmount={formatAmount}
                />

                <SalesReportItemMobileView
                  itemGroups={itemGroups}
                  expandedItems={expandedItems}
                  toggleItem={toggleItem}
                  multipleLocations={multipleLocations}
                  locationColorMap={locationColorMap}
                  formatAmount={formatAmount}
                  expandedLocations={expandedLocations}
                  toggleLocation={toggleLocation}
                />
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
