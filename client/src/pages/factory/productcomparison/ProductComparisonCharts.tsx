import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { memo, useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { AlertTriangle, ArrowLeftRight, BarChart3, CalendarDays, Package, Scale, X } from "lucide-react";

import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { getFactoryProductComparisonCopy } from "@/i18n/factoryProductComparisonTranslations";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ResponsiveChartPanel,
  ResponsiveChartViewport,
  ResponsiveMetricGrid,
  ResponsiveReportGrid,
} from "@/components/ui/responsive-report";
import { MultiSelectFilter } from "@/pages/factory/productioncomparison/components/MultiSelectFilter";
import type { ProductRow, ReportData } from "@/pages/factory/productioncomparison/types";
import { deriveGrade, fmtKg, fmtNum, pctChange } from "@/pages/factory/productioncomparison/utils";

import {
  buildAutomaticComparisonRanges,
  currentDayValue,
  currentMonthValue,
  currentYearValue,
  parseLocalIsoDate,
  type ComparisonDirection,
  type ComparisonRange,
  type ProductComparisonPeriod,
} from "./utils";

type Metric = "bales" | "weight";

interface BaleProductCatalogRow {
  id: number;
  code?: string | null;
  articleCode?: string | null;
  name?: string | null;
  nameAr?: string | null;
  nameFr?: string | null;
  categoryId?: number | null;
  active?: boolean | null;
}

interface CategoryRow {
  id: number;
  name: string;
  nameAr?: string | null;
  nameFr?: string | null;
}

function normalizeArticle(value: string | null | undefined): string {
  return (value || "").trim().toUpperCase();
}

function productKey(product: BaleProductCatalogRow): string {
  return normalizeArticle(product.articleCode || product.code);
}

function reportMap(rows: ProductRow[] | undefined): Map<string, ProductRow> {
  const map = new Map<string, ProductRow>();
  for (const row of rows ?? []) {
    map.set(normalizeArticle(row.articleCode), row);
  }
  return map;
}

function formatMetric(value: number, metric: Metric): string {
  return metric === "bales" ? fmtNum(value) : `${fmtKg(value)} kg`;
}

function metricValue(row: ProductRow | undefined, metric: Metric): number {
  if (!row) return 0;
  return metric === "bales" ? row.qty : row.totalWeightKg;
}

function localeFor(language: "en" | "ar" | "fr"): string {
  if (language === "ar") return "ar";
  if (language === "fr") return "fr-FR";
  return "en-US";
}

function localizedProductName(product: BaleProductCatalogRow, language: "en" | "ar" | "fr"): string {
  if (language === "ar" && product.nameAr?.trim()) return product.nameAr.trim();
  if (language === "fr" && product.nameFr?.trim()) return product.nameFr.trim();
  return product.name?.trim() || product.articleCode?.trim() || product.code?.trim() || String(product.id);
}

function localizedCategoryName(category: CategoryRow, language: "en" | "ar" | "fr"): string {
  if (language === "ar" && category.nameAr?.trim()) return category.nameAr.trim();
  if (language === "fr" && category.nameFr?.trim()) return category.nameFr.trim();
  return category.name;
}

function formatRangeLabel(
  range: ComparisonRange,
  period: ProductComparisonPeriod,
  locale: string
): string {
  const from = parseLocalIsoDate(range.from);
  const to = parseLocalIsoDate(range.to);
  if (period === "day") {
    return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric" }).format(from);
  }
  if (period === "month") {
    return new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" }).format(from);
  }
  if (period === "year") return String(from.getFullYear());
  const formatter = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric" });
  if (range.from === range.to) return formatter.format(from);
  return `${formatter.format(from)} – ${formatter.format(to)}`;
}

function Stat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <Card className="min-w-0">
      <CardContent className="p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className="mt-1 break-words text-xl font-bold tabular-nums">{value}</p>
        {sub ? <p className="mt-1 break-words text-xs text-muted-foreground">{sub}</p> : null}
      </CardContent>
    </Card>
  );
}

