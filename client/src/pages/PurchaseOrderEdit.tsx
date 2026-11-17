import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ArrowLeft, Loader2, Save, Search, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { PageHeader } from "@/components/PageHeader";
import { usePurchaseOrderEditState } from "./usePurchaseOrderEditState";
import { PurchaseOrderEditSection } from "./PurchaseOrderEditSection";
import { PurchaseOrderEditSection2 } from "./PurchaseOrderEditSection2";
import { EmptyState } from "@/components/ui/page-state";

export default function PurchaseOrderEdit() {
  const {
    activeRow,
    chargesTotal,
    containerRef,
    currency,
    discount,
    documentCharges,
    error,
    filteredStockItems,
    focusIdRef,
    freight,
    freightOwnAccountId,
    freightPaidBy,
    freightParentAccountId,
    fumigation,
    grandTotal,
    handleAddItem,
    handleBack,
    handleItemChange,
    handleRemoveItem,
    handleSave,
    handleSelectItem,
    highlightedIndex,
    isFactory,
    isFetchingNextPo,
    isLoading,
    isNew,
    items,
    itemsTotal,
    ledgerAccounts,
    lineTotals,
    navigate,
    otherCharges,
    parentFreightAccounts,
    po,
    poNumber,
    priceSymbol,
    refetchNextPo,
    searchTerm,
    setActiveRow,
    setCurrency,
    setDiscount,
    setDocumentCharges,
    setFreight,
    setFreightOwnAccountId,
    setFreightPaidBy,
    setFreightParentAccountId,
    setFumigation,
    setHighlightedIndex,
    setOtherCharges,
    setPoNumber,
    setSearchTerm,
    setShowItemSidebar,
    setSidebarTop,
    setStatus,
    setSurcharge,
    showItemSidebar,
    sidebarRef,
    sidebarTop,
    status,
    surcharge,
    syncParentJvMutation,
    totalQuantity,
    updateMutation,
  } = usePurchaseOrderEditState();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !po) {
    return (
      <div className="p-6">
        <Card>
          <CardContent className="pt-6">
            <p className="text-destructive">Failed to load purchase order. {error?.message}</p>
            <Button variant="outline" onClick={() => navigate("/daybook")} className="mt-4">
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back to Daybook
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6 sm:p-6">
      <PageHeader
        title="Edit Purchase Order"
        onBack={handleBack}
        meta={
          <span className="wrap-break-word">
            {po.supplierName} ({po.supplierCode}) | Container: {po.containerNumber}
          </span>
        }
      />

      <div className="flex flex-col sm:flex-row gap-4 relative" ref={containerRef}>
        <Card className={`flex-1 transition-all ${showItemSidebar ? "sm:mr-[340px]" : ""}`}>
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              <span>PO Details</span>
              <Badge variant={po.status === "Closed" ? "secondary" : "default"}>{po.status}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {po.currency === "ZMW" && (
              <p className="text-sm text-muted-foreground rounded-md border p-3">
                Original purchase prices and charges are in Kwacha (K). Historical USD inventory and parent-company
                costs are fixed using{" "}
                {po.historicalExchangeRate ? `K${po.historicalExchangeRate} per USD` : "an unresolved rate"}
                {po.historicalRateDate ? ` as of ${po.historicalRateDate}` : ""}. To change currency or the rate,
                reverse and rebook.
              </p>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <Label htmlFor="poNumber">PO Number</Label>
                <div className="flex gap-2">
                  <Input
                    id="poNumber"
                    value={poNumber}
                    onChange={(event) => setPoNumber(event.target.value)}
                    data-testid="input-po-number"
                    placeholder={isNew ? "Auto-generating…" : undefined}
                  />
                  {isNew && (
                    <Button
                      type="button"
                      size="icon"
                      variant="outline"
                      data-testid="button-generate-po-number"
                      title="Generate a new PO number"
                      onClick={() =>
                        refetchNextPo().then((result) => {
                          if (result.data?.poNumber) setPoNumber(result.data.poNumber);
                        })
                      }
                      disabled={isFetchingNextPo}
                    >
                      {isFetchingNextPo ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <RefreshCw className="h-4 w-4" />
                      )}
                    </Button>
                  )}
                </div>
              </div>
              <div>
                <Label htmlFor="currency">Currency</Label>
                <Select value={currency} onValueChange={setCurrency} disabled={po?.currency === "ZMW"}>
                  <SelectTrigger id="currency" data-testid="select-currency">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="USD">USD</SelectItem>
                    <SelectItem value="EUR">EUR</SelectItem>
                    <SelectItem value="GBP">GBP</SelectItem>
                    <SelectItem value="CFA">CFA</SelectItem>
                    {po?.currency === "ZMW" && <SelectItem value="ZMW">ZMW (locked)</SelectItem>}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="status">Status</Label>
                <Select value={status} onValueChange={setStatus}>
                  <SelectTrigger id="status" data-testid="select-status">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Open">Open</SelectItem>
                    <SelectItem value="Closed">Closed</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <PurchaseOrderEditSection
              activeRow={activeRow}
              containerRef={containerRef}
              filteredStockItems={filteredStockItems}
              focusIdRef={focusIdRef}
              handleAddItem={handleAddItem}
              handleItemChange={handleItemChange}
              handleRemoveItem={handleRemoveItem}
              handleSelectItem={handleSelectItem}
              highlightedIndex={highlightedIndex}
              items={items}
              itemsTotal={itemsTotal}
              lineTotals={lineTotals}
              priceSymbol={priceSymbol}
              searchTerm={searchTerm}
              setActiveRow={setActiveRow}
              setHighlightedIndex={setHighlightedIndex}
              setSearchTerm={setSearchTerm}
              setShowItemSidebar={setShowItemSidebar}
              setSidebarTop={setSidebarTop}
              showItemSidebar={showItemSidebar}
              totalQuantity={totalQuantity}
            />

            <PurchaseOrderEditSection2
              chargesTotal={chargesTotal}
              discount={discount}
              documentCharges={documentCharges}
              freight={freight}
              freightOwnAccountId={freightOwnAccountId}
              freightPaidBy={freightPaidBy}
              freightParentAccountId={freightParentAccountId}
              fumigation={fumigation}
              grandTotal={grandTotal}
              isFactory={isFactory}
              itemsTotal={itemsTotal}
              ledgerAccounts={ledgerAccounts}
              otherCharges={otherCharges}
              parentFreightAccounts={parentFreightAccounts}
              priceSymbol={priceSymbol}
              setDiscount={setDiscount}
              setDocumentCharges={setDocumentCharges}
              setFreight={setFreight}
              setFreightOwnAccountId={setFreightOwnAccountId}
              setFreightPaidBy={setFreightPaidBy}
              setFreightParentAccountId={setFreightParentAccountId}
              setFumigation={setFumigation}
              setOtherCharges={setOtherCharges}
              setSurcharge={setSurcharge}
              surcharge={surcharge}
            />
          </CardContent>
          <CardFooter className="flex flex-col-reverse sm:flex-row justify-between gap-2 flex-wrap">
            <Button
              variant="outline"
              onClick={() => syncParentJvMutation.mutate()}
              disabled={syncParentJvMutation.isPending}
              data-testid="button-sync-parent-jv"
            >
              {syncParentJvMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <RefreshCw className="h-4 w-4 mr-2" />
              )}
              Sync PO &amp; Parent JV
            </Button>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => navigate("/daybook")} data-testid="button-cancel">
                Cancel
              </Button>
              <Button onClick={handleSave} disabled={updateMutation.isPending} data-testid="button-save">
                {updateMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                ) : (
                  <Save className="h-4 w-4 mr-2" />
                )}
                Save
              </Button>
            </div>
          </CardFooter>
        </Card>

        {showItemSidebar && (
          <Card
            className="w-full sm:w-80 shrink-0 sm:absolute sm:right-0 z-10"
            style={{ top: `${sidebarTop}px` }}
            ref={sidebarRef}
          >
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <Search className="h-4 w-4" />
                Search Items
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <ScrollArea className="h-[400px]">
                <div className="p-2 space-y-1">
                  {filteredStockItems.length === 0 ? (
                    <EmptyState title="No items found" className="py-8" />
                  ) : (
                    filteredStockItems.map((item, itemIndex) => {
                      const isHighlighted = itemIndex === highlightedIndex;
                      return (
                        <button
                          key={item.id}
                          type="button"
                          className={`w-full text-left px-3 py-2 rounded-md hover-elevate active-elevate-2 ${isHighlighted ? "bg-accent" : ""}`}
                          data-testid={`button-suggest-item-${item.id}`}
                          onMouseDown={(event) => {
                            event.preventDefault();
                            handleSelectItem(item);
                          }}
                        >
                          <div className="text-sm font-medium">{item.name}</div>
                        </button>
                      );
                    })
                  )}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
