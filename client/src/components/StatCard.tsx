import { memo } from "react";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { LucideIcon, ArrowUpRight, ArrowDownRight, Minus } from "lucide-react";
import { cn } from "@/lib/utils";

export type StatTone =
  | "default"
  | "primary"
  | "success"
  | "warning"
  | "destructive"
  | "info"
  | "chart-2"
  | "chart-3"
  | "chart-4"
  | "chart-5";

const toneStyles: Record<StatTone, { bg: string; fg: string }> = {
  default: { bg: "bg-muted", fg: "text-foreground" },
  primary: { bg: "bg-primary/10", fg: "text-primary" },
  success: { bg: "bg-success-soft", fg: "text-success-soft-foreground" },
  warning: { bg: "bg-warning-soft", fg: "text-warning-soft-foreground" },
  destructive: { bg: "bg-destructive-soft", fg: "text-destructive" },
  info: { bg: "bg-info-soft", fg: "text-info-soft-foreground" },
  "chart-2": { bg: "bg-[hsl(var(--chart-2)/0.12)]", fg: "text-[hsl(var(--chart-2))]" },
  "chart-3": { bg: "bg-[hsl(var(--chart-3)/0.12)]", fg: "text-[hsl(var(--chart-3))]" },
  "chart-4": { bg: "bg-[hsl(var(--chart-4)/0.12)]", fg: "text-[hsl(var(--chart-4))]" },
  "chart-5": { bg: "bg-[hsl(var(--chart-5)/0.12)]", fg: "text-[hsl(var(--chart-5))]" },
};

export interface StatCardProps {
  title: string;
  value: React.ReactNode;
  change?: string;
  changeType?: "positive" | "negative" | "neutral";
  icon?: LucideIcon;
  tone?: StatTone;
  hint?: string;
  loading?: boolean;
  onClick?: () => void;
  className?: string;
  "data-testid"?: string;
}

/**
 * StatCard — canonical KPI tile used across all dashboards (ERP, POS, Factory,
 * Properties, etc). Provides a consistent grammar: title, big value, optional
 * delta, icon, and tone. Supports a loading skeleton state.
 */
function StatCardComponent({
  title,
  value,
  change,
  changeType = "neutral",
  icon: Icon,
  tone = "primary",
  hint,
  loading,
  onClick,
  className,
  "data-testid": testId,
}: StatCardProps) {
  const isClickable = !!onClick;
  const ChangeIcon = changeType === "positive" ? ArrowUpRight : changeType === "negative" ? ArrowDownRight : Minus;
  const t = toneStyles[tone];
  const slug = title
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!onClick || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    onClick();
  };

  return (
    <Card
      className={cn(
        "min-w-0 max-w-full p-3 sm:p-5",
        isClickable && "cursor-pointer hover-elevate active-elevate-2",
        className
      )}
      role={isClickable ? "button" : undefined}
      tabIndex={isClickable ? 0 : undefined}
      aria-label={isClickable ? `${title}: ${String(value)}` : undefined}
      onClick={onClick}
      onKeyDown={handleKeyDown}
      data-responsive-stat-card="true"
      data-testid={testId ?? `card-stat-${slug}`}
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <span className="min-w-0 break-words text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {title}
          </span>
          {loading ? (
            <Skeleton className="h-7 w-24 max-w-full" />
          ) : (
            <span
              className="min-w-0 break-words text-xl font-semibold leading-tight tracking-tight tabular-nums min-[360px]:text-2xl sm:text-3xl"
              data-testid={`text-stat-value-${slug}`}
            >
              {value}
            </span>
          )}
          {!loading && change && (
            <span
              className={cn(
                "inline-flex min-w-0 items-start gap-0.5 break-words text-xs font-medium tabular-nums",
                changeType === "positive"
                  ? "text-success"
                  : changeType === "negative"
                    ? "text-destructive"
                    : "text-muted-foreground"
              )}
              data-testid={`text-stat-delta-${slug}`}
            >
              <ChangeIcon className="mt-0.5 h-3 w-3 shrink-0" />
              <span className="min-w-0 break-words">{change}</span>
            </span>
          )}
          {!loading && hint && !change && (
            <span className="min-w-0 break-words text-xs text-muted-foreground">{hint}</span>
          )}
        </div>
        {Icon && (
          <div
            className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg sm:h-11 sm:w-11", t.bg, t.fg)}
            aria-hidden="true"
          >
            <Icon className="h-4.5 w-4.5 sm:h-5 sm:w-5" />
          </div>
        )}
      </div>
    </Card>
  );
}

export const StatCard = memo(StatCardComponent);