const ProductChartCard = memo(function ProductChartCard({
  product,
  selectedRow,
  comparisonRow,
  selectedLabel,
  comparisonLabel,
  metric,
  language,
  currentLabel,
  comparedLabel,
  differenceLabel,
  changeLabel,
  noProductionLabel,
  inactiveLabel,
  balesLabel,
  weightLabel,
  chartRegionLabel,
}: {
  product: BaleProductCatalogRow;
  selectedRow?: ProductRow;
  comparisonRow?: ProductRow;
  selectedLabel: string;
  comparisonLabel: string;
  metric: Metric;
  language: "en" | "ar" | "fr";
  currentLabel: string;
  comparedLabel: string;
  differenceLabel: string;
  changeLabel: string;
  noProductionLabel: string;
  inactiveLabel: string;
  balesLabel: string;
  weightLabel: string;
  chartRegionLabel: string;
}) {
  const selectedValue = metricValue(selectedRow, metric);
  const comparisonValue = metricValue(comparisonRow, metric);
  const difference = selectedValue - comparisonValue;
  const change = pctChange(selectedValue, comparisonValue);
  const localizedName = localizedProductName(product, language);
  const code = (product.articleCode || product.code || "").trim();
  const chartData = [
    { period: selectedLabel, value: selectedValue },
    { period: comparisonLabel, value: comparisonValue },
  ];

  return (
    <ResponsiveChartPanel
      className="min-h-[410px]"
      data-testid={`product-comparison-chart-${product.id}`}
      style={{ contentVisibility: "auto", containIntrinsicSize: "410px" }}
    >
      <div className="mb-3 flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="break-words text-base font-semibold">{localizedName}</h3>
          <p className="mt-0.5 break-all text-xs text-muted-foreground">{code || "—"}</p>
        </div>
        {product.active === false ? (
          <Badge variant="outline" className="shrink-0">
            {inactiveLabel}
          </Badge>
        ) : null}
      </div>

      <div className="mb-3 grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-lg border bg-muted/20 p-2.5">
          <p className="text-muted-foreground">{currentLabel}</p>
          <p className="mt-1 font-semibold tabular-nums">{formatMetric(selectedValue, metric)}</p>
        </div>
        <div className="rounded-lg border bg-muted/20 p-2.5">
          <p className="text-muted-foreground">{comparedLabel}</p>
          <p className="mt-1 font-semibold tabular-nums">{formatMetric(comparisonValue, metric)}</p>
        </div>
      </div>

      <ResponsiveChartViewport label={`${chartRegionLabel}: ${localizedName}`}>
        <div className="h-[245px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ top: 12, right: 12, left: 0, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="period" tick={{ fontSize: 11 }} interval={0} />
              <YAxis
                allowDecimals={metric === "weight"}
                tick={{ fontSize: 11 }}
                tickFormatter={(value) => (metric === "bales" ? fmtNum(Number(value)) : fmtKg(Number(value)))}
              />
              <Tooltip
                formatter={(value) => [formatMetric(Number(value), metric), metric === "bales" ? balesLabel : weightLabel]}
              />
              <Bar dataKey="value" radius={[6, 6, 0, 0]} maxBarSize={96}>
                <Cell fill="hsl(var(--primary))" />
                <Cell fill="hsl(var(--muted-foreground))" />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </ResponsiveChartViewport>

      <div className="mt-3 grid grid-cols-2 gap-2 border-t pt-3 text-xs">
        <div>
          <p className="text-muted-foreground">{differenceLabel}</p>
          <p className="mt-0.5 font-semibold tabular-nums">
            {difference > 0 ? "+" : ""}
            {formatMetric(difference, metric)}
          </p>
        </div>
        <div>
          <p className="text-muted-foreground">{changeLabel}</p>
          <p className="mt-0.5 font-semibold tabular-nums">
            {change === null ? "N/A" : `${change > 0 ? "+" : ""}${change.toFixed(1)}%`}
          </p>
        </div>
      </div>

      {selectedValue === 0 && comparisonValue === 0 ? (
        <p className="mt-3 text-center text-xs text-muted-foreground">{noProductionLabel}</p>
      ) : null}
    </ResponsiveChartPanel>
  );
});

