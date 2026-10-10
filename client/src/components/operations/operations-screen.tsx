import * as React from "react";
import { AlertTriangle, CheckCircle2, Info, PackageSearch, Warehouse, type LucideIcon } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import {
  HorizontalScrollRegion,
  ResponsiveActions,
  ResponsiveToolbar,
  SkipLink,
} from "@/components/ui/responsive-accessibility";
import { cn } from "@/lib/utils";

type OperationsScreenProps = React.HTMLAttributes<HTMLElement> & {
  skipLinkLabel?: string;
};

export function OperationsScreen({
  className,
  children,
  skipLinkLabel = "Skip to operations content",
  ...props
}: OperationsScreenProps) {
  return (
    <>
      <SkipLink href="#main-content">{skipLinkLabel}</SkipLink>
      <main
        id="main-content"
        className={cn("min-w-0 space-y-5 px-3 py-4 sm:space-y-6 sm:px-4 sm:py-5 lg:px-6", className)}
        {...props}
      >
        {children}
      </main>
    </>
  );
}

type OperationsScreenHeaderProps = React.HTMLAttributes<HTMLElement> & {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: React.ReactNode;
  filters?: React.ReactNode;
  icon?: LucideIcon;
  actionsLabel?: string;
  filtersLabel?: string;
};

export function OperationsScreenHeader({
  eyebrow,
  title,
  description,
  actions,
  filters,
  icon: Icon = Warehouse,
  actionsLabel = "Operations page actions",
  filtersLabel = "Operations page filters",
  className,
  ...props
}: OperationsScreenHeaderProps) {
  const titleId = React.useId();
  return (
    <header aria-labelledby={titleId} className={cn("space-y-4", className)} {...props}>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 flex-1 gap-3">
          <div className="mt-0.5 shrink-0 rounded-lg bg-[hsl(var(--module-factory)/0.12)] p-2 text-[hsl(var(--module-factory))]">
            <Icon className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            {eyebrow ? (
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{eyebrow}</p>
            ) : null}
            <h1
              id={titleId}
              className="wrap-break-word text-2xl font-semibold tracking-tight text-foreground sm:text-3xl"
            >
              {title}
            </h1>
            {description ? (
              <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">{description}</p>
            ) : null}
          </div>
        </div>
        {actions ? <ResponsiveActions label={actionsLabel}>{actions}</ResponsiveActions> : null}
      </div>
      {filters ? <ResponsiveToolbar label={filtersLabel}>{filters}</ResponsiveToolbar> : null}
    </header>
  );
}

type OperationsSectionHeadingProps = React.HTMLAttributes<HTMLElement> & {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  actionsLabel?: string;
};

export function OperationsSectionHeading({
  title,
  description,
  actions,
  actionsLabel = "Section actions",
  className,
  ...props
}: OperationsSectionHeadingProps) {
  const titleId = React.useId();
  return (
    <section
      aria-labelledby={titleId}
      className={cn("flex min-w-0 flex-col gap-3 sm:flex-row sm:items-end sm:justify-between", className)}
      {...props}
    >
      <div className="min-w-0">
        <h2 id={titleId} className="wrap-break-word text-lg font-semibold tracking-tight text-foreground sm:text-xl">
          {title}
        </h2>
        {description ? <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <ResponsiveActions label={actionsLabel}>{actions}</ResponsiveActions> : null}
    </section>
  );
}

type OperationsMetricCardProps = React.HTMLAttributes<HTMLDivElement> & {
  label: string;
  value: React.ReactNode;
  detail?: React.ReactNode;
  icon?: LucideIcon;
  emphasize?: boolean;
};

export function OperationsMetricCard({
  label,
  value,
  detail,
  icon: Icon = PackageSearch,
  emphasize = false,
  className,
  ...props
}: OperationsMetricCardProps) {
  return (
    <Card className={cn("min-w-0", emphasize && "border-[hsl(var(--module-factory)/0.45)]", className)} {...props}>
      <CardContent className="flex items-start justify-between gap-3 p-4 sm:gap-4 sm:p-5">
        <div className="min-w-0 flex-1">
          <p className="wrap-break-word text-sm font-medium text-muted-foreground">{label}</p>
          <div className="mt-1 wrap-break-word text-xl font-semibold tabular-nums text-foreground sm:text-2xl">
            {value}
          </div>
          {detail ? <div className="mt-1 wrap-break-word text-xs leading-5 text-muted-foreground">{detail}</div> : null}
        </div>
        <div className="shrink-0 rounded-md bg-muted p-2 text-muted-foreground">
          <Icon className="h-4 w-4" aria-hidden="true" />
        </div>
      </CardContent>
    </Card>
  );
}

export function OperationsMetricGrid({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4", className)} {...props} />;
}

type OperationsStatusStripProps = React.HTMLAttributes<HTMLDivElement> & {
  label: string;
  value: React.ReactNode;
  tone?: "default" | "success" | "warning" | "info";
};

const statusToneClasses = {
  default: "border-border bg-muted/30 text-foreground",
  success: "border-success/30 bg-success/10 text-success",
  warning: "border-warning/30 bg-warning/10 text-warning",
  info: "border-info/30 bg-info/10 text-info",
} as const;

export function OperationsStatusStrip({
  label,
  value,
  tone = "default",
  className,
  ...props
}: OperationsStatusStripProps) {
  const StatusIcon = tone === "success" ? CheckCircle2 : tone === "warning" ? AlertTriangle : Info;
  return (
    <div
      role="status"
      aria-atomic="true"
      className={cn(
        "flex min-w-0 items-start gap-3 rounded-lg border px-3 py-2.5 text-sm",
        statusToneClasses[tone],
        className
      )}
      {...props}
    >
      <StatusIcon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1 sm:flex sm:items-center sm:justify-between sm:gap-4">
        <span className="font-medium">{label}</span>
        <span className="mt-0.5 block wrap-break-word tabular-nums sm:mt-0 sm:text-right">{value}</span>
      </div>
    </div>
  );
}

type OperationsTableShellProps = React.HTMLAttributes<HTMLDivElement> & {
  label?: string;
};

export function OperationsTableShell({
  label = "Operations data table",
  className,
  ...props
}: OperationsTableShellProps) {
  return <HorizontalScrollRegion label={label} className={cn("rounded-lg border bg-card", className)} {...props} />;
}

export function OperationsTableScroll({
  label = "Operations data table",
  className,
  ...props
}: OperationsTableShellProps) {
  return <HorizontalScrollRegion label={label} className={cn("w-full", className)} {...props} />;
}

export type {
  OperationsMetricCardProps,
  OperationsScreenHeaderProps,
  OperationsScreenProps,
  OperationsSectionHeadingProps,
  OperationsStatusStripProps,
  OperationsTableShellProps,
};
