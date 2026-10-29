import type React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertTriangle,
  FilePlus2,
  Package,
  Boxes,
  Truck,
  Scale,
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
    catalogFilter,
    setCatalogFilter,
    catalogCategories,
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
    <div className="flex min-w-0 flex-col bg-background pb-5" data-testid="page-create-proforma-v5">
        <section className="px-3 pb-3 pt-5 sm:px-5">
          <div className="flex items-center gap-3"><div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-violet-500/30 bg-violet-500/15 text-violet-500"><FilePlus2 className="h-6 w-6" /></div><div><h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Create Proforma</h1><p className="mt-0.5 text-sm text-muted-foreground">Stock Allocation</p></div></div>
          <div className="mt-5 grid grid-cols-2 gap-2.5 lg:grid-cols-3 xl:grid-cols-5"><div className="flex min-w-0 items-center gap-3 rounded-xl border border-violet-500/25 bg-violet-500/[0.07] p-3.5 shadow-sm"><Package className="hidden h-9 w-9 shrink-0 rounded-lg bg-violet-500/15 p-2 text-violet-500 sm:block" /><div className="min-w-0"><p className="text-xs text-muted-foreground">Total Products</p><p className="mt-1 text-2xl font-bold tabular-nums text-violet-500">{visibleRows.length.toLocaleString()}</p></div></div>
