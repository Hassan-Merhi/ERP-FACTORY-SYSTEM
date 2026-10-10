import * as React from "react";

import { cn } from "@/lib/utils";

const ResponsiveReportPage = React.forwardRef<HTMLElement, React.HTMLAttributes<HTMLElement>>(
  ({ className, ...props }, ref) => (
    <section
      ref={ref}
      data-responsive-report-page="true"
      className={cn("flex min-w-0 max-w-full flex-col gap-4 sm:gap-5 lg:gap-6", className)}
      {...props}
    />
  )
);
ResponsiveReportPage.displayName = "ResponsiveReportPage";

const ResponsiveMetricGrid = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      data-responsive-metric-grid="true"
      className={cn(
        "grid min-w-0 grid-cols-1 gap-3 min-[420px]:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 *:min-w-0",
        className
      )}
      {...props}
    />
  )
);
ResponsiveMetricGrid.displayName = "ResponsiveMetricGrid";

const ResponsiveReportGrid = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      data-responsive-report-grid="true"
      className={cn("grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-2 *:min-w-0 *:max-w-full", className)}
      {...props}
    />
  )
);
ResponsiveReportGrid.displayName = "ResponsiveReportGrid";

const ResponsiveChartPanel = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      data-responsive-chart-panel="true"
      className={cn("min-w-0 max-w-full rounded-xl border bg-card p-3 shadow-xs sm:p-4", className)}
      {...props}
    />
  )
);
ResponsiveChartPanel.displayName = "ResponsiveChartPanel";

type ResponsiveChartViewportProps = React.HTMLAttributes<HTMLDivElement> & {
  label: string;
  minimumWidth?: string;
};

const ResponsiveChartViewport = React.forwardRef<HTMLDivElement, ResponsiveChartViewportProps>(
  ({ className, label, minimumWidth, style, children, ...props }, ref) => (
    <div
      ref={ref}
      role="region"
      aria-label={label}
      tabIndex={0}
      data-responsive-chart-viewport="true"
      className={cn(
        "max-w-full touch-pan-x overflow-x-auto overscroll-x-contain rounded-lg focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        className
      )}
      {...props}
    >
      <div className="min-w-0" style={{ minWidth: minimumWidth, ...style }}>
        {children}
      </div>
    </div>
  )
);
ResponsiveChartViewport.displayName = "ResponsiveChartViewport";

const ResponsiveChartHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn("mb-3 flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between", className)}
      {...props}
    />
  )
);
ResponsiveChartHeader.displayName = "ResponsiveChartHeader";

const ResponsiveChartTitle = React.forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h2 ref={ref} className={cn("min-w-0 wrap-break-word text-base font-semibold sm:text-lg", className)} {...props} />
  )
);
ResponsiveChartTitle.displayName = "ResponsiveChartTitle";

const ResponsiveChartDescription = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
  ({ className, ...props }, ref) => (
    <p ref={ref} className={cn("mt-1 min-w-0 wrap-break-word text-sm text-muted-foreground", className)} {...props} />
  )
);
ResponsiveChartDescription.displayName = "ResponsiveChartDescription";

const ResponsiveLegendList = React.forwardRef<HTMLUListElement, React.HTMLAttributes<HTMLUListElement>>(
  ({ className, ...props }, ref) => (
    <ul
      ref={ref}
      data-responsive-chart-legend="true"
      className={cn("grid min-w-0 grid-cols-1 gap-2 min-[420px]:grid-cols-2", className)}
      {...props}
    />
  )
);
ResponsiveLegendList.displayName = "ResponsiveLegendList";

export {
  ResponsiveChartDescription,
  ResponsiveChartHeader,
  ResponsiveChartPanel,
  ResponsiveChartTitle,
  ResponsiveChartViewport,
  ResponsiveLegendList,
  ResponsiveMetricGrid,
  ResponsiveReportGrid,
  ResponsiveReportPage,
};
