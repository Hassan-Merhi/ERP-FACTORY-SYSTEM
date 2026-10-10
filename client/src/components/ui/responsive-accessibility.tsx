import * as React from "react";
import { cn } from "@/lib/utils";

type SkipLinkProps = React.AnchorHTMLAttributes<HTMLAnchorElement>;

function getHashTarget(ownerDocument: Document, href: string): HTMLElement | null {
  if (!href.startsWith("#") || href.length <= 1) return null;
  try {
    return ownerDocument.getElementById(decodeURIComponent(href.slice(1)));
  } catch {
    return null;
  }
}

export function SkipLink({
  className,
  children = "Skip to main content",
  href = "#main-content",
  onClick,
  onKeyDown,
  ...props
}: SkipLinkProps) {
  const activateTarget = (link: HTMLAnchorElement) => {
    const target = getHashTarget(link.ownerDocument, href);
    if (!target) return false;

    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: "start" });

    const ownerDocument = link.ownerDocument;
    const targetWindow = ownerDocument.defaultView;
    if (targetWindow && targetWindow.location.hash !== href) {
      targetWindow.history.replaceState(targetWindow.history.state, "", href);
    }

    targetWindow?.requestAnimationFrame(() => {
      getHashTarget(ownerDocument, href)?.focus({ preventScroll: true });
    });
    return true;
  };

  const handleClick: React.MouseEventHandler<HTMLAnchorElement> = (event) => {
    onClick?.(event);
    if (event.defaultPrevented) return;

    if (activateTarget(event.currentTarget)) event.preventDefault();
  };

  const handleKeyDown: React.KeyboardEventHandler<HTMLAnchorElement> = (event) => {
    onKeyDown?.(event);
    if (event.defaultPrevented || event.key !== "Enter") return;

    if (activateTarget(event.currentTarget)) event.preventDefault();
  };

  return (
    <a
      href={href}
      data-slot="skip-link"
      className={cn(
        "sr-only z-50 rounded-md bg-background px-4 py-2 text-sm font-medium text-foreground shadow-lg transition focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:outline-hidden focus:ring-2 focus:ring-ring focus:ring-offset-2 motion-reduce:transition-none",
        className
      )}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      {...props}
    >
      {children}
    </a>
  );
}

type VisuallyHiddenProps = React.HTMLAttributes<HTMLSpanElement>;

export function VisuallyHidden({ className, ...props }: VisuallyHiddenProps) {
  return <span data-slot="visually-hidden" className={cn("sr-only", className)} {...props} />;
}

type LiveRegionProps = React.HTMLAttributes<HTMLDivElement> & {
  politeness?: "polite" | "assertive";
  atomic?: boolean;
};

export function LiveRegion({ className, politeness = "polite", atomic = true, ...props }: LiveRegionProps) {
  return (
    <div
      data-slot="live-region"
      role={politeness === "assertive" ? "alert" : "status"}
      aria-live={politeness}
      aria-atomic={atomic}
      className={cn("sr-only", className)}
      {...props}
    />
  );
}

type ResponsiveActionsProps = React.HTMLAttributes<HTMLDivElement> & {
  label?: string;
};

export function ResponsiveActions({ className, label = "Page actions", ...props }: ResponsiveActionsProps) {
  return (
    <div
      data-slot="responsive-actions"
      role="group"
      aria-label={label}
      className={cn(
        "flex w-full flex-col-reverse gap-2 sm:w-auto sm:flex-row sm:flex-wrap sm:items-center sm:justify-end *:min-h-10 *:w-full sm:*:w-auto",
        className
      )}
      {...props}
    />
  );
}

type ResponsiveToolbarProps = React.HTMLAttributes<HTMLDivElement> & {
  label?: string;
};

export function ResponsiveToolbar({ className, label = "Page filters and tools", ...props }: ResponsiveToolbarProps) {
  return (
    <div
      data-slot="responsive-toolbar"
      role="search"
      aria-label={label}
      className={cn(
        "flex w-full flex-col gap-3 rounded-lg border bg-card p-3 sm:flex-row sm:flex-wrap sm:items-end *:min-w-0 [&_button]:touch-manipulation",
        className
      )}
      {...props}
    />
  );
}

type ResponsiveGridProps = React.HTMLAttributes<HTMLDivElement> & {
  minColumnWidth?: string;
};

export function ResponsiveGrid({ className, minColumnWidth = "16rem", style, ...props }: ResponsiveGridProps) {
  return (
    <div
      data-slot="responsive-grid"
      className={cn("grid min-w-0 gap-4", className)}
      style={{ gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, ${minColumnWidth}), 1fr))`, ...style }}
      {...props}
    />
  );
}

type AccessibleRegionProps = React.HTMLAttributes<HTMLElement> & {
  label: string;
  as?: "section" | "nav" | "main" | "header";
};

export function AccessibleRegion({ label, as: Comp = "section", className, ...props }: AccessibleRegionProps) {
  return <Comp data-slot="accessible-region" aria-label={label} className={className} {...props} />;
}

type HorizontalScrollRegionProps = React.HTMLAttributes<HTMLDivElement> & {
  label: string;
  description?: string;
};

export function HorizontalScrollRegion({
  label,
  description = "Scroll horizontally to view additional content.",
  className,
  tabIndex = 0,
  children,
  onKeyDown,
  ...props
}: HorizontalScrollRegionProps) {
  const descriptionId = React.useId();

  const handleKeyDown: React.KeyboardEventHandler<HTMLDivElement> = (event) => {
    onKeyDown?.(event);
    if (event.defaultPrevented || event.target !== event.currentTarget) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    if (event.currentTarget.scrollWidth <= event.currentTarget.clientWidth) return;

    event.preventDefault();
    const targetWindow = event.currentTarget.ownerDocument.defaultView;
    const reducedMotion = targetWindow?.matchMedia("(prefers-reduced-motion: reduce)").matches ?? false;
    const distance = Math.max(80, Math.round(event.currentTarget.clientWidth * 0.2));
    event.currentTarget.scrollBy({
      left: event.key === "ArrowRight" ? distance : -distance,
      behavior: reducedMotion ? "auto" : "smooth",
    });
  };

  return (
    <div
      data-slot="horizontal-scroll-region"
      role="region"
      aria-label={label}
      aria-describedby={descriptionId}
      aria-keyshortcuts="ArrowLeft ArrowRight"
      tabIndex={tabIndex}
      data-horizontal-scroll="true"
      data-horizontal-scroll-region="true"
      className={cn(
        "max-w-full touch-pan-x overflow-x-auto overscroll-x-contain rounded-xs focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        className
      )}
      onKeyDown={handleKeyDown}
      {...props}
    >
      <VisuallyHidden id={descriptionId}>{description}</VisuallyHidden>
      {children}
    </div>
  );
}
