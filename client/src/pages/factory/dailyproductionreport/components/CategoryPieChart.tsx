/**
 * CategoryPieChart — extracted sub-component.
 *
 * Extracted from DailyProductionReport.tsx during the Phase 4 god-file split.
 */
import { useMemo } from "react";
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from "recharts";
import { ResponsiveChartPanel, ResponsiveChartViewport, ResponsiveLegendList } from "@/components/ui/responsive-report";

import { GROUP_ORDER, PIE_COLORS, classifyCategory } from "../utils";

export function CategoryPieChart({
  byCategory,
  wipersGarbageKg,
}: {
  byCategory: { categoryName: string; totalWeightKg: number }[];
  wipersGarbageKg: number;
}) {
  const grouped = useMemo(() => {
    const acc: Record<string, number> = {};
    for (const cat of byCategory) {
      const group = classifyCategory(cat.categoryName);
      if (group === "__skip__") continue;
      acc[group] = (acc[group] ?? 0) + cat.totalWeightKg;
    }
    if (wipersGarbageKg > 0) {
      acc["Wipers & Garbage"] = (acc["Wipers & Garbage"] ?? 0) + wipersGarbageKg;
    }
    return acc;
  }, [byCategory, wipersGarbageKg]);

  const slices = GROUP_ORDER.filter((g) => (grouped[g] ?? 0) > 0).map((g) => ({
    name: g,
    value: grouped[g] ?? 0,
    color: PIE_COLORS[GROUP_ORDER.indexOf(g) % PIE_COLORS.length],
  }));

  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  if (total === 0) return null;

  return (
    <ResponsiveChartPanel data-testid="card-category-pie" aria-label="Production weight by category">
      <div className="grid min-w-0 grid-cols-1 items-center gap-4 lg:grid-cols-[minmax(0,1fr)_13rem]">
        <ResponsiveLegendList aria-label="Category chart legend">
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

        <ResponsiveChartViewport label="Production category pie chart" className="mx-auto w-full max-w-52">
          <div className="h-52 w-full min-w-0">
            <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={1}>
              <PieChart>
                <Pie
                  data={slices}
                  cx="50%"
                  cy="50%"
                  innerRadius={48}
                  outerRadius={82}
                  paddingAngle={2}
                  dataKey="value"
                  strokeWidth={0}
                >
                  {slices.map((slice) => (
                    <Cell key={slice.name} fill={slice.color} />
                  ))}
                </Pie>
                <Tooltip
                  formatter={(value: number) => [`${Math.round(value).toLocaleString()} kg`, ""]}
                  contentStyle={{ fontSize: 11, borderRadius: 6, maxWidth: "calc(100vw - 2rem)" }}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </ResponsiveChartViewport>
      </div>
    </ResponsiveChartPanel>
  );
}

// ── Shared mini-pie renderer used by both new charts ──────────────────────