function LazyProductChartCard(props: ComponentProps<typeof ProductChartCard>) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "500px 0px" }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={ref} className="min-h-[410px]">
      {visible ? <ProductChartCard {...props} /> : <Skeleton className="h-[410px] w-full rounded-xl" />}
    </div>
  );
}

export default function ProductComparisonCharts() {
  const { language } = useApplicationLanguage();
  const copy = getFactoryProductComparisonCopy(language);
  const locale = localeFor(language);

  const [period, setPeriod] = useState<ProductComparisonPeriod>("month");
  const [direction, setDirection] = useState<ComparisonDirection>("previous");
  const [metric, setMetric] = useState<Metric>("bales");
  const [day, setDay] = useState(() => currentDayValue());
  const [month, setMonth] = useState(() => currentMonthValue());
  const [year, setYear] = useState(() => currentYearValue());
  const [customA, setCustomA] = useState<[string, string]>(() => {
    const today = currentDayValue();
    return [today, today];
  });
  const [customB, setCustomB] = useState<[string, string]>(() => {
    const today = currentDayValue();
    return [today, today];
  });
  const [selectedProducts, setSelectedProducts] = useState<string[]>([]);
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [selectedGrades, setSelectedGrades] = useState<string[]>([]);

  const { data: catalog = [] } = useQuery<BaleProductCatalogRow[]>({
    queryKey: ["/api/factory/bale-products"],
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });

  const { data: categories = [] } = useQuery<CategoryRow[]>({
    queryKey: ["/api/factory/categories"],
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });

  const ranges = useMemo(() => {
    if (period === "custom") {
      return {
        selected: { from: customA[0], to: customA[1] },
        comparison: { from: customB[0], to: customB[1] },
      };
    }
    return buildAutomaticComparisonRanges(period, direction, { day, month, year });
  }, [period, direction, day, month, year, customA, customB]);

  const selectedRangeValid = ranges.selected.from <= ranges.selected.to;
  const comparisonRangeValid = ranges.comparison.from <= ranges.comparison.to;
  const queriesEnabled = selectedProducts.length > 0 && selectedRangeValid && comparisonRangeValid;

  const selectedReport = useQuery<ReportData>({
    queryKey: ["/api/factory/production-value-report", ranges.selected.from, ranges.selected.to, "product-comparison"],
    enabled: queriesEnabled,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const params = new URLSearchParams({ from: ranges.selected.from, to: ranges.selected.to });
      const response = await fetch(`/api/factory/production-value-report?${params}`, { credentials: "include" });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).message ?? copy.requestFailed);
      return response.json();
    },
  });

  const comparisonReport = useQuery<ReportData>({
    queryKey: [
      "/api/factory/production-value-report",
      ranges.comparison.from,
      ranges.comparison.to,
      "product-comparison",
    ],
    enabled: queriesEnabled,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const params = new URLSearchParams({ from: ranges.comparison.from, to: ranges.comparison.to });
      const response = await fetch(`/api/factory/production-value-report?${params}`, { credentials: "include" });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).message ?? copy.requestFailed);
      return response.json();
    },
  });

  const categoryNameById = useMemo(
    () => new Map(categories.map((category) => [category.id, localizedCategoryName(category, language)])),
    [categories, language]
  );

  const gradeOptions = useMemo(() => {
    const grades = new Set<string>();
    for (const product of catalog) {
      const grade = deriveGrade(product.articleCode || product.code || "");
      if (grade !== "—") grades.add(grade);
    }
    return [...grades].sort();
  }, [catalog]);

  const categoryOptions = useMemo(
    () =>
      categories
        .slice()
        .sort((a, b) => localizedCategoryName(a, language).localeCompare(localizedCategoryName(b, language), locale))
        .map((category) => ({ value: String(category.id), label: localizedCategoryName(category, language) })),
    [categories, language, locale]
  );

  const catalogByKey = useMemo(() => {
    const map = new Map<string, BaleProductCatalogRow>();
    for (const product of catalog) {
      const key = productKey(product);
      if (key) map.set(key, product);
    }
    return map;
  }, [catalog]);

  const productOptions = useMemo(() => {
    return catalog
      .filter((product) => {
        const key = productKey(product);
        if (!key) return false;
        if (selectedProducts.includes(key)) return true;
        if (selectedCategories.length > 0 && !selectedCategories.includes(String(product.categoryId ?? ""))) return false;
        const grade = deriveGrade(product.articleCode || product.code || "");
        if (selectedGrades.length > 0 && !selectedGrades.includes(grade)) return false;
        return true;
      })
      .map((product) => {
        const key = productKey(product);
        const code = (product.articleCode || product.code || "").trim();
        const english = product.name?.trim() || code;
        const localized = localizedProductName(product, language);
        const arabic = product.nameAr?.trim();
        const pieces = [code, localized];
        if (language !== "en" && english && english !== localized) pieces.push(english);
        if (language !== "ar" && arabic && arabic !== localized) pieces.push(arabic);
        const categoryName = product.categoryId ? categoryNameById.get(product.categoryId) : undefined;
        return {
          value: key,
          label: `${pieces.filter(Boolean).join(" — ")}${categoryName ? ` · ${categoryName}` : ""}`,
        };
      })
      .sort((a, b) => a.label.localeCompare(b.label, locale));
  }, [
    catalog,
    selectedProducts,
    selectedCategories,
    selectedGrades,
    language,
    categoryNameById,
    locale,
  ]);

  const selectedRows = useMemo(() => reportMap(selectedReport.data?.production.byProduct), [selectedReport.data]);
  const comparisonRows = useMemo(
    () => reportMap(comparisonReport.data?.production.byProduct),
    [comparisonReport.data]
  );

  const selectedLabel = formatRangeLabel(ranges.selected, period, locale);
  const comparisonLabel = formatRangeLabel(ranges.comparison, period, locale);

  const selectedCatalogRows = useMemo(
    () => selectedProducts.map((key) => catalogByKey.get(key)).filter((product): product is BaleProductCatalogRow => !!product),
    [selectedProducts, catalogByKey]
  );

  const totals = useMemo(() => {
    let selected = 0;
    let comparison = 0;
    for (const key of selectedProducts) {
      selected += metricValue(selectedRows.get(key), metric);
      comparison += metricValue(comparisonRows.get(key), metric);
    }
    const difference = selected - comparison;
    return { selected, comparison, difference, change: pctChange(selected, comparison) };
  }, [selectedProducts, selectedRows, comparisonRows, metric]);

  const isLoading = queriesEnabled && (selectedReport.isFetching || comparisonReport.isFetching);
  const error = selectedReport.error || comparisonReport.error;
  const hasFilter = selectedCategories.length > 0 || selectedGrades.length > 0;

  return (
    <div className="space-y-5" data-testid="factory-product-comparison">
      <div className="flex flex-col gap-1">
        <h2 className="text-xl font-bold tracking-tight">{copy.title}</h2>
        <p className="text-sm text-muted-foreground">{copy.subtitle}</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {([
          ["day", copy.daily],
          ["month", copy.monthly],
          ["year", copy.yearly],
          ["custom", copy.custom],
        ] as [ProductComparisonPeriod, string][]).map(([value, label]) => (
          <Button
            key={value}
            type="button"
            size="sm"
            variant={period === value ? "default" : "outline"}
            onClick={() => setPeriod(value)}
            data-testid={`product-comparison-period-${value}`}
          >
            {label}
          </Button>
        ))}

        {period !== "custom" ? (
          <div className="ml-0 flex items-center gap-1 rounded-md border p-1 sm:ml-2">
            <Button
              type="button"
              size="sm"
              variant={direction === "previous" ? "secondary" : "ghost"}
              onClick={() => setDirection("previous")}
              data-testid="product-comparison-direction-previous"
            >
              {copy.previous}
            </Button>
            <ArrowLeftRight className="h-4 w-4 text-muted-foreground" />
            <Button
              type="button"
              size="sm"
              variant={direction === "next" ? "secondary" : "ghost"}
              onClick={() => setDirection("next")}
              data-testid="product-comparison-direction-next"
            >
              {copy.next}
            </Button>
          </div>
        ) : null}

        <div className="ml-0 flex items-center gap-1 rounded-md border p-1 sm:ml-auto">
          <Button
            type="button"
            size="sm"
            variant={metric === "bales" ? "secondary" : "ghost"}
            onClick={() => setMetric("bales")}
            data-testid="product-comparison-metric-bales"
          >
            <Package className="mr-1.5 h-4 w-4" />
            {copy.bales}
          </Button>
          <Button
            type="button"
            size="sm"
            variant={metric === "weight" ? "secondary" : "ghost"}
            onClick={() => setMetric("weight")}
            data-testid="product-comparison-metric-weight"
          >
            <Scale className="mr-1.5 h-4 w-4" />
            {copy.weight}
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="p-4">
          {period === "custom" ? (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {[
                { label: copy.periodA, value: customA, setter: setCustomA },
                { label: copy.periodB, value: customB, setter: setCustomB },
              ].map(({ label, value, setter }) => (
                <div key={label} className="space-y-2">
                  <p className="text-sm font-semibold">{label}</p>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <label className="space-y-1 text-xs text-muted-foreground">
                      <span>{copy.from}</span>
                      <input
                        type="date"
                        className="w-full rounded-md border bg-background px-3 py-2 text-sm text-foreground"
                        value={value[0]}
                        onChange={(event) => setter([event.target.value, value[1]])}
                      />
                    </label>
                    <label className="space-y-1 text-xs text-muted-foreground">
                      <span>{copy.to}</span>
                      <input
                        type="date"
                        className="w-full rounded-md border bg-background px-3 py-2 text-sm text-foreground"
                        value={value[1]}
                        onChange={(event) => setter([value[0], event.target.value])}
                      />
                    </label>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(220px,320px)_1fr] lg:items-end">
              <label className="space-y-1 text-xs text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <CalendarDays className="h-3.5 w-3.5" />
                  {period === "day" ? copy.day : period === "month" ? copy.month : copy.year}
                </span>
                {period === "day" ? (
                  <input
                    type="date"
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm text-foreground"
                    value={day}
                    onChange={(event) => setDay(event.target.value)}
                    data-testid="product-comparison-anchor-day"
                  />
                ) : period === "month" ? (
                  <input
                    type="month"
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm text-foreground"
                    value={month}
                    onChange={(event) => setMonth(event.target.value)}
                    data-testid="product-comparison-anchor-month"
                  />
                ) : (
                  <input
                    type="number"
                    min="1900"
                    max="2200"
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm text-foreground"
                    value={year}
                    onChange={(event) => setYear(event.target.value)}
                    data-testid="product-comparison-anchor-year"
                  />
                )}
              </label>

              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <div className="rounded-lg border bg-muted/20 p-3">
                  <p className="text-xs text-muted-foreground">{copy.selectedPeriod}</p>
                  <p className="mt-1 text-sm font-semibold">{selectedLabel}</p>
                </div>
                <div className="rounded-lg border bg-muted/20 p-3">
                  <p className="text-xs text-muted-foreground">{copy.comparisonPeriod}</p>
                  <p className="mt-1 text-sm font-semibold">{comparisonLabel}</p>
                </div>
              </div>
            </div>
          )}

          {period === "custom" && (!selectedRangeValid || !comparisonRangeValid) ? (
            <div className="mt-3 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{copy.invalidRange}</span>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center gap-2">
        <MultiSelectFilter
          options={categoryOptions}
          selected={selectedCategories}
          onChange={setSelectedCategories}
          placeholder={copy.categories}
          allLabel={copy.allCategories}
          className="w-full sm:w-48"
          testId="product-comparison-categories"
        />
        <MultiSelectFilter
          options={gradeOptions}
          selected={selectedGrades}
          onChange={setSelectedGrades}
          placeholder={copy.grades}
          allLabel={copy.allGrades}
          className="w-full sm:w-40"
          testId="product-comparison-grades"
        />
        <MultiSelectFilter
          options={productOptions}
          selected={selectedProducts}
          onChange={setSelectedProducts}
          placeholder={copy.products}
          allLabel={copy.selectProducts}
          className="w-full sm:w-[360px]"
          testId="product-comparison-products"
        />
        {(hasFilter || selectedProducts.length > 0) ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setSelectedCategories([]);
              setSelectedGrades([]);
              setSelectedProducts([]);
            }}
          >
            {copy.clear}
          </Button>
        ) : null}
      </div>

      {selectedCatalogRows.length > 0 ? (
        <div className="flex flex-wrap gap-2" aria-label={copy.selectedProducts}>
          {selectedCatalogRows.map((product) => {
            const key = productKey(product);
            return (
              <Badge key={key} variant="secondary" className="max-w-full gap-1.5 py-1">
                <span className="max-w-[260px] truncate">
                  {(product.articleCode || product.code || "").trim()} · {localizedProductName(product, language)}
                </span>
                <button
                  type="button"
                  className="rounded-full p-0.5 hover:bg-background/70"
                  onClick={() => setSelectedProducts((current) => current.filter((value) => value !== key))}
                  aria-label={`${copy.clear} ${localizedProductName(product, language)}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            );
          })}
        </div>
      ) : null}

      {selectedProducts.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex min-h-[240px] flex-col items-center justify-center p-8 text-center">
            <BarChart3 className="mb-3 h-10 w-10 text-muted-foreground" />
            <p className="font-semibold">{copy.noSelectionTitle}</p>
            <p className="mt-1 max-w-xl text-sm text-muted-foreground">{copy.noSelectionBody}</p>
          </CardContent>
        </Card>
      ) : (
        <>
          <ResponsiveMetricGrid>
            <Stat label={copy.selectedProducts} value={fmtNum(selectedProducts.length)} />
            <Stat label={copy.selectedTotal} value={formatMetric(totals.selected, metric)} sub={selectedLabel} />
            <Stat label={copy.comparisonTotal} value={formatMetric(totals.comparison, metric)} sub={comparisonLabel} />
            <Stat
              label={copy.difference}
              value={`${totals.difference > 0 ? "+" : ""}${formatMetric(totals.difference, metric)}`}
              sub={totals.change === null ? "N/A" : `${totals.change > 0 ? "+" : ""}${totals.change.toFixed(1)}%`}
            />
          </ResponsiveMetricGrid>

          {error ? (
            <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <p className="font-medium">{copy.loadFailed}</p>
                <p className="mt-0.5 text-xs opacity-80">{(error as Error).message}</p>
              </div>
            </div>
          ) : null}

          {isLoading ? (
            <ResponsiveReportGrid aria-label={copy.charts}>
              {selectedProducts.map((key) => (
                <Skeleton key={key} className="h-[410px] rounded-xl" />
              ))}
            </ResponsiveReportGrid>
          ) : !error ? (
            <ResponsiveReportGrid aria-label={copy.charts}>
              {selectedCatalogRows.map((product) => {
                const key = productKey(product);
                return (
                  <LazyProductChartCard
                    key={key}
                    product={product}
                    selectedRow={selectedRows.get(key)}
                    comparisonRow={comparisonRows.get(key)}
                    selectedLabel={selectedLabel}
                    comparisonLabel={comparisonLabel}
                    metric={metric}
                    language={language}
                    currentLabel={copy.current}
                    comparedLabel={copy.compared}
                    differenceLabel={copy.difference}
                    changeLabel={copy.change}
                    noProductionLabel={copy.noProduction}
                    inactiveLabel={copy.inactive}
                    balesLabel={copy.bales}
                    weightLabel={copy.weight}
                    chartRegionLabel={copy.chartRegion}
                  />
                );
              })}
            </ResponsiveReportGrid>
          ) : null}
        </>
      )}
    </div>
  );
}
