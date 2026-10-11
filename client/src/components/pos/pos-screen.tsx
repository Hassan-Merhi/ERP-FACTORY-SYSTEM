import * as React from "react";
import { ShoppingCart, type LucideIcon } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import {
  HorizontalScrollRegion,
  ResponsiveActions,
  ResponsiveToolbar,
  SkipLink,
} from "@/components/ui/responsive-accessibility";
import { cn } from "@/lib/utils";

type PosScreenProps = React.HTMLAttributes<HTMLElement> & {
  as?: "main" | "section";
  label?: string;
};

export function PosScreen({
  as: Comp = "main",
  label = "Point of sale workspace",
  className,
  ...props
}: PosScreenProps) {
  return (
    <>
      {Comp === "main" ? <SkipLink /> : null}
      <Comp
        id={Comp === "main" ? "main-content" : undefined}
        aria-label={label}
        className={cn("min-w-0 space-y-4", className)}
        {...props}
      />
    </>
  );
}

type PosScreenHeaderProps = React.HTMLAttributes<HTMLElement> & {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  tools?: React.ReactNode;
  icon?: LucideIcon;
};

export function PosScreenHeader({
  title,
  description,
  actions,
  tools,
  icon: Icon = ShoppingCart,
  className,
  ...props
}: PosScreenHeaderProps) {
  const titleId = React.useId();
  return (
    <header aria-labelledby={titleId} className={cn("space-y-3", className)} {...props}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <div className="shrink-0 rounded-lg bg-primary/10 p-2 text-primary">
            <Icon className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h1 id={titleId} className="wrap-break-word text-2xl font-semibold tracking-tight sm:text-3xl">
              {title}
            </h1>
            {description ? (
              <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">{description}</p>
            ) : null}
          </div>
        </div>
        {actions ? <ResponsiveActions label="Point of sale actions">{actions}</ResponsiveActions> : null}
      </div>
      {tools ? <ResponsiveToolbar label="Point of sale tools">{tools}</ResponsiveToolbar> : null}
    </header>
  );
}

type PosMetricCardProps = React.HTMLAttributes<HTMLDivElement> & {
  label: string;
  value: React.ReactNode;
  detail?: React.ReactNode;
};

export function PosMetricCard({ label, value, detail, className, ...props }: PosMetricCardProps) {
  return (
    <Card className={cn("min-w-0", className)} {...props}>
      <CardContent className="p-4 sm:p-5">
        <p className="text-sm font-medium text-muted-foreground">{label}</p>
        <div className="mt-1 wrap-break-word text-2xl font-semibold tabular-nums">{value}</div>
        {detail ? <div className="mt-1 text-xs leading-5 text-muted-foreground">{detail}</div> : null}
      </CardContent>
    </Card>
  );
}

export function PosMetricGrid({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4", className)} {...props} />;
}

export function PosTableShell({
  label = "Point of sale table",
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { label?: string }) {
  return <HorizontalScrollRegion label={label} className={cn("rounded-lg border bg-card", className)} {...props} />;
}
