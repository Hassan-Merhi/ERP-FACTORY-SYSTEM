import { Suspense, type ReactNode } from "react";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import { LoadingState } from "@/components/ui/page-state";
import { cn } from "@/lib/utils";

const workspaceConsistencyClasses = [
  "w-full min-w-0 max-w-full",
  "[&_button]:touch-manipulation",
  "max-sm:[&_button]:min-h-11",
  "max-sm:[&_input]:min-h-11",
  "max-sm:[&_input]:text-base",
  "max-sm:[&_select]:min-h-11",
  "max-sm:[&_textarea]:min-h-24",
  "[&_form]:min-w-0",
  "[&_form]:max-w-full",
  "[&_fieldset]:min-w-0",
  "[&_img]:max-w-full",
  "[&_h1]:wrap-break-word",
  "[&_h2]:wrap-break-word",
  "**:[[role=alert]]:max-w-full",
  "**:[[role=dialog]]:max-w-[calc(100vw-1rem)]",
  "**:[[role=listbox]]:max-h-[min(24rem,70dvh)]",
  "**:[[role=tablist]]:max-w-full",
  "**:data-mobile-data-list:max-w-full",
  "**:data-table-scroll-region:max-w-full",
  "**:data-horizontal-scroll-region:max-w-full",
  "[&_table]:w-full",
  "[&_.overflow-x-auto]:overscroll-x-contain",
].join(" ");

interface WorkspaceConsistencyBoundaryProps {
  children: ReactNode;
  className?: string;
  fill?: boolean;
  routeKey?: string;
}

export function WorkspaceConsistencyBoundary({
  children,
  className,
  fill = false,
  routeKey,
}: WorkspaceConsistencyBoundaryProps) {
  return (
    <div
      data-ux-consistency-boundary="true"
      data-workspace-route={routeKey}
      className={cn(workspaceConsistencyClasses, fill && "h-full", className)}
    >
      {children}
    </div>
  );
}

interface WorkspaceRouteBoundaryProps extends WorkspaceConsistencyBoundaryProps {
  resetKey: string;
  loadingTitle: string;
  loadingDescription: string;
}

export function WorkspaceRouteBoundary({
  children,
  resetKey,
  loadingTitle,
  loadingDescription,
  className,
  fill,
}: WorkspaceRouteBoundaryProps) {
  return (
    <ErrorBoundary resetKey={resetKey}>
      <Suspense
        fallback={
          <LoadingState
            className={fill ? "h-full border-0 bg-transparent" : undefined}
            title={loadingTitle}
            description={loadingDescription}
          />
        }
      >
        <WorkspaceConsistencyBoundary className={className} fill={fill} routeKey={resetKey}>
          {children}
        </WorkspaceConsistencyBoundary>
      </Suspense>
    </ErrorBoundary>
  );
}

export { workspaceConsistencyClasses };
