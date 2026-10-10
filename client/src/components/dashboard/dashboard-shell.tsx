import * as React from "react";
import type { LucideIcon } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { ResponsiveActions, ResponsiveGrid, ResponsiveToolbar } from "@/components/ui/responsive-accessibility";
import { cn } from "@/lib/utils";

type DashboardShellProps = React.HTMLAttributes<HTMLElement> & {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  filters?: React.ReactNode;
};

export function DashboardShell({
  title,
  description,
  actions,
  filters,
  className,
  children,
  ...props
}: DashboardShellProps) {
  const titleId = React.useId();

  return (
    <section aria-labelledby={titleId} className={cn("min-w-0 space-y-5", className)} {...props}>
      <header className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h1 id={titleId} className="wrap-break-word text-2xl font-semibold tracking-tight sm:text-3xl">
              {title}
            </h1>
            {description ? (
              <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">{description}</p>
            ) : null}
          </div>
          {actions ? <ResponsiveActions label="Dashboard actions">{actions}</ResponsiveActions> : null}
        </div>
        {filters ? <ResponsiveToolbar label="Dashboard filters">{filters}</ResponsiveToolbar> : null}
      </header>
      {children}
    </section>
  );
}

type DashboardMetricProps = React.HTMLAttributes<HTMLDivElement> & {
  label: string;
  value: React.ReactNode;
  detail?: React.ReactNode;
  icon?: LucideIcon;
};

export function DashboardMetric({ label, value, detail, icon: Icon, className, ...props }: DashboardMetricProps) {
  return (
    <Card className={cn("min-w-0", className)} {...props}>
      <CardContent className="p-4 sm:p-5">
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-muted-foreground">{label}</p>
            <div className="mt-1 wrap-break-word text-2xl font-semibold tabular-nums">{value}</div>
            {detail ? <div className="mt-1 text-xs leading-5 text-muted-foreground">{detail}</div> : null}
          </div>
          {Icon ? <Icon className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" /> : null}
        </div>
      </CardContent>
    </Card>
  );
}

export function DashboardMetricGrid({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <ResponsiveGrid minColumnWidth="15rem" className={cn("gap-3", className)} {...props} />;
}

export function DashboardSection({
  title,
  description,
  actions,
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLElement> & {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  const titleId = React.useId();
  return (
    <section aria-labelledby={titleId} className={cn("min-w-0 space-y-3", className)} {...props}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h2 id={titleId} className="text-lg font-semibold tracking-tight">
            {title}
          </h2>
          {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
        </div>
        {actions ? <ResponsiveActions label={`${title} actions`}>{actions}</ResponsiveActions> : null}
      </div>
      {children}
    </section>
  );
}

export type { DashboardShellProps, DashboardMetricProps };
