import * as React from "react";

import { cn } from "@/lib/utils";

const CoreErpPage = React.forwardRef<HTMLElement, React.HTMLAttributes<HTMLElement>>(({ className, ...props }, ref) => (
  <section
    ref={ref}
    data-core-erp-page="true"
    className={cn("flex min-w-0 max-w-full flex-col gap-4 p-3 sm:gap-5 sm:p-4 lg:p-6", className)}
    {...props}
  />
));
CoreErpPage.displayName = "CoreErpPage";

const CoreErpHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      data-core-erp-header="true"
      className={cn("flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between", className)}
      {...props}
    />
  )
);
CoreErpHeader.displayName = "CoreErpHeader";

const CoreErpHeaderActions = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      role="group"
      aria-label="Page actions"
      data-core-erp-actions="true"
      className={cn(
        "grid w-full grid-cols-1 gap-2 min-[360px]:grid-cols-2 sm:flex sm:w-auto sm:flex-wrap sm:justify-end *:min-h-11 *:w-full sm:*:min-h-9 sm:*:w-auto",
        className
      )}
      {...props}
    />
  )
);
CoreErpHeaderActions.displayName = "CoreErpHeaderActions";

type CoreErpFilterGridProps = React.HTMLAttributes<HTMLDivElement> & {
  label?: string;
};

const CoreErpFilterGrid = React.forwardRef<HTMLDivElement, CoreErpFilterGridProps>(
  ({ className, label = "Page filters", ...props }, ref) => (
    <div
      ref={ref}
      role="search"
      aria-label={label}
      data-core-erp-filters="true"
      className={cn(
        "grid min-w-0 grid-cols-1 gap-3 rounded-lg border bg-card p-3 min-[420px]:grid-cols-2 lg:grid-cols-[repeat(auto-fit,minmax(12rem,1fr))] *:min-w-0 [&_button]:touch-manipulation",
        className
      )}
      {...props}
    />
  )
);
CoreErpFilterGrid.displayName = "CoreErpFilterGrid";

const CoreErpSummaryGrid = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      data-core-erp-summary="true"
      className={cn("grid min-w-0 grid-cols-1 gap-3 min-[420px]:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4", className)}
      {...props}
    />
  )
);
CoreErpSummaryGrid.displayName = "CoreErpSummaryGrid";

const CoreErpSummaryItem = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("min-w-0 rounded-lg border bg-card p-3 shadow-2xs sm:p-4", className)} {...props} />
  )
);
CoreErpSummaryItem.displayName = "CoreErpSummaryItem";

const CoreErpSummaryLabel = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
  ({ className, ...props }, ref) => (
    <p
      ref={ref}
      className={cn("wrap-break-word text-xs font-medium uppercase tracking-wide text-muted-foreground", className)}
      {...props}
    />
  )
);
CoreErpSummaryLabel.displayName = "CoreErpSummaryLabel";

const CoreErpSummaryValue = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
  ({ className, ...props }, ref) => (
    <p
      ref={ref}
      className={cn("mt-1 min-w-0 wrap-break-word text-xl font-semibold tabular-nums sm:text-2xl", className)}
      {...props}
    />
  )
);
CoreErpSummaryValue.displayName = "CoreErpSummaryValue";

const CoreErpContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} data-core-erp-content="true" className={cn("min-w-0 max-w-full", className)} {...props} />
  )
);
CoreErpContent.displayName = "CoreErpContent";

export {
  CoreErpContent,
  CoreErpFilterGrid,
  CoreErpHeader,
  CoreErpHeaderActions,
  CoreErpPage,
  CoreErpSummaryGrid,
  CoreErpSummaryItem,
  CoreErpSummaryLabel,
  CoreErpSummaryValue,
};
