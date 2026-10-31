import type { SupplierDayRow } from "../types";
import { fmtKg } from "../utils";

/** Compact visual of observed daily supplier usage in the CURRENT selected period. */
export function SupplierDailyTrend({ rows, supplier, increased }: {
  rows: SupplierDayRow[];
  supplier?: string;
  increased: boolean;
}) {
  const byDate = new Map<string, number>();
  for (const row of rows) {
    if (supplier && row.supplierName !== supplier) continue;
    byDate.set(row.date, (byDate.get(row.date) ?? 0) + row.totalKg);
  }
  const points = [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  if (!points.length) return <span className="text-xs text-muted-foreground">—</span>;
  const max = Math.max(...points.map(([, value]) => value), 1);
  const lastIndex = points.length - 1;
  const x = (i: number) => lastIndex === 0 ? 58 : 3 + (i / lastIndex) * 111;
  const y = (value: number) => 30 - (value / max) * 24;
  const line = points.map(([, val], i) => x(i).toFixed(1) + "," + y(val).toFixed(1)).join(" ");
  const color = increased ? "#10b981" : "#fb7185";
  const start = points[0];
  const end = points[lastIndex];

  return (
    <svg
      role="img"
      aria-label={(supplier || "All suppliers") + ": observed daily weight " + fmtKg(start[1]) + " kg on " + start[0] + " to " + fmtKg(end[1]) + " kg on " + end[0]}
      viewBox="0 0 116 35"
      className="ml-auto h-9 w-28"
    >
      <title>Daily material usage for the selected period (observed dates only)</title>
      {points.length === 1 ? (
        <circle cx="58" cy={y(start[1])} r="3" fill={color} />
      ) : (
        <>
          <polyline points={line} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx={x(lastIndex)} cy={y(end[1])} r="3" fill={color} />
        </>
      )}
    </svg>
  );
}
