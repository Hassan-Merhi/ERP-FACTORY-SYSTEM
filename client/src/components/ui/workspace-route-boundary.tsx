import { Suspense, useEffect, useState, type ReactNode } from "react";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import { LoadingState } from "@/components/ui/page-state";
import { cn } from "@/lib/utils";

const workspaceConsistencyClasses = [
  // Reading width is capped on very wide screens (1800px and up, where the content column would
  // pass 1600px); wider tables keep their own sideways scroll inside it.
  "mx-auto w-full min-w-0 max-w-full min-[1800px]:max-w-[1600px]",
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

/** A timed recovery action for a lazy module or route that never resolves. */
function RouteLoadingFallback({ title, description, fill }: { title: string; description: string; fill?: boolean }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setSlow(true), 12_000);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div className={fill ? "h-full" : "p-3 sm:p-6"}>
      <LoadingState
        className={fill ? "h-full border-0 bg-transparent" : undefined}
        title={title}
        description={slow ? "This page is taking longer than expected. You can reload it safely." : description}
      />
      {slow && (
        <div className="mt-3 flex justify-center">
          <button
            type="button"
            className="rounded-md border border-border bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
            onClick={() => window.location.reload()}
          >
            Reload page
          </button>
        </div>
      )}
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
          // The workspace padding lives on the route content (not on the scroll container, so
          // sticky headers stick at its true top); the loading card needs the same inset.
          <RouteLoadingFallback title={loadingTitle} description={loadingDescription} fill={fill} />
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
