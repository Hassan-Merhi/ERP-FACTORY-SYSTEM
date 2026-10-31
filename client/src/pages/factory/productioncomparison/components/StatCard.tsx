import type { ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type CardTone = "emerald" | "blue" | "amber" | "violet" | "teal" | "neutral";

const toneClasses: Record<CardTone, { border: string; glow: string; icon: string }> = {
  emerald: {
    border: "border-emerald-500/35",
    glow: "bg-emerald-400/10",
    icon: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300",
  },
  blue: {
    border: "border-blue-500/35",
    glow: "bg-blue-400/10",
    icon: "bg-blue-500/15 text-blue-600 dark:text-blue-300",
  },
  amber: {
    border: "border-amber-500/35",
    glow: "bg-amber-400/10",
    icon: "bg-amber-500/15 text-amber-600 dark:text-amber-300",
  },
  violet: {
    border: "border-violet-500/35",
    glow: "bg-violet-400/10",
    icon: "bg-violet-500/15 text-violet-600 dark:text-violet-300",
  },
  teal: {
    border: "border-teal-500/35",
    glow: "bg-teal-400/10",
    icon: "bg-teal-500/15 text-teal-600 dark:text-teal-300",
  },
  neutral: {
    border: "border-border/70",
    glow: "bg-slate-400/5",
    icon: "bg-muted text-muted-foreground",
  },
};

export function StatCard({
  title,
  value,
  sub,
  valueClass,
  accent,
  tone,
  icon,
  extraLine,
}: {
  title: string;
  value: string;
  sub?: string;
  valueClass?: string;
  accent?: "green" | "red" | "neutral";
  tone?: CardTone;
  icon?: ReactNode;
  extraLine?: { label: string; value: string };
}) {
  const resolvedTone: CardTone = tone ?? (accent === "green" ? "emerald" : accent === "red" ? "neutral" : "neutral");
  const palette = toneClasses[resolvedTone];
  return (
    <Card
      className={cn(
        "relative isolate min-w-0 overflow-hidden rounded-2xl border bg-card shadow-sm transition-[border-color,box-shadow] hover:shadow-md dark:bg-[#111b29]",
        palette.border,
        accent === "red" && "border-red-500/40",
        accent === "green" && "border-emerald-500/40"
      )}
    >
      <div className={cn("pointer-events-none absolute -right-6 -top-8 h-24 w-24 rounded-full blur-2xl", palette.glow)} />
      <CardContent className="relative flex h-full min-h-[138px] flex-col justify-between gap-3 p-4">
        <div className="flex min-w-0 items-center gap-3">
          {icon && (
            <span className={cn("flex h-11 w-11 shrink-0 items-center justify-center rounded-xl", palette.icon)}>
              {icon}
            </span>
          )}
          <p className="min-w-0 text-xs font-semibold leading-snug text-muted-foreground">{title}</p>
        </div>
        <div className="min-w-0">
          <p className={cn("break-words text-[clamp(1.3rem,2vw,1.85rem)] font-extrabold leading-tight tracking-tight tabular-nums text-foreground", valueClass)}>
            {value}
          </p>
          {extraLine && (
            <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 text-xs">
              <span className="text-muted-foreground">{extraLine.label}</span>
              <span className="font-semibold tabular-nums text-foreground/80">{extraLine.value}</span>
            </div>
          )}
          {sub && <p className="mt-1.5 text-xs leading-snug text-muted-foreground">{sub}</p>}
        </div>
      </CardContent>
    </Card>
  );
}