<div className="flex min-w-0 items-center gap-3 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.07] p-3.5 shadow-sm"><Boxes className="hidden h-9 w-9 shrink-0 rounded-lg bg-emerald-500/15 p-2 text-emerald-500 sm:block" /><div className="min-w-0"><p className="text-xs text-muted-foreground">Qty / Container</p><p className="mt-1 text-2xl font-bold tabular-nums text-emerald-500">{totalQty.toLocaleString()}</p></div></div>
<div className="flex min-w-0 items-center gap-3 rounded-xl border border-amber-500/25 bg-amber-500/[0.07] p-3.5 shadow-sm"><Truck className="hidden h-9 w-9 shrink-0 rounded-lg bg-amber-500/15 p-2 text-amber-500 sm:block" /><div className="min-w-0"><p className="text-xs text-muted-foreground">Expected to Load</p><p className="mt-1 text-2xl font-bold tabular-nums text-amber-500">{totalExpected.toLocaleString()}</p></div></div>
<div className="flex min-w-0 items-center gap-3 rounded-xl border border-sky-500/25 bg-sky-500/[0.07] p-3.5 shadow-sm"><Scale className="hidden h-9 w-9 shrink-0 rounded-lg bg-sky-500/15 p-2 text-sky-500 sm:block" /><div className="min-w-0"><p className="text-xs text-muted-foreground">Total KG</p><p className="mt-1 text-2xl font-bold tabular-nums text-sky-500">{totalKg.toLocaleString()}</p></div></div>
<div className="col-span-2 lg:col-span-1 flex min-w-0 items-center gap-3 rounded-xl border border-rose-500/25 bg-rose-500/[0.07] p-3.5 shadow-sm"><AlertTriangle className="hidden h-9 w-9 shrink-0 rounded-lg bg-rose-500/15 p-2 text-rose-500 sm:block" /><div className="min-w-0"><p className="text-xs text-muted-foreground">Shortages</p><p className="mt-1 text-2xl font-bold tabular-nums text-rose-500">{warningCount.toLocaleString()}</p></div></div></div>
        </section>

        {/* Top fields */}
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
                className={cn("h-9 rounded-full px-4 text-xs font-semibold", appliedPrice === "sell" && "ring-2 ring-violet-500/40")}
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
                className={cn("h-9 rounded-full px-4 text-xs font-semibold", appliedPrice === "prod" && "ring-2 ring-violet-500/40")}
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
                  className={cn("h-9 rounded-full px-4 text-xs font-semibold", (appliedPrice as string) === "customer" && "ring-2 ring-violet-500/40")}
                >
                  {(appliedPrice as string) === "customer" && (
                    <CheckCircle2 className="h-3.5 w-3.5 mr-1.5 text-primary" />
                  )}
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
                <div key={idx} className="flex items-center gap-1 bg-background border rounded-md px-2 py-2.5">
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
        <div className="mx-3 flex flex-wrap items-end gap-3 border-x border-b bg-card/70 px-3.5 py-3 sm:mx-5 sm:px-4">
          <div className="relative w-full sm:w-72">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <Input
              value={articleSearch}
              onChange={(e) => setArticleSearch(e.target.value)}
              placeholder="Search product name or code..."
              className="h-10 rounded-lg pl-8 text-sm"
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
          <div className="w-full sm:w-56">
            <Label className="mb-1 block text-xs font-medium">Catalog</Label>
            <Select value={catalogFilter} onValueChange={setCatalogFilter}>
              <SelectTrigger className="h-10 rounded-lg" data-testid="select-v5-create-catalog">
                <SelectValue placeholder="All Catalogs" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All Catalogs</SelectItem>
                {catalogCategories.map((category) => (
                  <SelectItem key={category} value={category}>{category}</SelectItem>
                ))}
                {articleRows.some((row) => !row.categoryName?.trim()) && (
                  <SelectItem value="__uncategorized__">Uncategorized</SelectItem>
                )}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Table */}
        <div className="mx-3 min-w-0 overflow-x-auto rounded-b-xl border border-t-0 bg-card shadow-sm sm:mx-5">
          <table className="w-full min-w-[1120px] table-fixed border-collapse text-sm">
            <colgroup>
              {sendToLoading && n > 0 ? (<><col style={{ width: "25%" }} /><col style={{ width: "10%" }} /><col style={{ width: "14%" }} /><col style={{ width: "12%" }} /><col style={{ width: "11%" }} /><col style={{ width: "12%" }} /><col style={{ width: "16%" }} /></>) : (<><col style={{ width: "27%" }} /><col style={{ width: "10%" }} /><col style={{ width: "16%" }} /><col style={{ width: "14%" }} /><col style={{ width: "13%" }} /><col style={{ width: "20%" }} /></>)}
            </colgroup>
            <thead><tr className="sticky top-0 z-30 bg-slate-100 text-slate-700 dark:bg-slate-800/95 dark:text-slate-200">
                <th className="sticky left-0 z-20 border-b border-r bg-slate-100 px-4 py-3 text-left text-xs font-semibold dark:bg-slate-800/95">Product</th><th className="border-b border-r px-3 py-3 text-left text-xs font-semibold">Code</th>
                <th className="border-b border-r px-2 py-3 text-center text-xs font-semibold whitespace-nowrap">
                  Available Balance
                </th>
                <th className="border-b border-r px-2 py-3 text-center text-xs font-semibold whitespace-nowrap">
                  Qty / Container
                </th>
                <th className="border-b border-r px-2 py-3 text-center text-xs font-semibold whitespace-nowrap text-muted-foreground">
                  Total KG
                </th>
                {sendToLoading && n > 0 && (
                  <th className="border-b border-r px-2 py-3 text-center text-xs font-semibold whitespace-nowrap text-amber-600 dark:text-amber-400">
                    Expected Total ({n}×)
                  </th>
                )}
                <th className="border-b px-2 py-3 text-center text-xs font-semibold whitespace-nowrap">Price</th>
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
                      idx % 2 === 0 ? "bg-card" : "bg-muted/25",
                      qty > 0 && "bg-violet-500/[0.06]"
                    )}
                    data-testid={`row-v5-create-${row.articleCode}`}
                  >
                    <td className="sticky left-0 z-10 border-r bg-inherit px-4 py-2.5"><div className="flex min-w-0 items-center gap-2">{row.freeToPromise < 0 && <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-rose-500" />}<span className="block truncate text-xs font-semibold sm:text-sm" title={row.productName}>{row.productName}</span></div></td>
                    <td className="border-r px-3 py-2.5 font-mono text-xs text-muted-foreground" title={row.articleCode}>{row.articleCode}</td>

                    <td
                      className={cn(
                        "border-r px-2 py-2.5 text-center font-mono tabular-nums text-xs font-semibold",
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

                    <td className="border-r px-2 py-2.5">
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
                          <span className="text-[11px] text-destructive">{errors[`qty_${row.articleCode}`]}</span>
                        )}
                        {shortage && !hasError && (
                          <span className="text-[11px] text-amber-600 dark:text-amber-400 flex items-center gap-0.5 whitespace-nowrap">
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
                        <td className="border-r px-2 py-2.5 text-center font-mono tabular-nums text-xs text-muted-foreground">
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
                          "border-r px-2 py-2.5 text-center font-mono tabular-nums text-xs font-semibold",
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

                    <td className="px-2 py-2.5">
                      {(() => {
                        const mode = pricingModes[row.articleCode] ?? "per_bale";
                        return (
                          <div className="flex items-center gap-1">
                            <div className="flex rounded-sm border shrink-0 overflow-hidden text-[11px] font-semibold">
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
              <tr className="sticky bottom-0 z-20 border-t-2 bg-slate-100 text-xs font-semibold dark:bg-slate-800">
<td className="sticky left-0 z-10 border-r bg-slate-100 px-4 py-3 dark:bg-slate-800"><span className="text-foreground">Totals</span><span className="ml-1.5 font-normal text-muted-foreground">({visibleRows.length} products)</span></td>
                <td className="border-r px-3 py-3 text-xs text-muted-foreground">Total</td>
                <td
                  className={cn(
                    "border-r px-2 py-3 text-center font-mono tabular-nums",
                    visibleTotalBalance < 0
                      ? "text-destructive"
                      : visibleTotalBalance > 0
                        ? "text-green-700 dark:text-green-400"
                        : "text-muted-foreground"
                  )}
                >
                  {visibleTotalBalance > 0 ? `+${visibleTotalBalance}` : visibleTotalBalance}
                </td>
                <td className="border-r px-2 py-3 text-center font-mono tabular-nums text-foreground">
                  {totalQty > 0 ? totalQty : <span className="text-muted-foreground/40">—</span>}
                </td>
                <td className="border-r px-2 py-3 text-center font-mono tabular-nums text-muted-foreground">
                  {totalKg > 0 ? (
                    <span className="text-foreground">
                      {totalKg.toLocaleString(undefined, { maximumFractionDigits: 1 })} kg
                    </span>
                  ) : (
                    <span className="text-muted-foreground/40">—</span>
                  )}
                </td>
                {sendToLoading && n > 0 && (
                  <td className="border-r px-2 py-3 text-center font-mono tabular-nums text-amber-600 dark:text-amber-400">
                    {totalExpected > 0 ? totalExpected : <span className="text-muted-foreground/40">—</span>}
                  </td>
                )}
                <td className="px-2 py-3 text-center font-mono tabular-nums text-foreground">
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
        <div className="mx-3 mt-3 flex flex-wrap items-center justify-between gap-4 rounded-xl border bg-card/90 px-4 py-3 shadow-sm sm:mx-5">
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
            <span className="text-[11px] text-muted-foreground/60">Ctrl/⌘+S to save</span>
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
              className="bg-violet-600 text-white hover:bg-violet-700"
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
    </div>
  );
}
