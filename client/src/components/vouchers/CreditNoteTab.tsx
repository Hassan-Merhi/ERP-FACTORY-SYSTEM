import { SearchField } from "@/components/ui/search-field";
import { formatNumber } from "@/lib/formatNumber";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MapPin } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CreditNoteTabProps } from "./CreditNoteTabTypes";
import { useCreditNoteTabState } from "./useCreditNoteTabState";
import { CreditNoteTabCardSection } from "./CreditNoteTabCardSection";

export function CreditNoteTab(props: CreditNoteTabProps) {
  const {
    addItemToCart,
    allAccounts,
    cashAccountId,
    cashAccountName,
    cashAccountType,
    editLoading,
    filteredItems,
    form,
    highlightedIndex,
    isEditMode,
    isPending,
    itemListRef,
    itemQuantity,
    items,
    locations,
    noteCurrency,
    noteType,
    onSubmit,
    refundRate,
    removeItem,
    searchInputRef,
    searchTerm,
    selectedLocationId,
    setHighlightedIndex,
    setItemQuantity,
    setRefundRate,
    setSearchTerm,
    setSelectedLocationId,
    totalInventoryValue,
    totalRefund,
    totalRefundUsd,
    updateItemInventoryCost,
  } = useCreditNoteTabState(props);

  if (editLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-muted-foreground">Loading credit note...</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col lg:flex-row gap-4 lg:h-[calc(100dvh-200px)]">
      <CreditNoteTabCardSection
        allAccounts={allAccounts}
        cashAccountId={cashAccountId}
        cashAccountName={cashAccountName}
        cashAccountType={cashAccountType}
        form={form}
        isEditMode={isEditMode}
        isPending={isPending}
        items={items}
        noteCurrency={noteCurrency}
        noteType={noteType}
        onSubmit={onSubmit}
        removeItem={removeItem}
        totalInventoryValue={totalInventoryValue}
        totalRefund={totalRefund}
        totalRefundUsd={totalRefundUsd}
        updateItemInventoryCost={updateItemInventoryCost}
      />

      <Card className="w-full lg:w-80 flex flex-col">
        <CardHeader className="pb-3 shrink-0">
          <div className="flex items-center gap-2 mb-3">
            <MapPin className="h-4 w-4" />
            <span className="font-medium text-sm">Location</span>
          </div>
          <Select
            value={selectedLocationId?.toString() || ""}
            onValueChange={(value) => {
              setSelectedLocationId(parseInt(value));
              setSearchTerm("");
              setHighlightedIndex(0);
            }}
          >
            <SelectTrigger data-testid="select-location">
              <SelectValue placeholder="Choose location..." />
            </SelectTrigger>
            <SelectContent>
              {locations.map((location) => (
                <SelectItem key={location.id} value={location.id.toString()}>
                  {location.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="mt-3">
            <SearchField
              ref={searchInputRef}
              value={searchTerm}
              onValueChange={setSearchTerm}
              placeholder="Search items..."
              data-testid="input-search-item"
            />
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Qty</label>
              <Input
                type="number"
                step="1"
                value={itemQuantity}
                onChange={(event) => setItemQuantity(event.target.value)}
                placeholder="1"
                data-testid="input-item-quantity"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Refund Rate</label>
              <Input
                type="number"
                step="0.01"
                value={refundRate}
                onChange={(event) => setRefundRate(event.target.value)}
                placeholder="Auto"
                data-testid="input-refund-rate"
              />
            </div>
          </div>
        </CardHeader>
        {/* Phones bound the item picker so a long catalogue does not push the voucher away. */}
        <CardContent className="flex-1 overflow-hidden p-0 max-sm:h-[min(60dvh,28rem)] max-sm:flex-none">
          <ScrollArea className="h-full">
            <div ref={itemListRef} className="p-2 space-y-1">
              {filteredItems.length === 0 ? (
                <div className="text-center py-4 text-muted-foreground text-sm">
                  {searchTerm ? "No items match your search" : "No stock items found"}
                </div>
              ) : (
                filteredItems.map((item, index) => {
                  const isHighlighted = index === highlightedIndex;
                  return (
                    <div
                      key={item.id}
                      data-index={index}
                      className={cn(
                        "p-3 rounded-md cursor-pointer border transition-colors",
                        isHighlighted ? "bg-primary/10 border-primary" : "hover:bg-accent border-transparent"
                      )}
                      onClick={() => addItemToCart(item)}
                      data-testid={`item-${item.id}`}
                    >
                      <div className="flex justify-between items-start">
                        <div className="flex-1 min-w-0">
                          <p className="font-medium truncate text-sm">{item.name}</p>
                          <p className="text-xs text-muted-foreground">{item.code}</p>
                        </div>
                        <Badge variant={item.stockQty > 0 ? "default" : "secondary"} className="ml-2 shrink-0">
                          {formatNumber(item.stockQty, 0)} {item.uom}
                        </Badge>
                      </div>
                      {item.avgRate > 0 && (
                        <div className="mt-1 text-xs text-muted-foreground">Avg Cost: {formatNumber(item.avgRate)}</div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}
