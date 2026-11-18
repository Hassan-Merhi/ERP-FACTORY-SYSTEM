// Extracted from ./CreateProformaV5Drawer.tsx to keep that module under the source-size cap.
import type React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { BookmarkCheck, CheckCircle, CheckCircle2, Container, SlidersHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCreateProformaV5DrawerState } from "./useCreateProformaV5DrawerState";

export function CreateProformaV5DrawerSection2({
  appliedPrice,
  applyCatalogProductionPrice,
  applyCatalogSellingPrice,
  articleRows,
  containerCount,
  customerId,
  customerPriceListQuery,
  customersQuery,
  destination,
  draftStatus,
  errors,
  garbageWipersCount,
  hideNonPositive,
  isActive,
  negativeCount,
  nonPositiveCount,
  productsQuery,
  proformaName,
  sendToLoading,
  setAppliedPrice,
  setContainerCount,
  setCustomerId,
  setDestination,
  setErrors,
  setHideNonPositive,
  setIsActive,
  setProformaName,
  setSellingPrices,
  setSendToLoading,
  setShowGarbageWipers,
  setShowNegativeOnly,
  setShowZeroItems,
  showGarbageWipers,
  showNegativeOnly,
  showZeroItems,
  zeroItemCount,
}: Pick<
  ReturnType<typeof useCreateProformaV5DrawerState>,
  | "appliedPrice"
  | "applyCatalogProductionPrice"
  | "applyCatalogSellingPrice"
  | "articleRows"
  | "containerCount"
  | "customerId"
  | "customerPriceListQuery"
  | "customersQuery"
  | "destination"
  | "draftStatus"
  | "errors"
  | "garbageWipersCount"
  | "hideNonPositive"
  | "isActive"
  | "negativeCount"
  | "nonPositiveCount"
  | "productsQuery"
  | "proformaName"
  | "sendToLoading"
  | "setAppliedPrice"
  | "setContainerCount"
  | "setCustomerId"
  | "setDestination"
  | "setErrors"
  | "setHideNonPositive"
  | "setIsActive"
  | "setProformaName"
  | "setSellingPrices"
  | "setSendToLoading"
  | "setShowGarbageWipers"
  | "setShowNegativeOnly"
  | "setShowZeroItems"
  | "showGarbageWipers"
  | "showNegativeOnly"
  | "showZeroItems"
  | "zeroItemCount"
>) {
  return (
    <div className="mx-3 flex flex-col gap-3 rounded-t-xl border bg-card/70 p-3.5 shadow-sm sm:mx-5 sm:p-4">
      {/* Row 1 — form fields */}
      <div className="flex flex-wrap gap-3 items-end">
        <div className="flex flex-col gap-1.5 min-w-[180px] flex-1">
          <Label htmlFor="v5-proforma-customer" className="text-xs font-medium">
            Customer <span className="text-destructive">*</span>
          </Label>
          <Select
            value={customerId}
            onValueChange={(v) => {
              setCustomerId(v);
              setErrors((p) => {
                const n = { ...p };
                delete n.customerId;
                return n;
              });
            }}
          >
            <SelectTrigger
              id="v5-proforma-customer"
              data-testid="select-v5-proforma-customer"
              className={cn(errors.customerId && "border-destructive")}
            >
              <SelectValue placeholder="Select customer…" />
            </SelectTrigger>
            <SelectContent>
              {customersQuery.isLoading && (
                <SelectItem value="__loading" disabled>
                  Loading…
                </SelectItem>
              )}
              {(customersQuery.data || []).map((c) => (
                <SelectItem key={c.id} value={String(c.id)}>
                  {c.legalName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {errors.customerId && <p className="text-xs text-destructive">{errors.customerId}</p>}
        </div>

        <div className="flex flex-col gap-1.5 min-w-[180px] flex-1">
          <Label htmlFor="v5-proforma-name" className="text-xs font-medium">
            Proforma Name <span className="text-destructive">*</span>
          </Label>
          <Input
            id="v5-proforma-name"
            data-testid="input-v5-proforma-name"
            value={proformaName}
            onChange={(e) => {
              setProformaName(e.target.value);
              setErrors((p) => {
                const n = { ...p };
                delete n.proformaName;
                return n;
              });
            }}
            placeholder="e.g. Proforma #001"
            className={cn(errors.proformaName && "border-destructive")}
          />
          {errors.proformaName && <p className="text-xs text-destructive">{errors.proformaName}</p>}
        </div>

        <div className="flex flex-col gap-1.5 min-w-[180px] flex-1">
          <Label htmlFor="v5-proforma-destination" className="text-xs font-medium">
            Destination <span className="text-destructive">*</span>
          </Label>
          <Input
            id="v5-proforma-destination"
            data-testid="input-v5-proforma-destination"
            value={destination}
            onChange={(e) => {
              setDestination(e.target.value);
              setErrors((p) => {
                const next = { ...p };
                delete next.destination;
                return next;
              });
            }}
            placeholder="e.g. L'SHI, MALI, KINSHASA"
            list="v5-proforma-destinations"
            className={cn(errors.destination && "border-destructive")}
          />
          <datalist id="v5-proforma-destinations">
            <option value="L'SHI" />
            <option value="MALI" />
            <option value="KINSHASA" />
          </datalist>
          {errors.destination && <p className="text-xs text-destructive">{errors.destination}</p>}
        </div>

        <div className="flex flex-col gap-1.5">
          <Label className="text-xs font-medium">Status</Label>
          <div className="flex items-center gap-2 h-9">
            <Switch checked={isActive} onCheckedChange={setIsActive} data-testid="switch-v5-proforma-active" />
            <span className="text-sm text-muted-foreground">{isActive ? "Active" : "Inactive"}</span>
          </div>
        </div>

        <div className="flex flex-col gap-1.5 border-l pl-3">
          <Label className="text-xs font-medium flex items-center gap-1">
            <Container className="h-3 w-3" />
            Send to Loading
          </Label>
          <div className="flex items-center gap-2 h-9">
            <Switch
              checked={sendToLoading}
              onCheckedChange={setSendToLoading}
              data-testid="switch-v5-send-to-loading"
            />
            <span className="text-sm text-muted-foreground">{sendToLoading ? "Yes" : "No"}</span>
          </div>
        </div>

        {sendToLoading && (
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs font-medium">Containers</Label>
            <Input
              type="number"
              min={1}
              max={100}
              value={containerCount}
              onChange={(e) => setContainerCount(e.target.value)}
              className="h-9 w-20 text-center"
              data-testid="input-v5-container-count"
            />
          </div>
        )}
      </div>

      {/* Row 2 — view filters + price actions (only shown when relevant) */}
      {(zeroItemCount > 0 || nonPositiveCount > 0 || negativeCount > 0 || productsQuery.data) && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
          <SlidersHorizontal className="h-3.5 w-3.5 text-muted-foreground shrink-0" />

          {zeroItemCount > 0 && (
            <Button
              size="sm"
              variant={showZeroItems ? "secondary" : "outline"}
              onClick={() => setShowZeroItems((v) => !v)}
              data-testid="button-v5-toggle-zero"
              className="h-9 rounded-full px-4 text-xs font-semibold"
            >
              {showZeroItems ? `Hide 0-stock (${zeroItemCount})` : `Show 0-stock (${zeroItemCount})`}
            </Button>
          )}

          {nonPositiveCount > 0 && (
            <Button
              size="sm"
              variant={hideNonPositive ? "default" : "outline"}
              onClick={() => {
                setHideNonPositive((v) => !v);
                setShowNegativeOnly(false);
              }}
              data-testid="button-v5-hide-non-positive"
              className="h-9 rounded-full px-4 text-xs font-semibold"
            >
              {hideNonPositive ? `Show all (${nonPositiveCount} hidden)` : `Hide 0 & neg (${nonPositiveCount})`}
            </Button>
          )}

          {negativeCount > 0 && (
            <Button
              size="sm"
              variant={showNegativeOnly ? "destructive" : "outline"}
              onClick={() => {
                setShowNegativeOnly((v) => !v);
                setHideNonPositive(false);
              }}
              data-testid="button-v5-show-negative-only"
              className="h-9 rounded-full px-4 text-xs font-semibold"
            >
              {showNegativeOnly ? `Negative Only (${negativeCount})` : `Negative Only (${negativeCount})`}
            </Button>
          )}

          {garbageWipersCount > 0 && (
            <Button
              size="sm"
              variant={showGarbageWipers ? "secondary" : "outline"}
              onClick={() => setShowGarbageWipers((v) => !v)}
              data-testid="button-v5-toggle-garbage-wipers"
              className="h-9 rounded-full px-4 text-xs font-semibold"
            >
              {showGarbageWipers
                ? `Hide Garbage/Wipers (${garbageWipersCount})`
                : `Show Garbage/Wipers (${garbageWipersCount})`}
            </Button>
          )}

          <div className="w-px h-4 bg-border mx-0.5" />

          <Button
            size="sm"
            variant={appliedPrice === "sell" ? "secondary" : "outline"}
            onClick={() => {
              applyCatalogSellingPrice();
              setAppliedPrice("sell");
            }}
            disabled={!productsQuery.data}
            data-testid="button-v5-apply-sell-price"
            className={cn(
              "h-9 rounded-full px-4 text-xs font-semibold",
              appliedPrice === "sell" && "ring-2 ring-violet-500/40"
            )}
          >
            {appliedPrice === "sell" && <CheckCircle2 className="h-3.5 w-3.5 mr-1.5 text-primary" />}
            Sell Price
          </Button>
          <Button
            size="sm"
            variant={appliedPrice === "prod" ? "secondary" : "outline"}
            onClick={() => {
              applyCatalogProductionPrice();
              setAppliedPrice("prod");
            }}
            disabled={!productsQuery.data}
            data-testid="button-v5-apply-prod-price"
            className={cn(
              "h-9 rounded-full px-4 text-xs font-semibold",
              appliedPrice === "prod" && "ring-2 ring-violet-500/40"
            )}
          >
            {appliedPrice === "prod" && <CheckCircle2 className="h-3.5 w-3.5 mr-1.5 text-primary" />}
            Prod Price
          </Button>
          {customerId && (
            <Button
              size="sm"
              variant={(appliedPrice as string) === "customer" ? "secondary" : "outline"}
              onClick={() => {
                if (!customerPriceListQuery.data?.length) {
                  return;
                }
                const priceMap = new Map(customerPriceListQuery.data.map((r) => [r.article_code, r.price_per_bale]));
                setSellingPrices((prev) => {
                  const next = { ...prev };
                  for (const row of articleRows) {
                    const agreed = priceMap.get(row.articleCode);
                    if (agreed && parseFloat(agreed) > 0) next[row.articleCode] = agreed;
                  }
                  return next;
                });
                setAppliedPrice("customer" as React.SetStateAction<"sell" | "prod" | null>);
              }}
              disabled={!destination.trim() || !customerPriceListQuery.data?.length}
              data-testid="button-v5-apply-customer-price"
              title={
                customerPriceListQuery.data?.length
                  ? `Apply ${customerPriceListQuery.data.length} agreed price(s) for ${destination}`
                  : "No agreed prices saved for this destination yet"
              }
              className={cn(
                "h-9 rounded-full px-4 text-xs font-semibold",
                (appliedPrice as string) === "customer" && "ring-2 ring-violet-500/40"
              )}
            >
              {(appliedPrice as string) === "customer" && <CheckCircle2 className="h-3.5 w-3.5 mr-1.5 text-primary" />}
              <BookmarkCheck className="h-3.5 w-3.5 mr-1.5" />
              Agreed Prices
              {customerPriceListQuery.data && customerPriceListQuery.data.length > 0 && (
                <span className="ml-1 text-[11px] opacity-70">({customerPriceListQuery.data.length})</span>
              )}
            </Button>
          )}

          {draftStatus === "saved" && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground ml-1">
              <CheckCircle className="h-3 w-3 text-green-500" />
              Draft autosaved
            </span>
          )}
        </div>
      )}
    </div>
  );
}
