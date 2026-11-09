import { useFactoryMhdView } from "@/hooks/use-factory-mhd-view";
import { downloadBlob } from "@/lib/downloadBlob";
import { useIsMobile } from "@/hooks/use-mobile";
import { useErpPhoneLayout } from "@/hooks/use-erp-phone-layout";
import { useEffect, useMemo, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "@/contexts/CompanyContext";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { duoMobileText } from "@/i18n/iphoneDuoMobileTranslations";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { moveProductNearItem, moveProductToPosition } from "./monthlyProductionRowOrder";
import { useToast } from "@/hooks/use-toast";
import type { MonthlyProductionExportBale } from "./monthlyProductionWorkbookDrilldown";
import { ArrowDown, ArrowUp, Download, GripVertical, ListOrdered, Plus, RotateCcw, Search, X } from "lucide-react";

type Product = { id: number; name: string; articleCode: string; categoryName: string };
type MonthValue = { productId: number; month: string; quantity: number };
type MatrixResponse = { products: Product[]; monthly: MonthValue[]; rowOrder: number[] };

const currentMonth = () => {
  const now = new Date();
  return String(now.getFullYear()) + "-" + String(now.getMonth() + 1).padStart(2, "0");
};
const prettyMonth = (month: string, locale?: string) => {
  const [y, m] = month.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(locale, { month: "short", year: "numeric" });
};
const csvCell = (value: string | number) => '"' + String(value).replace(/"/g, '""') + '"';

export default function FactoryMonthlyProductionMatrix() {
  const mhd = useFactoryMhdView();
  const isMobile = useIsMobile();
  const isPhoneLayout = useErpPhoneLayout();
  const showMobileCards = isMobile || isPhoneLayout;
  const { selectedCompany } = useCompany();
  const [, navigate] = useLocation();
  const returnMonths =
    new URLSearchParams(useSearch())
      .get("months")
      ?.split(",")
      .filter((month) => /^\d{4}-(0[1-9]|1[0-2])$/.test(month)) ?? [];
  const { t, language } = useApplicationLanguage();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const queryKey = companyQueryKey("/api/factory/monthly-production-matrix", selectedCompany?.id);
  const { data, isLoading, error, refetch, isFetching } = useQuery<MatrixResponse>({
    queryKey,
    enabled: !!selectedCompany?.id,
    queryFn: async () => {
      const response = await fetch("/api/factory/monthly-production-matrix", { credentials: "include" });
      if (!response.ok) throw new Error(t("monthlyProduction.couldNotLoad"));
      return response.json();
    },
    staleTime: 60_000,
  });
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [mode, setMode] = useState<"all" | "selected">(returnMonths.length ? "selected" : "all");
  const [pickedMonth, setPickedMonth] = useState(currentMonth);
  const [pickedMonths, setPickedMonths] = useState<string[]>([...new Set(returnMonths)].sort());
  const [orderedIds, setOrderedIds] = useState<number[]>([]);
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [exportingExcel, setExportingExcel] = useState(false);
  const [exportProgress, setExportProgress] = useState("");
  const [moveItemId, setMoveItemId] = useState<number | null>(null);
  const [moveRowNumber, setMoveRowNumber] = useState("");
  const [moveSearch, setMoveSearch] = useState("");
  const [destinationId, setDestinationId] = useState<number | null>(null);

  useEffect(() => {
    if (data) setOrderedIds(data.rowOrder);
  }, [data]);

  const allMonths = useMemo(() => {
    const observed = (data?.monthly ?? []).map((row) => row.month).filter((m) => /^\d{4}-\d{2}$/.test(m));
    const first = [...observed, currentMonth()].sort()[0];
    const last = [...observed, currentMonth()].sort().at(-1) ?? currentMonth();
    const [sy, sm] = first.split("-").map(Number);
    const [ey, em] = last.split("-").map(Number);
    const months: string[] = [];
    for (let y = sy, m = sm; y < ey || (y === ey && m <= em); m++) {
      if (m > 12) {
        m = 1;
        y++;
      }
      months.push(String(y) + "-" + String(m).padStart(2, "0"));
    }
    return months;
  }, [data?.monthly]);
  const months = mode === "all" ? allMonths : [...pickedMonths].sort();
  // Intl.DateTimeFormat is expensive when called in thousands of table cells.
  // Cache a label once per displayed month, and reuse it in titles and ARIA text.
  const monthKey = months.join("|");
  const monthLabels = useMemo(() => {
    const locale = language === "ar" ? "ar" : language === "fr" ? "fr" : "en";
    return new Map(monthKey.split("|").filter(Boolean).map((month) => [month, prettyMonth(month, locale)]));
  }, [monthKey, language]);
  const monthLabel = (month: string) => monthLabels.get(month) ?? month;
  const counts = useMemo(() => {
    const map = new Map<number, Map<string, number>>();
    for (const record of data?.monthly ?? []) {
      if (!map.has(record.productId)) map.set(record.productId, new Map());
      map.get(record.productId)!.set(record.month, record.quantity);
    }
    return map;
  }, [data?.monthly]);
  const categories = useMemo(
    () => [...new Set((data?.products ?? []).map((p) => p.categoryName))].sort(),
    [data?.products]
  );
  const orderedProducts = useMemo(() => {
    const positions = new Map(orderedIds.map((id, i) => [id, i]));
    return [...(data?.products ?? [])].sort((a, b) => {
      const ap = positions.get(a.id),
        bp = positions.get(b.id);
      if (ap != null && bp != null) return ap - bp;
      if (ap != null) return -1;
      if (bp != null) return 1;
      return a.name.localeCompare(b.name) || a.id - b.id;
    });
  }, [data?.products, orderedIds]);
  const mhdOrderedProducts = mhd.sortRows(orderedProducts, (product) => product.articleCode);
  const rowPositionById = new Map(mhdOrderedProducts.map((product, index) => [product.id, index + 1]));
  const visibleProducts = mhdOrderedProducts.filter((product) => {
    const q = search.trim().toLowerCase();
    return (
      (!category || product.categoryName === category) &&
      (!q ||
        [mhd.nameFor(product.articleCode, product.name), product.articleCode, product.categoryName].some((v) =>
          v.toLowerCase().includes(q)
        ))
    );
  });
  const canReorder = mhd.mode === "standard" && !search.trim() && !category && !saving;
  const byId = (productId: number, month: string) => counts.get(productId)?.get(month) ?? 0;
  const openWorkerBreakdown = (productId: number, selectedMonths: string[]) => {
    if (selectedMonths.length === 0) return;
    const params = new URLSearchParams({ months: selectedMonths.join(",") });
    navigate("/factory/monthly-production-matrix/" + productId + "/workers?" + params.toString());
  };
  const rowTotal = (id: number) => months.reduce((sum, month) => sum + byId(id, month), 0);
  const persistOrder = async (next: number[]): Promise<boolean> => {
    if (!data || saving) return false;
    const current = orderedProducts.map((product) => product.id);
    if (next.every((id, index) => id === current[index])) return true;
    const before = orderedIds;
    setOrderedIds(next);
    setSaving(true);
    try {
      const response = await fetch("/api/factory/monthly-production-matrix/order", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productIds: next }),
      });
      if (!response.ok) throw new Error(t("monthlyProduction.orderError"));
      queryClient.setQueryData<MatrixResponse>(queryKey, { ...data, rowOrder: next });
      toast({ title: t("monthlyProduction.orderSaved"), description: t("monthlyProduction.sharedSaved") });
      return true;
    } catch {
      setOrderedIds(before);
      toast({
        title: t("monthlyProduction.orderError"),
        description: t("monthlyProduction.restored"),
        variant: "destructive",
      });
      return false;
    } finally {
      setSaving(false);
    }
  };
  const reorder = (sourceId: number, targetId: number) => {
    if (!canReorder || sourceId === targetId) return;
    const current = orderedProducts.map((product) => product.id);
    const to = current.indexOf(targetId);
    if (to === -1) return;
    void persistOrder(moveProductToPosition(current, sourceId, to + 1));
  };
  const moveOne = (id: number, direction: number) => {
    if (!canReorder) return;
    const current = orderedProducts.map((product) => product.id);
    const from = current.indexOf(id);
    if (from < 0 || from + direction < 0 || from + direction >= current.length) return;
    void persistOrder(moveProductToPosition(current, id, from + direction + 1));
  };
  const openMoveDialog = (id: number) => {
    const index = orderedProducts.findIndex((product) => product.id === id);
    if (index === -1 || saving) return;
    setMoveItemId(id);
    setMoveRowNumber(String(index + 1));
    setMoveSearch("");
    setDestinationId(null);
  };
  const moveToPosition = async (position: number) => {
    if (moveItemId === null) return;
    const current = orderedProducts.map((product) => product.id);
    if (!Number.isSafeInteger(position) || position < 1 || position > current.length) return;
    if (await persistOrder(moveProductToPosition(current, moveItemId, position))) {
      setMoveItemId(null);
    }
  };
  const moveNextToItem = async (placement: "before" | "after") => {
    if (moveItemId === null || destinationId === null) return;
    const current = orderedProducts.map((product) => product.id);
    if (await persistOrder(moveProductNearItem(current, moveItemId, destinationId, placement))) {
      setMoveItemId(null);
    }
  };
  const movingProduct = orderedProducts.find((product) => product.id === moveItemId);
  const currentPosition = movingProduct ? (rowPositionById.get(movingProduct.id) ?? 0) : 0;
  const parsedMoveRow = /^\d+$/.test(moveRowNumber.trim()) ? Number(moveRowNumber) : Number.NaN;
  const validMoveRow =
    Number.isSafeInteger(parsedMoveRow) && parsedMoveRow >= 1 && parsedMoveRow <= orderedProducts.length;
  const moveMatches = moveSearch.trim()
    ? orderedProducts
        .filter(
          (product) =>
            product.id !== moveItemId &&
            (mhd.nameFor(product.articleCode, product.name) + " " + product.articleCode + " " + product.categoryName)
              .toLowerCase()
              .includes(moveSearch.trim().toLowerCase())
        )
        .slice(0, 12)
    : [];
  const selectedDestination = orderedProducts.find((product) => product.id === destinationId);
  const addMonth = () => {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(pickedMonth)) return;
    setPickedMonths((previous) => [...new Set(mode === "all" ? [pickedMonth] : [...previous, pickedMonth])].sort());
    setMode("selected");
  };
  const exportCsv = () => {
    const rows: (string | number)[][] = [
      [
        t("monthlyProduction.code"),
        t("monthlyProduction.item"),
        t("monthlyProduction.category"),
        ...months.map(monthLabel),
        t("monthlyProduction.total"),
      ],
      ...visibleProducts.map((p) => [
        p.articleCode,
        p.name,
        p.categoryName,
        ...months.map((m) => byId(p.id, m)),
        rowTotal(p.id),
      ]),
    ];
    const csv = "\uFEFF" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
    downloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8" }), "factory-monthly-production.csv");
  };
  const exportExcel = async () => {
    if (exportingExcel || months.length === 0 || !data) return;
    setExportingExcel(true);
    setExportProgress("Collecting bales");
    try {
      // Export all matching bales, not just one paginated screen page.
      // The resulting workbook can be navigated completely offline.
      const bales: MonthlyProductionExportBale[] = [];
      if (visibleProducts.length > 0) {
        const params = new URLSearchParams({
          productIds: visibleProducts.map((product) => String(product.id)).join(","),
          months: months.join(","),
        });
        let page = 1;
        let hasMore = true;
        while (hasMore) {
          if (page > 200) throw new Error("Too many production records for a single Excel export.");
          params.set("page", String(page));
          const response = await fetch("/api/factory/monthly-production-matrix/export-bales?" + params.toString(), {
            credentials: "include",
            cache: "no-store",
          });
          if (!response.ok) {
            const payload = await response.json().catch(() => ({}));
            throw new Error(payload.message || "Unable to load bale details");
          }
          const batch: { bales: MonthlyProductionExportBale[]; hasMore: boolean; page: number } = await response.json();
          if (
            !Array.isArray(batch.bales) ||
            typeof batch.hasMore !== "boolean" ||
            batch.page !== page ||
            (batch.hasMore && batch.bales.length === 0)
          ) {
            throw new Error("Incomplete production details returned; Excel export cancelled.");
          }
          bales.push(...batch.bales);
          if (bales.length > 250_000) {
            throw new Error("This export is too large; select fewer months or filter items.");
          }
          setExportProgress("Loaded " + bales.length.toLocaleString() + " bales");
          hasMore = batch.hasMore;
          page += 1;
        }
      }

      // Recompute the matrix counts using the exact exported bale records so
      // every click, worker total and reference list reconciles in the file.
      const exportedCounts = new Map<string, number>();
      for (const bale of bales) {
        const key = bale.productId + "|" + bale.month;
        exportedCounts.set(key, (exportedCounts.get(key) ?? 0) + 1);
      }
      const rows = visibleProducts.map((product) => ({
        productId: product.id,
        name: mhd.nameFor(product.articleCode, product.name),
        articleCode: product.articleCode,
        categoryName: product.categoryName,
        values: months.map((month) => exportedCounts.get(product.id + "|" + month) ?? 0),
      }));
      setExportProgress("Building Excel sheets");
      const { exportMonthlyProductionExcel } = await import("./monthlyProductionExcelExport");
      await exportMonthlyProductionExcel({
        rows,
        months,
        monthLabels: months.map(monthLabel),
        category,
        search,
        bales,
      });
      toast({
        title: "Excel workbook exported",
        description: "Click a count to move between the worksheets inside the file.",
      });
    } catch (error) {
      toast({
        title: "Unable to export Excel",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setExportingExcel(false);
      setExportProgress("");
    }
  };
  const totals = months.map((month) => visibleProducts.reduce((sum, product) => sum + byId(product.id, month), 0));
  const overallTotal = totals.reduce((sum, count) => sum + count, 0);

  return (
    <main className="p-3 sm:p-5 space-y-4" data-testid="factory-monthly-production-matrix">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageHeader title={t("monthlyProduction.title")} subtitle={t("monthlyProduction.subtitle")} />
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={isFetching} onClick={() => void refetch()}>
            <RotateCcw className="mr-2 h-4 w-4" /> {t("monthlyProduction.refresh")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!data || months.length === 0 || exportingExcel}
            onClick={() => void exportExcel()}
            data-testid="export-monthly-production-excel"
          >
            <Download className="mr-2 h-4 w-4" /> {exportingExcel ? exportProgress || "Exporting…" : "Export Excel"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!data || months.length === 0}
            onClick={exportCsv}
            data-testid="export-monthly-production-csv"
          >
            <Download className="mr-2 h-4 w-4" /> {t("monthlyProduction.exportCsv")}
          </Button>
        </div>
      </div>
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
          <div className="relative w-full sm:w-64 sm:ml-auto">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              aria-label={t("monthlyProduction.searchItems")}
              className="pl-9"
              placeholder={t("monthlyProduction.searchPlaceholder")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <select
            aria-label={t("monthlyProduction.categoryFilter")}
            className="h-9 rounded-md border bg-background px-2 text-sm"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            <option value="">{t("monthlyProduction.allCategories")}</option>
            {categories.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
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
        <div
          className="hidden overflow-auto rounded-xl border bg-card md:block phone-land:hidden"
          style={{ maxHeight: "calc(100dvh - 280px)" }}
        >
          <table className="min-w-max w-full border-separate border-spacing-0 text-sm tabular-nums">
            <thead className="sticky top-0 z-20 bg-muted text-foreground">
              <tr>
                <th className="sticky left-0 z-30 min-w-72 border-b border-r bg-muted p-2 text-left">
                  {t("monthlyProduction.itemCode")}
                </th>
                {months.map((month) => (
                  <th key={month} className="min-w-24 border-b border-r px-3 py-2 text-right whitespace-nowrap">
                    {monthLabel(month)}
                  </th>
                ))}
                <th className="sticky right-0 z-30 min-w-24 border-b bg-muted px-3 py-2 text-right">
                  {t("monthlyProduction.total")}
                </th>
              </tr>
            </thead>
            <tbody>
              {visibleProducts.map((product, index) => {
                const values = months.map((month) => byId(product.id, month));
                const min = Math.min(...values);
                const max = Math.max(...values);
                const hasRange = values.length > 1 && min !== max;
                return (
                  <tr
                    key={product.id}
                    draggable={canReorder}
                    onDragStart={(event) => {
                      setDraggingId(product.id);
                      event.dataTransfer.effectAllowed = "move";
                    }}
                    onDragOver={(event) => {
                      if (canReorder) event.preventDefault();
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      if (draggingId != null) void reorder(draggingId, product.id);
                      setDraggingId(null);
                    }}
                    onDragEnd={() => setDraggingId(null)}
                    className={
                      "group hover:bg-accent/30 " +
                      (draggingId === product.id ? "opacity-50 " : "") +
                      (index % 2 ? "bg-muted/20" : "")
                    }
                  >
                    <td className="sticky left-0 z-10 border-r border-b bg-card p-1.5 group-hover:bg-accent/30">
                      <div className="flex items-center gap-1.5">
                        <GripVertical
                          className={
                            "h-4 w-4 shrink-0 " +
                            (canReorder ? "cursor-grab text-muted-foreground" : "text-muted-foreground/30")
                          }
                        />
                        <div className="min-w-0 flex-1">
                          <div className="font-medium leading-tight">
                            {mhd.nameFor(product.articleCode, product.name)}
                          </div>
                          <div className="text-[11px] text-muted-foreground">
                            #{rowPositionById.get(product.id)} · {product.articleCode} · {product.categoryName}
                          </div>
                        </div>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-7 shrink-0 gap-1 px-2 text-xs"
                          disabled={saving}
                          onClick={() => openMoveDialog(product.id)}
                          aria-label={
                            t("monthlyProduction.moveTo") + ": " + mhd.nameFor(product.articleCode, product.name)
                          }
                          data-testid={"move-matrix-item-" + product.id}
                        >
                          <ListOrdered className="h-3.5 w-3.5" /> {t("monthlyProduction.moveTo")}
                        </Button>
                        <div className="flex flex-col">
                          <button
                            type="button"
                            aria-label={
                              t("monthlyProduction.moveUp") + ": " + mhd.nameFor(product.articleCode, product.name)
                            }
                            disabled={!canReorder || index === 0}
                            onClick={() => moveOne(product.id, -1)}
                            className="rounded hover:bg-muted disabled:opacity-25"
                          >
                            <ArrowUp className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            aria-label={
                              t("monthlyProduction.moveDown") + ": " + mhd.nameFor(product.articleCode, product.name)
                            }
                            disabled={!canReorder || index === visibleProducts.length - 1}
                            onClick={() => moveOne(product.id, 1)}
                            className="rounded hover:bg-muted disabled:opacity-25"
                          >
                            <ArrowDown className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    </td>
                    {values.map((value, i) => {
                      const accent =
                        hasRange && value === max
                          ? "bg-emerald-100 text-emerald-800 font-bold dark:bg-emerald-950/50 dark:text-emerald-300"
                          : hasRange && value === min
                            ? "bg-red-100 text-red-800 font-bold dark:bg-red-950/50 dark:text-red-300"
                            : "";
                      return (
                        <td
                          key={months[i]}
                          title={monthLabel(months[i]) + ": " + value + " " + t("monthlyProduction.baleUnits")}
                          className={"border-b border-r px-3 py-2 text-right " + accent}
                        >
                          {value > 0 ? (
                            <button
                              type="button"
                              className="font-semibold underline-offset-4 hover:underline focus-visible:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                              onClick={() => openWorkerBreakdown(product.id, [months[i]])}
                              title="View production by worker"
                              aria-label={
                                "View workers who produced " +
                                value +
                                " bales of " +
                                mhd.nameFor(product.articleCode, product.name) +
                                " in " +
                                monthLabel(months[i])
                              }
                              data-testid={"matrix-worker-drilldown-" + product.id + "-" + months[i]}
                            >
                              {value.toLocaleString()}
                            </button>
                          ) : (
                            value.toLocaleString()
                          )}
                        </td>
                      );
                    })}
                    <td className="sticky right-0 z-10 border-b bg-card px-3 py-2 text-right font-semibold group-hover:bg-accent/30">
                      {rowTotal(product.id) > 0 ? (
                        <button
                          type="button"
                          className="font-semibold underline-offset-4 hover:underline focus-visible:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                          onClick={() => openWorkerBreakdown(product.id, months)}
                          title="View production by worker for selected months"
                          aria-label={
                            "View workers who produced " +
                            rowTotal(product.id) +
                            " bales of " +
                            mhd.nameFor(product.articleCode, product.name) +
                            " across selected months"
                          }
                          data-testid={"matrix-total-drilldown-" + product.id}
                        >
                          {rowTotal(product.id).toLocaleString()}
                        </button>
                      ) : (
                        rowTotal(product.id).toLocaleString()
                      )}
                    </td>
                  </tr>
                );
              })}
              {visibleProducts.length === 0 && (
                <tr>
                  <td colSpan={months.length + 2} className="p-10 text-center text-muted-foreground">
                    {t("monthlyProduction.noMatching")}
                  </td>
                </tr>
              )}
            </tbody>
            <tfoot className="sticky bottom-0 z-10 bg-muted font-bold">
              <tr>
                <td className="sticky left-0 border-t border-r bg-muted px-3 py-2">
                  {t("monthlyProduction.totalProduced")}
                </td>
                {totals.map((value, index) => (
                  <td key={months[index]} className="border-t border-r px-3 py-2 text-right">
                    {value.toLocaleString()}
                  </td>
                ))}
                <td className="sticky right-0 border-t bg-muted px-3 py-2 text-right">
                  {overallTotal.toLocaleString()}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      ) : null}
      <Dialog
        open={moveItemId !== null}
        onOpenChange={(open) => {
          if (!open && !saving) setMoveItemId(null);
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {t("monthlyProduction.moveTo")}: {movingProduct?.name}
            </DialogTitle>
            <DialogDescription>
              {t("monthlyProduction.currentRow")}: {currentPosition} / {orderedProducts.length}.{" "}
              {t("monthlyProduction.moveHint")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={saving}
                onClick={() => void moveToPosition(1)}
              >
                {t("monthlyProduction.moveTop")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={saving}
                onClick={() => void moveToPosition(orderedProducts.length)}
              >
                {t("monthlyProduction.moveBottom")}
              </Button>
            </div>
            <div className="space-y-2">
              <label htmlFor="monthly-move-row" className="text-sm font-medium">
                {t("monthlyProduction.rowPosition")} (1–{orderedProducts.length})
              </label>
              <div className="flex gap-2">
                <Input
                  id="monthly-move-row"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={orderedProducts.length}
                  step={1}
                  value={moveRowNumber}
                  onChange={(event) => setMoveRowNumber(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && validMoveRow && !saving) void moveToPosition(parsedMoveRow);
                  }}
                  aria-invalid={moveRowNumber.trim().length > 0 && !validMoveRow}
                  data-testid="monthly-matrix-row-number"
                />
                <Button
                  type="button"
                  disabled={!validMoveRow || saving}
                  onClick={() => void moveToPosition(parsedMoveRow)}
                  data-testid="monthly-matrix-move-row"
                >
                  {t("monthlyProduction.moveRow")}
                </Button>
              </div>
            </div>
            <div className="border-t pt-3 space-y-2">
              <label htmlFor="monthly-move-search" className="text-sm font-medium">
                {t("monthlyProduction.placeNear")}
              </label>
              <Input
                id="monthly-move-search"
                value={moveSearch}
                onChange={(event) => {
                  setMoveSearch(event.target.value);
                  setDestinationId(null);
                }}
                placeholder={t("monthlyProduction.searchDestination")}
                data-testid="monthly-matrix-destination-search"
              />
              {moveSearch.trim() && (
                <div
                  className="max-h-44 overflow-y-auto rounded-md border"
                  role="group"
                  aria-label={t("monthlyProduction.placeNear")}
                >
                  {moveMatches.length ? (
                    moveMatches.map((product) => (
                      <button
                        key={product.id}
                        type="button"
                        className={
                          "block w-full border-b px-3 py-2 text-left text-sm last:border-b-0 hover:bg-accent " +
                          (destinationId === product.id ? "bg-accent font-semibold" : "")
                        }
                        onClick={() => setDestinationId(product.id)}
                        aria-pressed={destinationId === product.id}
                      >
                        <span className="font-medium">{mhd.nameFor(product.articleCode, product.name)}</span>
                        <span className="ml-2 text-xs text-muted-foreground">
                          #{rowPositionById.get(product.id)} · {product.articleCode}
                        </span>
                      </button>
                    ))
                  ) : (
                    <p className="p-3 text-sm text-muted-foreground">{t("monthlyProduction.noDestination")}</p>
                  )}
                </div>
              )}
              {selectedDestination && <p className="text-sm font-medium">{selectedDestination.name}</p>}
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  disabled={!selectedDestination || saving}
                  onClick={() => void moveNextToItem("before")}
                >
                  {t("monthlyProduction.placeAbove")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={!selectedDestination || saving}
                  onClick={() => void moveNextToItem("after")}
                >
                  {t("monthlyProduction.placeBelow")}
                </Button>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      {saving && (
        <p role="status" className="text-xs text-muted-foreground">
          {t("monthlyProduction.saving")}
        </p>
      )}
    </main>
  );
}
