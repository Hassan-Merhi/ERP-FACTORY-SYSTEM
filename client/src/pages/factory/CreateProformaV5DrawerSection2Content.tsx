// Extracted from ./CreateProformaV5DrawerSection2.tsx
import type React from "react";
import { Button } from "@/components/ui/button";
import { BookmarkCheck, CheckCircle, CheckCircle2, SlidersHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCreateProformaV5DrawerState } from "./useCreateProformaV5DrawerState";

export function CreateProformaV5DrawerSection2Content({
  appliedPrice,
  applyCatalogProductionPrice,
  applyCatalogSellingPrice,
  articleRows,
  customerId,
  customerPriceListQuery,
  destination,
  draftStatus,
  garbageWipersCount,
  hideNonPositive,
  negativeCount,
  nonPositiveCount,
  productsQuery,
  setAppliedPrice,
  setHideNonPositive,
  setSellingPrices,
  setShowGarbageWipers,
  setShowNegativeOnly,
  setShowZeroItems,
  showGarbageWipers,
  showNegativeOnly,
  showZeroItems,
  zeroItemCount,
}: Pick<
  Pick<
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
  >,
  | "appliedPrice"
  | "applyCatalogProductionPrice"
  | "applyCatalogSellingPrice"
  | "articleRows"
  | "customerId"
  | "customerPriceListQuery"
  | "destination"
  | "draftStatus"
  | "garbageWipersCount"
  | "hideNonPositive"
  | "negativeCount"
  | "nonPositiveCount"
  | "productsQuery"
  | "setAppliedPrice"
  | "setHideNonPositive"
  | "setSellingPrices"
  | "setShowGarbageWipers"
  | "setShowNegativeOnly"
  | "setShowZeroItems"
  | "showGarbageWipers"
  | "showNegativeOnly"
  | "showZeroItems"
  | "zeroItemCount"
>) {
  return (
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
  );
}
