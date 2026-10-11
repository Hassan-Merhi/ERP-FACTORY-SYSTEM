import * as React from "react";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { HorizontalScrollRegion, ResponsiveActions, ResponsiveToolbar } from "@/components/ui/responsive-accessibility";
import { cn } from "@/lib/utils";

type FinancialScreenProps = React.HTMLAttributes<HTMLElement> & {
  as?: "main" | "section" | "div";
};

export function FinancialScreen({ as: Comp = "main", className, ...props }: FinancialScreenProps) {
  return (
    <Comp
      id={Comp === "main" ? "main-content" : undefined}
      className={cn("min-w-0 space-y-6 px-3 py-4 sm:px-4 sm:py-5 lg:px-6 lg:py-6", className)}
      {...props}
    />
  );
}

type FinancialScreenHeaderProps = React.HTMLAttributes<HTMLElement> & {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  filters?: React.ReactNode;
  actionsLabel?: string;
  filtersLabel?: string;
};

export function FinancialScreenHeader({
  title,
  description,
  actions,
  filters,
  actionsLabel = "Financial page actions",
  filtersLabel = "Financial page filters",
  className,
  ...props
}: FinancialScreenHeaderProps) {
  const titleId = React.useId();
  return (
    <header aria-labelledby={titleId} className={cn("space-y-4", className)} {...props}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <h1
            id={titleId}
            className="wrap-break-word text-2xl font-semibold tracking-tight text-foreground sm:text-3xl"
          >
            {title}
          </h1>
          {description ? <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">{description}</p> : null}
        </div>
        {actions ? <ResponsiveActions label={actionsLabel}>{actions}</ResponsiveActions> : null}
      </div>
      {filters ? <ResponsiveToolbar label={filtersLabel}>{filters}</ResponsiveToolbar> : null}
    </header>
  );
}

type FinancialSectionHeaderProps = React.HTMLAttributes<HTMLDivElement> & {
  title: string;
  description?: string;
  actions?: React.ReactNode;
};

export function FinancialSectionHeader({
  title,
  description,
  actions,
  className,
  ...props
}: FinancialSectionHeaderProps) {
  const titleId = React.useId();
  return (
    <div
      aria-labelledby={titleId}
      className={cn("flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between", className)}
      {...props}
    >
      <div className="min-w-0 flex-1">
        <h2 id={titleId} className="wrap-break-word text-lg font-semibold tracking-tight text-foreground sm:text-xl">
          {title}
        </h2>
        {description ? <p className="mt-1 text-sm leading-6 text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <ResponsiveActions label={`${title} actions`}>{actions}</ResponsiveActions> : null}
    </div>
  );
}

type FinancialSummaryCardProps = React.HTMLAttributes<HTMLDivElement> & {
  label: string;
  value: React.ReactNode;
  description?: string;
  trend?: "up" | "down" | "flat";
  trendLabel?: string;
  tone?: "default" | "success" | "warning" | "destructive" | "info";
};

const toneClasses = {
  default: "text-foreground",
  success: "text-success",
  warning: "text-warning",
  destructive: "text-destructive",
  info: "text-info",
} as const;

export function FinancialSummaryCard({
  label,
  value,
  description,
  trend,
  trendLabel,
  tone = "default",
  className,
  ...props
}: FinancialSummaryCardProps) {
  const TrendIcon = trend === "up" ? ArrowUpRight : trend === "down" ? ArrowDownRight : Minus;
  return (
    <Card className={cn("min-w-0", className)} {...props}>
      <CardHeader className="space-y-1 p-4 pb-2 sm:p-6 sm:pb-2">
        <CardDescription>{label}</CardDescription>
        <CardTitle className={cn("wrap-break-word text-xl font-semibold tabular-nums sm:text-2xl", toneClasses[tone])}>
          {value}
        </CardTitle>
      </CardHeader>
      {description || trendLabel ? (
        <CardContent className="px-4 pb-4 pt-0 sm:px-6 sm:pb-6">
          {trendLabel ? (
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <TrendIcon className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{trendLabel}</span>
            </div>
          ) : null}
          {description ? (
            <p className="mt-1 wrap-break-word text-xs leading-5 text-muted-foreground">{description}</p>
          ) : null}
        </CardContent>
      ) : null}
    </Card>
  );
}

export function FinancialSummaryGrid({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4", className)} {...props} />;
}

type FinancialStatusStripProps = React.HTMLAttributes<HTMLDivElement> & {
  label: string;
  value: React.ReactNode;
  description?: React.ReactNode;
  tone?: "default" | "success" | "warning" | "destructive" | "info";
};

export function FinancialStatusStrip({
  label,
  value,
  description,
  tone = "default",
  className,
  ...props
}: FinancialStatusStripProps) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-1 rounded-lg border bg-card px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4",
        className
      )}
      {...props}
    >
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{label}</p>
        {description ? <div className="mt-0.5 text-xs leading-5 text-muted-foreground">{description}</div> : null}
      </div>
      <div className={cn("shrink-0 wrap-break-word text-lg font-semibold tabular-nums", toneClasses[tone])}>
        {value}
      </div>
    </div>
  );
}

type FinancialTableShellProps = React.HTMLAttributes<HTMLDivElement> & {
  label?: string;
  scrollDescription?: string;
};

export function FinancialTableShell({
  label = "Financial data table",
  scrollDescription,
  className,
  ...props
}: FinancialTableShellProps) {
  return (
    <HorizontalScrollRegion
      label={label}
      description={scrollDescription}
      className={cn("rounded-lg border bg-card", className)}
      {...props}
    />
  );
}

export type {
  FinancialScreenHeaderProps,
  FinancialScreenProps,
  FinancialSectionHeaderProps,
  FinancialStatusStripProps,
  FinancialSummaryCardProps,
  FinancialTableShellProps,
};
