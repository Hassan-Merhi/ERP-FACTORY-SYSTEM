/** Compact operational KPI card for OTW Tracking. */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function SummaryCard({
  label,
  value,
  icon,
  accent,
  helper,
}: {
  label: string;
  value: string | number;
  icon: ReactNode;
  accent?: string;
  helper?: string;
}) {
  return (
    <div className="group flex min-w-0 flex-col justify-between gap-3 overflow-hidden rounded-2xl border border-border/70 bg-card p-3.5 shadow-sm transition-colors hover:border-blue-500/25 dark:bg-[#101b2b] sm:p-4">
      <div className="flex items-start gap-3">
        <div className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-xl", accent ?? "bg-muted")}>
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-semibold text-muted-foreground" title={label}>{label}</p>
          <p className="mt-1 break-words text-xl font-bold leading-tight tracking-tight tabular-nums text-foreground" title={String(value)}>{value}</p>
        </div>
      </div>
      {helper && <p className="truncate pl-0.5 text-[11px] text-muted-foreground" title={helper}>{helper}</p>}
    </div>
  );
}
