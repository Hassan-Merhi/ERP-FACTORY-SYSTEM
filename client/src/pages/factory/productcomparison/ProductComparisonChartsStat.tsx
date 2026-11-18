// Extracted from ./ProductComparisonCharts.tsx to keep that module under the source-size cap.
import { type ComponentProps, memo, useEffect, useRef, useState } from "react";
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Layers3, Package, TrendingDown, TrendingUp } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ResponsiveChartPanel, ResponsiveChartViewport } from "@/components/ui/responsive-report";
import type { ProductRow } from "@/pages/factory/productioncomparison/types";
import { fmtKg, fmtNum, pctChange } from "@/pages/factory/productioncomparison/utils";
import { type ComparisonRange, isValidComparisonRange, parseLocalIsoDate, type ProductComparisonPeriod } from "./utils";

export type Metric = "bales" | "weight";

export interface BaleProductCatalogRow {
  id: number;
  code?: string | null;
  articleCode?: string | null;
  name?: string | null;
  nameAr?: string | null;
  nameFr?: string | null;
  categoryId?: number | null;
  active?: boolean | null;
}

export interface CategoryRow {
  id: number;
  name: string;
  nameAr?: string | null;
  nameFr?: string | null;
}

function normalizeArticle(value: string | null | undefined): string {
  return (value || "").trim().toUpperCase();
}

export function productKey(product: BaleProductCatalogRow): string {
  return normalizeArticle(product.articleCode || product.code);
}

export function reportMap(rows: ProductRow[] | undefined): Map<string, ProductRow> {
  const map = new Map<string, ProductRow>();
  for (const row of rows ?? []) {
    map.set(normalizeArticle(row.articleCode), row);
  }
  return map;
}

export function formatMetric(value: number, metric: Metric): string {
  return metric === "bales" ? fmtNum(value) : `${fmtKg(value)} kg`;
}

export function metricValue(row: ProductRow | undefined, metric: Metric): number {
  if (!row) return 0;
  return metric === "bales" ? row.qty : row.totalWeightKg;
}

export function localeFor(language: "en" | "ar" | "fr"): string {
  if (language === "ar") return "ar";
  if (language === "fr") return "fr-FR";
  return "en-US";
}

export function localizedProductName(product: BaleProductCatalogRow, language: "en" | "ar" | "fr"): string {
  if (language === "ar" && product.nameAr?.trim()) return product.nameAr.trim();
  if (language === "fr" && product.nameFr?.trim()) return product.nameFr.trim();
  return product.name?.trim() || product.articleCode?.trim() || product.code?.trim() || String(product.id);
}

export function localizedCategoryName(category: CategoryRow, language: "en" | "ar" | "fr"): string {
  if (language === "ar" && category.nameAr?.trim()) return category.nameAr.trim();
  if (language === "fr" && category.nameFr?.trim()) return category.nameFr.trim();
  return category.name;
}

