import { duoMobileText } from "@/i18n/iphoneDuoMobileTranslations";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ChevronDown, ListOrdered, Plus, X } from "lucide-react";
import type { EmbeddablePageProps } from "./FactoryMonthlyProductionMatrixCurrentMonth";
import { useFactoryMonthlyProductionMatrixState } from "./useFactoryMonthlyProductionMatrixState";
import { FactoryMonthlyProductionMatrixSection } from "./FactoryMonthlyProductionMatrixSection";
import { FactoryMonthlyProductionMatrixDialogSection } from "./FactoryMonthlyProductionMatrixDialogSection";
import { SearchField } from "@/components/ui/search-field";

/** `embedded`: rendered as the Overview hub "Monthly Production" tab, whose PageHeader already titles the page. */
export default function FactoryMonthlyProductionMatrix(props: EmbeddablePageProps) {
  const {
    addMonth,
    byId,
    canReorder,
    categories,
    currentPosition,
    data,
    destinationId,
    draggingId,
    embedded,
    error,
    headerActions,
    isLoading,
    language,
    mhd,
    mode,
    monthLabel,
    months,
    moveItemId,
    moveMatches,
    moveNextToItem,
    moveOne,
    moveRowNumber,
    moveSearch,
    moveToPosition,
    movingProduct,
    openMoveDialog,
    openWorkerBreakdown,
    orderedProducts,
    overallTotal,
    parsedMoveRow,
    pickedMonth,
    pickedMonths,
    recordChanges,
    refetch,
    reorder,
    rowPositionById,
    rowTotal,
    saving,
    search,
    selectedCategories,
    selectedDestination,
    setDestinationId,
    setDraggingId,
    setMode,
    setMoveItemId,
    setMoveRowNumber,
    setMoveSearch,
    setPickedMonth,
    setPickedMonths,
    setSearch,
    setSelectedCategories,
    showMobileCards,
    t,
    toggleCategory,
    totals,
    validMoveRow,
    visibleProducts,
  } = useFactoryMonthlyProductionMatrixState(props);

  return (
    <main className="p-3 sm:p-5 space-y-4" data-testid="factory-monthly-production-matrix">
      {embedded ? (
        // Overview hub "Monthly Production" tab: the hub PageHeader titles the page; keep the actions only.
        <div className="flex flex-wrap justify-end gap-2">{headerActions}</div>
      ) : (
        <PageHeader title={t("monthlyProduction.title")} subtitle={t("monthlyProduction.subtitle")}>
          {headerActions}
        </PageHeader>
      )}
      <div className="rounded-xl border bg-card p-3 space-y-3">
        <div className="flex flex-wrap gap-2 items-center">
          <Button size="sm" variant={mode === "all" ? "default" : "outline"} onClick={() => setMode("all")}>
            {t("monthlyProduction.allMonths")}
          </Button>
          <Button size="sm" variant={mode === "selected" ? "default" : "outline"} onClick={() => setMode("selected")}>
            {t("monthlyProduction.selectedMonths")}
          </Button>
          <Input
            aria-label={t("monthlyProduction.chooseMonth")}
            type="month"
            className="w-44"
            value={pickedMonth}
            onChange={(e) => setPickedMonth(e.target.value)}
          />
          <Button size="sm" variant="outline" onClick={addMonth}>
            <Plus className="mr-1 h-4 w-4" /> {t("monthlyProduction.addMonth")}
          </Button>
          <SearchField
            aria-label={t("monthlyProduction.searchItems")}
            wrapperClassName="w-full sm:w-64 sm:ml-auto"
            placeholder={t("monthlyProduction.searchPlaceholder")}
            value={search}
            onValueChange={setSearch}
          />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                aria-label={t("monthlyProduction.categoryFilter")}
                data-testid="monthly-production-category-filter"
                className="h-9 w-full justify-between gap-2 sm:w-56"
              >
                <span className="truncate text-left">
                  {selectedCategories.length === 0
                    ? t("monthlyProduction.allCategories")
                    : selectedCategories.join(", ")}
                </span>
                <ChevronDown className="h-4 w-4 shrink-0 opacity-60" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-[min(60vh,400px)] w-64 overflow-y-auto">
              <DropdownMenuItem
                className="cursor-pointer gap-2"
                onSelect={(event) => {
                  event.preventDefault();
                  setSelectedCategories([]);
                }}
              >
                <Checkbox checked={selectedCategories.length === 0} className="pointer-events-none" />
                <span>{t("monthlyProduction.allCategories")}</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {categories.map((value) => (
                <DropdownMenuItem
                  key={value}
                  className="cursor-pointer gap-2"
                  onSelect={(event) => {
                    event.preventDefault();
                    toggleCategory(value);
                  }}
                >
                  <Checkbox checked={selectedCategories.includes(value)} className="pointer-events-none" />
                  <span className="truncate" title={value}>
                    {value}
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {mode === "selected" && (
          <div className="flex flex-wrap items-center gap-1.5">
            {pickedMonths.length === 0 && (
              <span className="text-sm text-muted-foreground">{t("monthlyProduction.addMonthHint")}</span>
            )}
            {pickedMonths.map((month) => (
              <button
                key={month}
                type="button"
                onClick={() => setPickedMonths((prev) => prev.filter((m) => m !== month))}
                className="inline-flex items-center gap-1 rounded-full border bg-muted px-2.5 py-1 text-xs hover:bg-accent"
              >
                {monthLabel(month)} <X className="h-3 w-3" aria-label={t("monthlyProduction.removeMonth")} />
              </button>
            ))}
          </div>
        )}
        <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
          <span>
            {visibleProducts.length} {t("monthlyProduction.items")} · {months.length} {t("monthlyProduction.months")} ·{" "}
            {t("monthlyProduction.countsHint")}
          </span>
          <span>
            {t("monthlyProduction.highest")} <b className="text-emerald-600">{t("monthlyProduction.green")}</b> ·{" "}
            {t("monthlyProduction.lowest")} <b className="text-red-600">{t("monthlyProduction.red")}</b> ·{" "}
            {t("monthlyProduction.dragHint")}
          </span>
        </div>
      </div>
      {!error && !isLoading && data && showMobileCards && (
        <section
          className="space-y-3 md:hidden phone-land:block"
          aria-label={t("monthlyProduction.title")}
          data-testid="monthly-matrix-mobile"
        >
          <div className="flex items-center justify-between rounded-xl border bg-muted/40 px-3 py-2 text-sm">
            <span>
              {visibleProducts.length} {t("monthlyProduction.items")}
            </span>
            <strong className="tabular-nums">
              {overallTotal.toLocaleString()} {t("monthlyProduction.baleUnits")}
            </strong>
          </div>
          {visibleProducts.map((product) => {
            const values = months.map((month) => byId(product.id, month));
            const min = Math.min(...values);
            const max = Math.max(...values);
            const hasRange = values.length > 1 && min !== max;
            const total = rowTotal(product.id);
            return (
              <article
                key={product.id}
                className="min-w-0 rounded-xl border bg-card p-3 shadow-sm"
                data-testid={`monthly-matrix-mobile-item-${product.id}`}
              >
                <div className="flex min-w-0 items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <h2 className="break-words text-sm font-semibold">
                      {mhd.nameFor(product.articleCode, product.name)}
                    </h2>
                    <p className="mt-1 break-all text-xs text-muted-foreground">
                      {product.articleCode} · {product.categoryName}
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={total <= 0}
                    onClick={() => openWorkerBreakdown(product.id, months)}
                    aria-label={`${duoMobileText("workerBales", language)}: ${mhd.nameFor(product.articleCode, product.name)} · ${total} ${duoMobileText("bales", language)}`}
                    className="min-h-11 shrink-0 rounded-lg bg-primary/10 px-3 text-right font-bold text-primary tabular-nums disabled:opacity-50"
                    data-testid={`monthly-matrix-mobile-total-${product.id}`}
                  >
                    {total.toLocaleString()}
                    <span className="block text-[10px] font-normal">{t("monthlyProduction.baleUnits")}</span>
                  </button>
                </div>
                <details className="mt-3 rounded-lg border bg-muted/20">
                  <summary className="min-h-11 cursor-pointer px-3 py-3 text-sm font-medium">
                    {t("monthlyProduction.months")} · {months.length}
                  </summary>
                  <div className="grid grid-cols-2 gap-2 border-t p-2">
                    {months.map((month, i) => {
                      const value = values[i];
                      const accent =
                        hasRange && value === max
                          ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                          : hasRange && value === min
                            ? "bg-red-500/10 text-red-700 dark:text-red-300"
                            : "bg-background";
                      return (
                        <button
                          key={month}
                          type="button"
                          disabled={value <= 0}
                          onClick={() => openWorkerBreakdown(product.id, [month])}
                          aria-label={`${duoMobileText("workerBales", language)}: ${mhd.nameFor(product.articleCode, product.name)} · ${monthLabel(month)} · ${value} ${duoMobileText("bales", language)}`}
                          className={`min-h-11 rounded-lg border p-2 text-left disabled:opacity-60 ${accent}`}
                          data-testid={`monthly-matrix-mobile-month-${product.id}-${month}`}
                        >
                          <span className="block text-xs">{monthLabel(month)}</span>
                          <strong className="text-lg tabular-nums">{value.toLocaleString()}</strong>
                        </button>
                      );
                    })}
                  </div>
                </details>
                {canReorder && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="mt-2 min-h-11 w-full"
                    disabled={saving}
                    onClick={() => openMoveDialog(product.id)}
                    data-testid={`monthly-matrix-mobile-move-${product.id}`}
                  >
                    <ListOrdered className="mr-2 h-4 w-4" /> {t("monthlyProduction.moveTo")}
                  </Button>
                )}
              </article>
            );
          })}
          {!visibleProducts.length && (
            <p className="rounded-xl border p-6 text-center text-sm text-muted-foreground">
              {t("monthlyProduction.noMatching")}
            </p>
          )}
        </section>
      )}
      {error ? (
        <div className="rounded-lg border p-8 text-center text-destructive">
          {t("monthlyProduction.loadError")}{" "}
          <Button variant="outline" size="sm" onClick={() => void refetch()}>
            {t("monthlyProduction.retry")}
          </Button>
        </div>
      ) : isLoading || !data ? (
        <div className="rounded-lg border p-10 text-center text-muted-foreground">{t("monthlyProduction.loading")}</div>
      ) : !showMobileCards ? (
        <FactoryMonthlyProductionMatrixSection
          byId={byId}
          canReorder={canReorder}
          draggingId={draggingId}
          mhd={mhd}
          monthLabel={monthLabel}
          months={months}
          moveOne={moveOne}
          openMoveDialog={openMoveDialog}
          openWorkerBreakdown={openWorkerBreakdown}
          overallTotal={overallTotal}
          recordChanges={recordChanges}
          reorder={reorder}
          rowPositionById={rowPositionById}
          rowTotal={rowTotal}
          saving={saving}
          setDraggingId={setDraggingId}
          t={t}
          totals={totals}
          visibleProducts={visibleProducts}
        />
      ) : null}
      <FactoryMonthlyProductionMatrixDialogSection
        currentPosition={currentPosition}
        destinationId={destinationId}
        mhd={mhd}
        moveItemId={moveItemId}
        moveMatches={moveMatches}
        moveNextToItem={moveNextToItem}
        moveRowNumber={moveRowNumber}
        moveSearch={moveSearch}
        moveToPosition={moveToPosition}
        movingProduct={movingProduct}
        orderedProducts={orderedProducts}
        parsedMoveRow={parsedMoveRow}
        rowPositionById={rowPositionById}
        saving={saving}
        selectedDestination={selectedDestination}
        setDestinationId={setDestinationId}
        setMoveItemId={setMoveItemId}
        setMoveRowNumber={setMoveRowNumber}
        setMoveSearch={setMoveSearch}
        t={t}
        validMoveRow={validMoveRow}
      />
      {saving && (
        <p role="status" className="text-xs text-muted-foreground">
          {t("monthlyProduction.saving")}
        </p>
      )}
    </main>
  );
}
