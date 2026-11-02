/**
 * MiniPieChart — extracted sub-component.
 *
 * Extracted from DailyProductionReport.tsx during the Phase 4 god-file split.
 */
import { useMemo } from "react";
import { Boxes } from "lucide-react";
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from "recharts";
import { ResponsiveChartPanel, ResponsiveChartViewport, ResponsiveLegendList } from "@/components/ui/responsive-report";

export // ── Shared mini-pie renderer used by both new charts ──────────────────────
function MiniPieChart({
  title,
  allRows,
  classifyFn,
  order,
  colors,
  testId,
}: {
  title: string;
  allRows: { categoryName: string; totalWeightKg: number }[];
  classifyFn: (name: string) => string;
  order: string[];
  colors: Record<string, string>;
  testId: string;
}) {
  const grouped = useMemo(() => {
    const acc: Record<string, number> = {};
    for (const row of allRows) {
      const group = classifyFn(row.categoryName);
      if (group === "__skip__") continue;
      acc[group] = (acc[group] ?? 0) + row.totalWeightKg;
    }
    return acc;
  }, [allRows, classifyFn]);

  const slices = order
    .filter((group) => (grouped[group] ?? 0) > 0)
    .map((group) => ({ name: group, value: grouped[group]!, color: colors[group] ?? "#94a3b8" }));

  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  if (total === 0) return null;

  return (
    <ResponsiveChartPanel data-testid={testId} aria-label={`${title} chart`}>
      <div className="production-premium-chart-title"><Boxes className="h-4 w-4" aria-hidden="true" />{title}</div>
      <div className="grid min-w-0 grid-cols-1 items-center gap-4 lg:grid-cols-[minmax(0,1fr)_12rem]">
        <ResponsiveLegendList aria-label={`${title} legend`}>
          {slices.map((slice) => {
            const percentage = ((slice.value / total) * 100).toFixed(1);
            return (
              <li key={slice.name} className="flex min-w-0 items-start gap-2 rounded-lg bg-muted/30 p-2">
                <span
                  className="mt-1 h-2.5 w-2.5 shrink-0 rounded-xs"
                  style={{ background: slice.color }}
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1">
                  <span className="block wrap-break-word text-xs font-medium text-foreground">{slice.name}</span>
                  <span className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-muted-foreground tabular-nums">
                    <span className="font-semibold text-foreground">{percentage}%</span>
                    <span>{Math.round(slice.value).toLocaleString()} kg</span>
                  </span>
                </span>
              </li>
            );
          })}
        </ResponsiveLegendList>

        <ResponsiveChartViewport label={`${title} pie chart`} className="mx-auto w-full max-w-48">
          <div className="production-donut-area h-48 w-full min-w-0">
            <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={1}>
              <PieChart>
                <Pie
                  data={slices}
                  cx="50%"
                  cy="50%"
                  innerRadius={44}
                  outerRadius={74}
                  paddingAngle={2}
                  dataKey="value"
                  strokeWidth={0}
                >
                  {slices.map((slice) => (
                    <Cell key={slice.name} fill={slice.color} />
                  ))}
                </Pie>
                <Tooltip
                  formatter={(value) => [`${Math.round(Number(value)).toLocaleString()} kg`, ""]}
                  contentStyle={{ fontSize: 11, borderRadius: 6, maxWidth: "calc(100vw - 2rem)" }}
                />
              </PieChart>
            </ResponsiveContainer>
            <div className="production-donut-total" aria-hidden="true">{Math.round(total).toLocaleString()} kg<small>Total</small></div>
          </div>
        </ResponsiveChartViewport>
      </div>
    </ResponsiveChartPanel>
  );
}

// ─────────────────────────────────────────────
// Bale Ledger tab — types, helpers, component
// ─────────────────────────────────────────────