export function formatRangeLabel(range: ComparisonRange, period: ProductComparisonPeriod, locale: string): string {
  // Date inputs can briefly be empty while the user edits a custom range.
  // Never pass an invalid Date into Intl.DateTimeFormat because it throws "Invalid time value".
  if (!isValidComparisonRange(range)) return "—";

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

type StatKind = "products" | "selected" | "compared" | "difference";

type StatTone = "violet" | "blue" | "green" | "rose";

export function Stat({
  label,
  value,
  sub,
  kind,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  kind: StatKind;
  tone: StatTone;
}) {
  const Icon =
    kind === "products" ? Layers3 : kind === "selected" ? Package : kind === "compared" ? TrendingUp : TrendingDown;

  return (
    <Card className={`pc-stat-card pc-stat-card--${tone} min-w-0`}>
      <CardContent className="flex h-full min-h-[112px] items-center gap-3 p-4 sm:p-5">
        <span className="pc-stat-icon" aria-hidden="true">
          <Icon className="h-6 w-6" />
        </span>
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide pc-stat-label">{label}</p>
          <p className="mt-1 break-words text-2xl font-extrabold tabular-nums tracking-tight">{value}</p>
          {sub ? <p className="mt-0.5 break-words text-xs pc-stat-sub">{sub}</p> : null}
        </div>
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
  notAvailableLabel,
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
  notAvailableLabel: string;
}) {
  const selectedValue = metricValue(selectedRow, metric);
  const comparisonValue = metricValue(comparisonRow, metric);
  const difference = selectedValue - comparisonValue;
  const change = pctChange(selectedValue, comparisonValue);
  const localizedName = localizedProductName(product, language);
  const chartData = [
    { period: selectedLabel, value: selectedValue },
    { period: comparisonLabel, value: comparisonValue },
  ];

  return (
    <ResponsiveChartPanel
      className="pc-product-chart min-h-[410px]"
      data-testid={`product-comparison-chart-${product.id}`}
      style={{ contentVisibility: "auto", containIntrinsicSize: "410px" }}
    >
      <div className="mb-3 flex min-w-0 items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="pc-product-icon" aria-hidden="true">
            <Package className="h-4 w-4" />
          </span>
          <h3 className="min-w-0 wrap-break-word text-base font-bold">{localizedName}</h3>
        </div>
        {product.active === false ? (
          <Badge variant="outline" className="shrink-0">
            {inactiveLabel}
          </Badge>
        ) : null}
      </div>

      <div className="mb-3 grid grid-cols-2 gap-2 text-xs">
        <div className="pc-value-card pc-value-card--selected p-3">
          <p className="flex items-center gap-1.5 text-muted-foreground">
            <span className="h-2.5 w-2.5 rounded-full pc-value-dot--selected" aria-hidden="true" />
            {currentLabel}
          </p>
          <p className="mt-1 text-base font-bold tabular-nums">{formatMetric(selectedValue, metric)}</p>
        </div>
        <div className="pc-value-card pc-value-card--compared p-3">
          <p className="flex items-center gap-1.5 text-muted-foreground">
            <span className="h-2.5 w-2.5 rounded-full pc-value-dot--compared" aria-hidden="true" />
            {comparedLabel}
          </p>
          <p className="mt-1 font-semibold tabular-nums">{formatMetric(comparisonValue, metric)}</p>
        </div>
      </div>

      <ResponsiveChartViewport label={`${chartRegionLabel}: ${localizedName}`}>
        <div className="h-[245px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ top: 12, right: 12, left: 0, bottom: 8 }}>
              <defs>
                <linearGradient id={`pc-current-bar-${product.id}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--pc-bar-blue-top)" />
                  <stop offset="100%" stopColor="var(--pc-bar-blue-bottom)" />
                </linearGradient>
                <linearGradient id={`pc-compared-bar-${product.id}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--pc-bar-green-top)" />
                  <stop offset="100%" stopColor="var(--pc-bar-green-bottom)" />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="var(--pc-chart-grid)" strokeDasharray="3 4" vertical={false} />
              <XAxis dataKey="period" tick={{ fontSize: 11, fill: "var(--pc-chart-label)" }} interval={0} />
              <YAxis
                allowDecimals={metric === "weight"}
                tick={{ fontSize: 11, fill: "var(--pc-chart-label)" }}
                tickFormatter={(value) => (metric === "bales" ? fmtNum(Number(value)) : fmtKg(Number(value)))}
              />
              <Tooltip
                contentStyle={{
                  background: "var(--pc-tooltip-bg)",
                  border: "1px solid var(--pc-border)",
                  color: "var(--pc-text)",
                  borderRadius: 12,
                }}
                labelStyle={{ color: "var(--pc-text)" }}
                formatter={(value) => [
                  formatMetric(Number(value), metric),
                  metric === "bales" ? balesLabel : weightLabel,
                ]}
              />
              <Bar dataKey="value" radius={[6, 6, 0, 0]} maxBarSize={96}>
                <Cell fill={`url(#pc-current-bar-${product.id})`} />
                <Cell fill={`url(#pc-compared-bar-${product.id})`} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </ResponsiveChartViewport>

      <div className="pc-chart-footer mt-3 grid grid-cols-2 gap-2 border-t pt-3 text-xs">
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
            {change === null ? notAvailableLabel : `${change > 0 ? "+" : ""}${change.toFixed(1)}%`}
          </p>
        </div>
      </div>

      {selectedValue === 0 && comparisonValue === 0 ? (
        <p className="mt-3 text-center text-xs text-muted-foreground">{noProductionLabel}</p>
      ) : null}
    </ResponsiveChartPanel>
  );
});

export function LazyProductChartCard(props: ComponentProps<typeof ProductChartCard>) {
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
