// Extracted from ./ProductComparisonCharts.tsx to keep that module under the source-size cap.
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CalendarDays } from "lucide-react";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { getFactoryProductComparisonCopy } from "@/i18n/factoryProductComparisonTranslations";
import { Card, CardContent } from "@/components/ui/card";
import type { ReportData } from "@/pages/factory/productioncomparison/types";
import { deriveGrade, pctChange } from "@/pages/factory/productioncomparison/utils";
import {
  buildAutomaticComparisonRanges,
  type ComparisonDirection,
  currentDayValue,
  currentMonthValue,
  currentYearValue,
  isValidComparisonRange,
  type ProductComparisonPeriod,
} from "./utils";
import {
  formatRangeLabel,
  localeFor,
  localizedCategoryName,
  localizedProductName,
  metricValue,
  productKey,
  reportMap,
  type BaleProductCatalogRow,
  type CategoryRow,
  type Metric,
} from "./ProductComparisonChartsStat";

export function useProductComparisonChartsState() {
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

  const activeCatalog = useMemo(() => catalog.filter((product) => product.active !== false), [catalog]);

  useEffect(() => {
    if (catalog.length === 0) return;

    const activeKeys = new Set(activeCatalog.map(productKey).filter(Boolean));
    setSelectedProducts((current) => {
      const next = current.filter((key) => activeKeys.has(key));
      return next.length === current.length ? current : next;
    });
  }, [catalog.length, activeCatalog]);

  const ranges = useMemo(() => {
    if (period === "custom") {
      return {
        selected: { from: customA[0], to: customA[1] },
        comparison: { from: customB[0], to: customB[1] },
      };
    }
    return buildAutomaticComparisonRanges(period, direction, { day, month, year });
  }, [period, direction, day, month, year, customA, customB]);

  const selectedRangeValid = isValidComparisonRange(ranges.selected);
  const comparisonRangeValid = isValidComparisonRange(ranges.comparison);
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

  const gradeOptions = useMemo(() => {
    const grades = new Set<string>();
    for (const product of activeCatalog) {
      const grade = deriveGrade(product.articleCode || product.code || "");
      if (grade !== "—") grades.add(grade);
    }
    return [...grades].sort();
  }, [activeCatalog]);

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
    for (const product of activeCatalog) {
      const key = productKey(product);
      if (key) map.set(key, product);
    }
    return map;
  }, [activeCatalog]);

  const productOptions = useMemo(() => {
    return activeCatalog
      .filter((product) => {
        const key = productKey(product);
        if (!key) return false;
        if (selectedProducts.includes(key)) return true;
        if (selectedCategories.length > 0 && !selectedCategories.includes(String(product.categoryId ?? "")))
          return false;
        const grade = deriveGrade(product.articleCode || product.code || "");
        if (selectedGrades.length > 0 && !selectedGrades.includes(grade)) return false;
        return true;
      })
      .map((product) => ({
        value: productKey(product),
        label: localizedProductName(product, language),
      }))
      .sort((a, b) => a.label.localeCompare(b.label, locale));
  }, [activeCatalog, selectedProducts, selectedCategories, selectedGrades, language, locale]);

  const selectedRows = useMemo(() => reportMap(selectedReport.data?.production.byProduct), [selectedReport.data]);
  const comparisonRows = useMemo(() => reportMap(comparisonReport.data?.production.byProduct), [comparisonReport.data]);

  const selectedLabel = formatRangeLabel(ranges.selected, period, locale);
  const comparisonLabel = formatRangeLabel(ranges.comparison, period, locale);

  const selectedCatalogRows = useMemo(
    () =>
      selectedProducts
        .map((key) => catalogByKey.get(key))
        .filter((product): product is BaleProductCatalogRow => !!product),
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
  return {
    categoryOptions,
    comparisonLabel,
    comparisonRangeValid,
    comparisonRows,
    copy,
    customA,
    customB,
    day,
    direction,
    error,
    gradeOptions,
    hasFilter,
    isLoading,
    language,
    metric,
    month,
    period,
    productOptions,
    ranges,
    selectedCatalogRows,
    selectedCategories,
    selectedGrades,
    selectedLabel,
    selectedProducts,
    selectedRangeValid,
    selectedRows,
    setCustomA,
    setCustomB,
    setDay,
    setDirection,
    setMetric,
    setMonth,
    setPeriod,
    setSelectedCategories,
    setSelectedGrades,
    setSelectedProducts,
    setYear,
    totals,
    year,
  };
}

export function ProductComparisonChartsCardSection({
  comparisonLabel,
  comparisonRangeValid,
  copy,
  customA,
  customB,
  day,
  month,
  period,
  selectedLabel,
  selectedRangeValid,
  setCustomA,
  setCustomB,
  setDay,
  setMonth,
  setYear,
  year,
}: Pick<
  ReturnType<typeof useProductComparisonChartsState>,
  | "comparisonLabel"
  | "comparisonRangeValid"
  | "copy"
  | "customA"
  | "customB"
  | "day"
  | "month"
  | "period"
  | "selectedLabel"
  | "selectedRangeValid"
  | "setCustomA"
  | "setCustomB"
  | "setDay"
  | "setMonth"
  | "setYear"
  | "year"
>) {
  return (
    <Card className="pc-date-panel">
      <CardContent className="p-4 sm:p-5">
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
                      className="pc-date-input w-full rounded-lg border px-3 py-2 text-sm"
                      value={value[0]}
                      onChange={(event) => setter([event.target.value, value[1]])}
                    />
                  </label>
                  <label className="space-y-1 text-xs text-muted-foreground">
                    <span>{copy.to}</span>
                    <input
                      type="date"
                      className="pc-date-input w-full rounded-lg border px-3 py-2 text-sm"
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
                  className="pc-date-input w-full rounded-lg border px-3 py-2 text-sm"
                  value={day}
                  onChange={(event) => setDay(event.target.value)}
                  data-testid="product-comparison-anchor-day"
                />
              ) : period === "month" ? (
                <input
                  type="month"
                  className="pc-date-input w-full rounded-lg border px-3 py-2 text-sm"
                  value={month}
                  onChange={(event) => setMonth(event.target.value)}
                  data-testid="product-comparison-anchor-month"
                />
              ) : (
                <input
                  type="number"
                  min="1900"
                  max="2200"
                  className="pc-date-input w-full rounded-lg border px-3 py-2 text-sm"
                  value={year}
                  onChange={(event) => setYear(event.target.value)}
                  data-testid="product-comparison-anchor-year"
                />
              )}
            </label>

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div className="pc-period-summary rounded-xl border p-3">
                <p className="text-xs text-muted-foreground">{copy.selectedPeriod}</p>
                <p className="mt-1 text-sm font-semibold">{selectedLabel}</p>
              </div>
              <div className="pc-period-summary pc-period-summary--comparison rounded-xl border p-3">
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
  );
}
