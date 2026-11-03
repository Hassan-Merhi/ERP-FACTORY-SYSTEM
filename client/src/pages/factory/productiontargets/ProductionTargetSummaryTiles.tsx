import type React from "react";
import { Card, CardContent } from "@/components/ui/card";

export function SummaryTile({ label, value, icon }: { label: string; value: string | number; icon: React.ReactNode }) {
  return (
    <Card className="h-full shadow-none sm:col-span-1 xl:col-span-1">
      <CardContent className="flex min-h-[108px] items-center justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
          <p className="mt-2 text-3xl font-semibold leading-none tabular-nums">{value}</p>
        </div>
        <div className="shrink-0 rounded-lg border bg-muted/30 p-2 text-muted-foreground">{icon}</div>
      </CardContent>
    </Card>
  );
}

export function SummaryGroupTile({
  label,
  icon,
  metrics,
}: {
  label: string;
  icon: React.ReactNode;
  metrics: Array<{ label: string; value: string | number; title?: string }>;
}) {
  return (
    <Card className="h-full overflow-hidden shadow-none sm:col-span-2 xl:col-span-2">
      <CardContent className="px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <p className="min-w-0 truncate text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
          <div className="shrink-0 rounded-lg border bg-muted/30 p-2 text-muted-foreground">{icon}</div>
        </div>
        <div className="mt-3 grid w-full grid-cols-3 gap-2">
          {metrics.map((metric) => (
            <div
              key={metric.label}
              className="min-w-0 rounded-lg border border-border/60 bg-muted/20 px-2.5 py-2.5 text-center"
              title={metric.title ?? metric.label}
            >
              <p className="truncate text-[11px] font-semibold uppercase tracking-wide text-muted-foreground sm:text-xs">
                {metric.label}
              </p>
              <p
                className="mt-2 text-2xl font-semibold leading-none tabular-nums sm:text-3xl"
                title={String(metric.value)}
              >
                {metric.value}
              </p>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
