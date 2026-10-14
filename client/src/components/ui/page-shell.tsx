import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * One underlying page container for all application modules. Layout variants
 * preserve the pre-existing spacing of their legacy wrappers.
 *
 * Use "workspace" for new authenticated screens. "padded" is retained for
 * existing report pages and "core-erp" for the full-width ERP phone layout.
 */
export type PageShellLayout = "padded" | "workspace" | "core-erp";
export interface PageShellProps extends React.HTMLAttributes<HTMLElement> {
  layout?: PageShellLayout;
  as?: "div" | "section";
}

const PAGE_SHELL_CLASSES: Record<PageShellLayout, string> = {
  padded: "space-y-6 p-3 sm:p-6",
  workspace: "min-w-0 space-y-5 sm:space-y-6",
  "core-erp": "flex min-w-0 max-w-full flex-col gap-4 p-3 sm:gap-5 sm:p-4 lg:p-6",
};

export const PageShell = React.forwardRef<HTMLElement, PageShellProps>(
  ({ layout = "padded", as = "div", className, ...props }, ref) => {
    const classes = cn(PAGE_SHELL_CLASSES[layout], className);
    if (as === "section") return <section ref={ref} className={classes} {...props} />;
    return <div ref={ref as React.Ref<HTMLDivElement>} className={classes} {...props} />;
  }
);
PageShell.displayName = "PageShell";

export type PageActionsLayout = "compact" | "responsive";
export interface PageActionsProps extends React.HTMLAttributes<HTMLDivElement> {
  layout?: PageActionsLayout;
}
const PAGE_ACTION_CLASSES: Record<PageActionsLayout, string> = {
  compact: "flex flex-wrap items-center gap-2",
  responsive:
    "flex w-full min-w-0 flex-col-reverse gap-2 min-[360px]:grid min-[360px]:grid-cols-2 sm:flex sm:w-auto sm:flex-row sm:flex-wrap sm:items-center sm:justify-end " +
    "*:min-w-0 *:w-full sm:*:w-auto [&_button]:w-full sm:[&_button]:w-auto",
};
export function PageActions({ layout = "compact", className, ...props }: PageActionsProps) {
  return <div className={cn(PAGE_ACTION_CLASSES[layout], className)} {...props} />;
}

export const financialNumberClassName = "text-right font-mono tabular-nums";
