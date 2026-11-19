import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, ErrorState } from "@/components/ui/page-state";
import { PageHeader } from "@/components/PageHeader";
import { RowsExportMenu } from "@/components/export/RowsExportMenu";
import { Dialog } from "@/components/ui/dialog";
import { Package, Search } from "lucide-react";
import { formatNumber, formatQty } from "./OpeningStockDetailHelpers";
import { useOpeningStockDetailState } from "./useOpeningStockDetailState";
import { OpeningStockDetailDialogContent } from "./OpeningStockDetailDialogContent";

export default function OpeningStockDetail() {
  const {
    navigate,
    selectedCompany,
    formatAmount,
    selectedItemId,
    setSelectedItemId,
    groupName,
    data,
    isLoading,
    isError,
    refetch,
    debugLoading,
    debugData,
    openingRate,
    closingRate,
    handleItemClick,
    selectedItem,
  } = useOpeningStockDetailState();

  return (
    <div className="space-y-6 sm:p-6">
      <PageHeader
        title="Stock Group Summary"
        icon={<Package className="h-5 w-5" />}
        onBack={() => navigate("/opening-stock")}
        meta={
          <span>
            {data?.stockGroup?.name || groupName} - {selectedCompany?.name}
          </span>
        }
      >
        <RowsExportMenu
          title={`Opening Stock ${data?.stockGroup?.name || groupName}`}
          sheetName="Opening Stock"
          rows={data?.items ?? []}
          columns={[
            { header: "Particulars", value: (item) => item.name },
            { header: "Unit", value: (item) => item.uom },
            { header: "Opening Quantity", value: (item) => item.opening.quantity || null, type: "number" },
            { header: "Opening Rate", value: (item) => item.opening.rate, type: "number" },
            { header: "Opening Value", value: (item) => item.opening.value || null, type: "number" },
            { header: "Closing Quantity", value: (item) => item.closing.quantity || null, type: "number" },
            { header: "Closing Rate", value: (item) => item.closing.rate, type: "number" },
            { header: "Closing Value", value: (item) => item.closing.value || null, type: "number" },
          ]}
          footer={
            data?.grandTotal
              ? [
                  "Grand Total",
                  "BL",
                  data.grandTotal.opening.quantity,
                  openingRate,
                  data.grandTotal.opening.value,
                  data.grandTotal.closing.quantity,
                  closingRate,
                  data.grandTotal.closing.value,
                ]
              : undefined
          }
          resource="erp.inventory"
        />
      </PageHeader>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          {/* Header */}
          <div className="bg-primary text-primary-foreground min-w-[560px]">
            <div className="grid grid-cols-7 p-3 font-semibold text-sm">
              <div className="col-span-1">Particulars</div>
              <div className="col-span-3 text-center border-l border-primary-foreground/30">Opening Balance</div>
              <div className="col-span-3 text-center border-l border-primary-foreground/30">Closing Balance</div>
            </div>
            <div className="grid grid-cols-7 px-3 pb-2 text-xs">
              <div></div>
              <div className="text-right">Quantity</div>
              <div className="text-right">Rate</div>
              <div className="text-right">Value</div>
              <div className="text-right border-l border-primary-foreground/30 pl-2">Quantity</div>
              <div className="text-right">Rate</div>
              <div className="text-right">Value</div>
            </div>
          </div>

          {/* Body */}
          <div className="divide-y">
            {isLoading ? (
              <div className="p-4 space-y-3">
                {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
                  <Skeleton key={i} className="h-10 w-full" />
                ))}
              </div>
            ) : isError && !data ? (
              <ErrorState onAction={() => void refetch()} actionLabel="Try again" className="m-4" />
            ) : data?.items && data.items.length > 0 ? (
              <>
                {data.items.map((item) => (
                  <div
                    key={item.id}
                    className="grid grid-cols-7 p-3 cursor-pointer hover-elevate"
                    onClick={() => handleItemClick(item.id)}
                    data-testid={`row-stock-item-${item.id}`}
                  >
                    <div className="font-medium truncate flex items-center gap-1" title={item.name}>
                      <Search className="h-3 w-3 text-muted-foreground" />
                      {item.name}
                    </div>
                    {/* Opening Balance */}
                    <div className="text-right font-mono text-sm">{formatQty(item.opening.quantity, item.uom)}</div>
                    <div className="text-right font-mono text-sm">{formatNumber(item.opening.rate)}</div>
                    <div className="text-right font-mono text-sm">
                      {item.opening.value === 0 ? "" : formatAmount(item.opening.value)}
                    </div>
                    {/* Closing Balance */}
                    <div className="text-right font-mono text-sm border-l pl-2">
                      {formatQty(item.closing.quantity, item.uom)}
                    </div>
                    <div className="text-right font-mono text-sm">{formatNumber(item.closing.rate)}</div>
                    <div className="text-right font-mono text-sm">
                      {item.closing.value === 0 ? "" : formatAmount(item.closing.value)}
                    </div>
                  </div>
                ))}
              </>
            ) : (
              <EmptyState title="No items in this stock group." className="m-4" />
            )}
          </div>

          {/* Grand Total */}
          {data?.grandTotal && (
            <div className="bg-muted/50 border-t-2 border-primary min-w-[560px]">
              <div className="grid grid-cols-7 p-3 font-bold">
                <div>Grand Total</div>
                {/* Opening Total */}
                <div className="text-right font-mono">{formatNumber(data.grandTotal.opening.quantity)} BL</div>
                <div className="text-right font-mono">{formatNumber(openingRate)}</div>
                <div className="text-right font-mono">{formatAmount(data.grandTotal.opening.value)}</div>
                {/* Closing Total */}
                <div className="text-right font-mono border-l pl-2">
                  {formatNumber(data.grandTotal.closing.quantity)} BL
                </div>
                <div className="text-right font-mono">{formatNumber(closingRate)}</div>
                <div className="text-right font-mono">{formatAmount(data.grandTotal.closing.value)}</div>
              </div>
            </div>
          )}
        </div>
      </Card>

      {/* Debug Dialog */}
      <Dialog open={!!selectedItemId} onOpenChange={(open) => !open && setSelectedItemId(null)}>
        <OpeningStockDetailDialogContent
          debugData={debugData}
          debugLoading={debugLoading}
          formatAmount={formatAmount}
          selectedItem={selectedItem}
        />
      </Dialog>
    </div>
  );
}
