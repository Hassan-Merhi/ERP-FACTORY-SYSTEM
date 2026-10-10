import type React from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertTriangle,
  Save,
  Loader2,
  CheckCircle,
  CheckCircle2,
  Plus,
  Trash2,
  Container,
  SlidersHorizontal,
  BookmarkCheck,
  Search,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";

import type { Props } from "./createproformav5drawer/types";
import { useCreateProformaV5Model } from "./createproformav5drawer/useCreateProformaV5Model";
export default function CreateProformaV5Drawer({ open, onClose, articleRows, onSuccess }: Props) {
  const {
    customerId,
    setCustomerId,
    proformaName,
    setProformaName,
    isActive,
    setIsActive,
    quantities,
    setQuantities: _setQuantities,
    sellingPrices,
    setSellingPrices,
    sendToLoading,
    setSendToLoading,
    containerCount,
    setContainerCount,
    containerNames,
    pricingModes,
    setPricingModes,
    kgPrices,
    setKgPrices,
    draftStatus,
    appliedPrice,
    setAppliedPrice,
    errors,
    setErrors,
    showZeroItems,
    setShowZeroItems,
    hideNonPositive,
    setHideNonPositive,
    showNegativeOnly,
    setShowNegativeOnly,
    showGarbageWipers,
    setShowGarbageWipers,
    articleSearch,
    setArticleSearch,
    qtyRefs,
    customersQuery,
    productsQuery,
    customerPriceListQuery,
    createMutation,
    handleQtyChange,
    handleQtyKeyDown,
    applyCatalogSellingPrice,
    applyCatalogProductionPrice,
    updateContainerName,
    addContainer,
    removeContainer,
    handleSubmit,
    map,
    n,
    garbageWipersCount,
    totalQty,
    totalExpected,
    totalKg,
    filledLines,
    warningCount,
    zeroItemCount,
    nonPositiveCount,
    totalValue,
    negativeCount,
    visibleRows,
    visibleTotalBalance,
  } = useCreateProformaV5Model({ open, onClose, articleRows, onSuccess });

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <DialogContent
        className="max-w-[98vw] w-[98vw] h-[85dvh] sm:h-[96dvh] flex flex-col p-0 gap-0"
        data-testid="dialog-create-proforma-v5"
      >
        <DialogHeader className="px-5 py-4 border-b shrink-0">
          <DialogTitle className="text-base flex items-center gap-2">
            Create Proforma
            <Badge variant="secondary" className="text-[10px] font-semibold tracking-wide">
              v5
            </Badge>
          </DialogTitle>
        </DialogHeader>

        {/* Top fields */}
        <div className="px-5 pt-3 pb-2 border-b shrink-0 flex flex-col gap-2">
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
            <div className="flex items-center gap-1.5 flex-wrap pt-1">
              <SlidersHorizontal className="h-3.5 w-3.5 text-muted-foreground shrink-0" />

              {zeroItemCount > 0 && (
                <Button
                  size="sm"
                  variant={showZeroItems ? "secondary" : "outline"}
                  onClick={() => setShowZeroItems((v) => !v)}
                  data-testid="button-v5-toggle-zero"
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
                className={cn(appliedPrice === "sell" && "ring-2 ring-primary/40")}
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
                className={cn(appliedPrice === "prod" && "ring-2 ring-primary/40")}
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
                    const priceMap = new Map(
                      customerPriceListQuery.data.map((r) => [r.article_code, r.price_per_bale])
                    );
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
                  disabled={!customerPriceListQuery.data?.length}
                  data-testid="button-v5-apply-customer-price"
                  title={
                    customerPriceListQuery.data?.length
                      ? `Apply ${customerPriceListQuery.data.length} agreed price(s) for this customer`
                      : "No agreed prices saved for this customer yet"
                  }
                  className={cn((appliedPrice as string) === "customer" && "ring-2 ring-primary/40")}
                >
                  {(appliedPrice as string) === "customer" && (
                    <CheckCircle2 className="h-3.5 w-3.5 mr-1.5 text-primary" />
                  )}
                  <BookmarkCheck className="h-3.5 w-3.5 mr-1.5" />
                  Agreed Prices
                  {customerPriceListQuery.data && customerPriceListQuery.data.length > 0 && (
                    <span className="ml-1 text-[10px] opacity-70">({customerPriceListQuery.data.length})</span>
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

        {/* Container names panel */}
        {sendToLoading && (
          <div className="px-5 py-3 border-b shrink-0 bg-muted/20">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-medium text-muted-foreground">Container names — click to rename</p>
              <Button size="sm" variant="outline" onClick={addContainer} data-testid="button-v5-add-container">
                <Plus className="h-3.5 w-3.5 mr-1" />
                Add
              </Button>
            </div>
            {errors.containers && <p className="text-xs text-destructive mb-1">{errors.containers}</p>}
            <div className="flex flex-wrap gap-2 max-h-32 overflow-auto">
              {containerNames.map((name, idx) => (
                <div key={idx} className="flex items-center gap-1 bg-background border rounded-md px-2 py-1">
                  <Container className="h-3 w-3 text-muted-foreground shrink-0" />
                  <Input
                    value={name}
                    onChange={(e) => updateContainerName(idx, e.target.value)}
                    className="h-6 text-xs border-0 p-0 w-28 bg-transparent focus-visible:ring-0"
                    data-testid={`input-v5-container-name-${idx}`}
                  />
                  {containerNames.length > 1 && (
                    <button
                      onClick={() => removeContainer(idx)}
                      className="text-muted-foreground/60 hover-elevate rounded-sm"
                      data-testid={`button-v5-remove-container-${idx}`}
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {errors.lines && (
          <div className="px-5 py-2 bg-destructive/10 border-b shrink-0">
            <p className="text-xs text-destructive">{errors.lines}</p>
          </div>
        )}

        {/* Search bar */}
        <div className="px-5 py-2 border-b shrink-0">
          <div className="relative max-w-xs">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <Input
              value={articleSearch}
              onChange={(e) => setArticleSearch(e.target.value)}
              placeholder="Search product or code…"
              className="pl-8 h-8 text-sm"
              data-testid="input-v5-create-search"
            />
            {articleSearch && (
              <button
                onClick={() => setArticleSearch("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover-elevate rounded-sm"
                data-testid="button-v5-create-clear-search"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Table */}
        <div className="flex-1 overflow-auto">
          <table className="w-full text-sm border-collapse min-w-max">
            <thead>
              <tr className="bg-muted sticky top-0 z-30">
                <th className="text-left px-3 py-2 font-medium border-b border-r whitespace-nowrap min-w-[200px] sticky left-0 bg-muted z-20">
                  Product
                </th>
                <th className="text-right px-3 py-2 font-medium border-b border-r whitespace-nowrap min-w-[130px]">
                  Available Balance
                </th>
                <th className="text-center px-3 py-2 font-medium border-b border-r whitespace-nowrap min-w-[110px]">
                  Qty / Container
                </th>
                <th className="text-right px-3 py-2 font-medium border-b border-r whitespace-nowrap min-w-[90px] text-muted-foreground">
                  Total KG
                </th>
                {sendToLoading && n > 0 && (
                  <th className="text-right px-3 py-2 font-medium border-b border-r whitespace-nowrap min-w-[110px] text-amber-600 dark:text-amber-400">
                    Expected Total ({n}×)
                  </th>
                )}
                <th className="text-center px-3 py-2 font-medium border-b whitespace-nowrap min-w-[130px]">Price</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row, idx) => {
                const rawVal = quantities[row.articleCode] ?? "";
                const parsed = parseInt(rawVal);
                const qty = isNaN(parsed) ? 0 : parsed;
                const request = sendToLoading && n > 0 ? qty * n : qty;
                const balance = row.stockAvailable - row.totalLoaded - request;
                const shortage = request > 0 && balance < 0;
                const shortBy = Math.abs(balance);
                const hasError = !!errors[`qty_${row.articleCode}`];

                return (
                  <tr
                    key={row.articleCode}
                    className={cn(
                      "border-b transition-colors",
                      idx % 2 === 0 ? "bg-background" : "bg-muted/20",
                      qty > 0 && "bg-blue-50/30 dark:bg-blue-950/20"
                    )}
                    data-testid={`row-v5-create-${row.articleCode}`}
                  >
                    <td className="px-3 py-1.5 border-r sticky left-0 bg-inherit z-10">
                      <div className="font-medium truncate max-w-[220px] text-xs leading-tight" title={row.productName}>
                        {row.productName}
                      </div>
                      <div className="text-[10px] text-muted-foreground font-mono">{row.articleCode}</div>
                    </td>

                    <td
                      className={cn(
                        "px-3 py-1.5 border-r text-right font-mono tabular-nums text-xs font-semibold",
                        row.freeToPromise < 0
                          ? "text-destructive"
                          : row.freeToPromise === 0
                            ? "text-muted-foreground"
                            : "text-green-700 dark:text-green-400"
                      )}
                    >
                      {row.freeToPromise < 0 && <AlertTriangle className="inline h-3 w-3 mr-0.5 mb-0.5" />}
                      {row.freeToPromise > 0 ? `+${row.freeToPromise}` : row.freeToPromise}
                    </td>

                    <td className="px-2 py-1 border-r">
                      <div className="flex flex-col gap-0.5 items-center">
                        <Input
                          ref={(el) => {
                            qtyRefs.current[idx] = el;
                          }}
                          type="number"
                          min={0}
                          value={rawVal}
                          onChange={(e) => handleQtyChange(row.articleCode, e.target.value)}
                          onKeyDown={(e) => handleQtyKeyDown(e, idx)}
                          onFocus={(e) => e.target.select()}
                          placeholder="0"
                          className={cn(
                            "h-7 text-center text-xs font-mono w-20 px-1 tabular-nums",
                            hasError && "border-destructive",
                            shortage && !hasError && "border-amber-400 dark:border-amber-500",
                            qty > 0 && !shortage && !hasError && "border-blue-400 dark:border-blue-500"
                          )}
                          data-testid={`input-v5-qty-${row.articleCode}`}
                        />
                        {hasError && (
                          <span className="text-[10px] text-destructive">{errors[`qty_${row.articleCode}`]}</span>
                        )}
                        {shortage && !hasError && (
                          <span className="text-[10px] text-amber-600 dark:text-amber-400 flex items-center gap-0.5 whitespace-nowrap">
                            <AlertTriangle className="h-2.5 w-2.5" />
                            short {shortBy}
                          </span>
                        )}
                      </div>
                    </td>

                    {/* Total KG */}
                    {(() => {
                      const product = map.get(row.articleCode);
                      const weightPerBale = parseFloat(product?.weightPerBaleKg || "0");
                      const rowKg = qty > 0 && weightPerBale > 0 ? qty * weightPerBale : null;
                      return (
                        <td className="px-3 py-1.5 border-r text-right font-mono tabular-nums text-xs text-muted-foreground">
                          {rowKg != null ? (
                            <span className="text-foreground font-medium">
                              {rowKg.toLocaleString(undefined, { maximumFractionDigits: 1 })} kg
                            </span>
                          ) : (
                            <span className="text-muted-foreground/40">—</span>
                          )}
                        </td>
                      );
                    })()}

                    {sendToLoading && n > 0 && (
                      <td
                        className={cn(
                          "px-3 py-1.5 border-r text-right font-mono tabular-nums text-xs font-semibold",
                          shortage
                            ? "text-destructive"
                            : request > 0
                              ? "text-amber-600 dark:text-amber-400"
                              : "text-muted-foreground/40"
                        )}
                      >
                        {request > 0 ? (
                          <span className="flex items-center justify-end gap-1">
                            {shortage && <AlertTriangle className="h-3 w-3" />}
                            {request}
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                    )}

                    <td className="px-2 py-1">
                      {(() => {
                        const mode = pricingModes[row.articleCode] ?? "per_bale";
                        return (
                          <div className="flex items-center gap-1">
                            <div className="flex rounded-sm border shrink-0 overflow-hidden text-[9px] font-semibold">
                              <button
                                className={cn(
                                  "px-1.5 py-0.5 transition-colors",
                                  mode === "per_bale"
                                    ? "bg-primary text-primary-foreground"
                                    : "text-muted-foreground hover:bg-muted"
                                )}
                                onClick={() => setPricingModes((prev) => ({ ...prev, [row.articleCode]: "per_bale" }))}
                                data-testid={`button-v5-mode-bale-${row.articleCode}`}
                                title="Price per bale"
                              >
                                /bale
                              </button>
                              <button
                                className={cn(
                                  "px-1.5 py-0.5 transition-colors",
                                  mode === "per_kg"
                                    ? "bg-primary text-primary-foreground"
                                    : "text-muted-foreground hover:bg-muted"
                                )}
                                onClick={() => setPricingModes((prev) => ({ ...prev, [row.articleCode]: "per_kg" }))}
                                data-testid={`button-v5-mode-kg-${row.articleCode}`}
                                title="Price per kg"
                              >
                                /kg
                              </button>
                            </div>
                            {mode === "per_kg" ? (
                              <Input
                                type="number"
                                min={0}
                                step="0.001"
                                value={kgPrices[row.articleCode] ?? ""}
                                onChange={(e) =>
                                  setKgPrices((prev) => ({ ...prev, [row.articleCode]: e.target.value }))
                                }
                                onFocus={(e) => e.target.select()}
                                placeholder="0.000"
                                className="h-7 text-right text-xs font-mono w-20 px-2 tabular-nums"
                                data-testid={`input-v5-kgprice-${row.articleCode}`}
                              />
                            ) : (
                              <Input
                                type="number"
                                min={0}
                                step="0.01"
                                value={sellingPrices[row.articleCode] ?? ""}
                                onChange={(e) =>
                                  setSellingPrices((prev) => ({ ...prev, [row.articleCode]: e.target.value }))
                                }
                                onFocus={(e) => e.target.select()}
                                placeholder="0.00"
                                className="h-7 text-right text-xs font-mono w-20 px-2 tabular-nums"
                                data-testid={`input-v5-price-${row.articleCode}`}
                              />
                            )}
                          </div>
                        );
                      })()}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="bg-muted border-t-2 sticky bottom-0 z-20 text-xs font-semibold">
                <td className="px-3 py-2 border-r sticky left-0 bg-muted z-10">
                  <span className="text-foreground">Totals</span>
                  <span className="font-normal text-muted-foreground ml-1.5">({visibleRows.length} products)</span>
                </td>
                <td
                  className={cn(
                    "px-3 py-2 border-r text-right font-mono tabular-nums",
                    visibleTotalBalance < 0
                      ? "text-destructive"
                      : visibleTotalBalance > 0
                        ? "text-green-700 dark:text-green-400"
                        : "text-muted-foreground"
                  )}
                >
                  {visibleTotalBalance > 0 ? `+${visibleTotalBalance}` : visibleTotalBalance}
                </td>
                <td className="px-3 py-2 border-r text-center font-mono tabular-nums text-foreground">
                  {totalQty > 0 ? totalQty : <span className="text-muted-foreground/40">—</span>}
                </td>
                <td className="px-3 py-2 border-r text-right font-mono tabular-nums text-muted-foreground">
                  {totalKg > 0 ? (
                    <span className="text-foreground">
                      {totalKg.toLocaleString(undefined, { maximumFractionDigits: 1 })} kg
                    </span>
                  ) : (
                    <span className="text-muted-foreground/40">—</span>
                  )}
                </td>
                {sendToLoading && n > 0 && (
                  <td className="px-3 py-2 border-r text-right font-mono tabular-nums text-amber-600 dark:text-amber-400">
                    {totalExpected > 0 ? totalExpected : <span className="text-muted-foreground/40">—</span>}
                  </td>
                )}
                <td className="px-3 py-2 text-right font-mono tabular-nums text-foreground">
                  {totalValue > 0 ? (
                    `$${totalValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                  ) : (
                    <span className="text-muted-foreground/40">—</span>
                  )}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t bg-muted/30 shrink-0 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-4 text-xs text-muted-foreground flex-wrap">
            <span>
              <span className="font-semibold text-foreground">{filledLines}</span> line{filledLines !== 1 ? "s" : ""}
            </span>
            <span>
              <span className="font-semibold text-foreground">{totalQty}</span> bales/container
            </span>
            {totalKg > 0 && (
              <span>
                <span className="font-semibold text-foreground">
                  {totalKg.toLocaleString(undefined, { maximumFractionDigits: 1 })}
                </span>{" "}
                kg
              </span>
            )}
            {sendToLoading && n > 0 && (
              <span className="text-amber-600 dark:text-amber-400">
                <span className="font-semibold">{totalExpected}</span> total expected ({n} container{n !== 1 ? "s" : ""}
                )
              </span>
            )}
            {warningCount > 0 && (
              <span className="flex items-center gap-1 text-destructive">
                <AlertTriangle className="h-3 w-3" />
                {warningCount} product{warningCount !== 1 ? "s" : ""} with shortage
              </span>
            )}
            <span className="text-[10px] text-muted-foreground/60">Ctrl/⌘+S to save</span>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="default" onClick={onClose} data-testid="button-v5-cancel-proforma">
              Cancel
            </Button>
            <Button
              size="default"
              onClick={handleSubmit}
              disabled={createMutation.isPending}
              data-testid="button-v5-create-proforma-submit"
            >
              {createMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Creating…
                </>
              ) : (
                <>
                  <Save className="h-4 w-4 mr-2" />
                  {sendToLoading ? `Create + ${n} Container${n !== 1 ? "s" : ""}` : "Create Proforma"}
                </>
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
