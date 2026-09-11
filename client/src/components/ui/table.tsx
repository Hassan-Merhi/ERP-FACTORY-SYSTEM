import * as React from "react";

import { cn } from "@/lib/utils";

type TableProps = React.TableHTMLAttributes<HTMLTableElement> & {
  wrapperClassName?: string;
  scrollLabel?: string;
  scrollDescription?: string;
  minimumWidth?: string;
  /** Optional ref to the actual scroll-region wrapper, used by bounded large-list rendering. */
  scrollRef?: React.Ref<HTMLDivElement>;
  /**
   * Caps the scroll region's height so `TableHeader`'s sticky positioning has something to
   * stick against. Any CSS length; pass `"none"` to let the table run its full height (which
   * also disables the sticky header). Defaults to the `max-h-[70vh]` class on the wrapper.
   */
  maxHeight?: string;
};

const Table = React.forwardRef<HTMLTableElement, TableProps>(
  (
    {
      className,
      wrapperClassName,
      scrollLabel = "Scrollable data table",
      scrollDescription,
      minimumWidth,
      scrollRef,
      maxHeight,
      style,
      ...props
    },
    ref
  ) => {
    const descriptionId = React.useId();
    const wrapperRef = React.useRef<HTMLDivElement>(null);
    const [usesParentScroll, setUsesParentScroll] = React.useState(false);
    const setWrapperRef = React.useCallback(
      (node: HTMLDivElement | null) => {
        wrapperRef.current = node;
        if (typeof scrollRef === "function") scrollRef(node);
        else if (scrollRef) scrollRef.current = node;
      },
      [scrollRef]
    );

    // Some callers opt out of clipping so menus and popovers rendered inside a row can escape
    // the box. Those must not get a height cap either: with `overflow: visible` a capped table
    // would spill over whatever follows it instead of scrolling. They forgo the sticky header.
    const unclipped = /overflow-visible/.test(wrapperClassName ?? "");

    React.useLayoutEffect(() => {
      const wrapper = wrapperRef.current;
      const parent = wrapper?.parentElement;

      // If this table already sits directly inside a constrained vertical scroll container,
      // let that parent own vertical scrolling instead of creating a second nested scrollbar.
      // Explicit Table maxHeight/wrapper overflow settings still win because those callers
      // intentionally asked the table to manage its own scroll region.
      if (!wrapper || !parent || maxHeight || unclipped || /overflow-y-/.test(wrapperClassName ?? "")) {
        setUsesParentScroll(false);
        return;
      }

      const parentStyle = window.getComputedStyle(parent);
      const parentCanScrollVertically = parentStyle.overflowY === "auto" || parentStyle.overflowY === "scroll";
      const parentIsConstrained = parentStyle.maxHeight !== "none" || parent.scrollHeight > parent.clientHeight;

      setUsesParentScroll(parentCanScrollVertically && parentIsConstrained);
    }, [maxHeight, unclipped, wrapperClassName]);

    return (
      <div
        ref={setWrapperRef}
        role="region"
        aria-label={scrollLabel}
        aria-describedby={descriptionId}
        tabIndex={0}
        data-horizontal-scroll="true"
        data-table-scroll-region="true"
        className={cn(
          "relative max-w-full touch-pan-x overscroll-x-contain rounded-md border border-slate-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 dark:border-slate-600",
          // A sticky `thead` sticks to its nearest scrollport, which is this wrapper (declaring
          // overflow on one axis makes the other `auto` too). Without a height cap the scrollport
          // is exactly as tall as the table, so the header has no room to stick and scrolls away
          // with the page. Capping the height gives long tables their own scroll and makes the
          // header behave. Short tables never reach the cap, so their layout is unchanged.
          // Printing must never clip rows, so the cap lifts and the table paginates naturally.
          !unclipped && !usesParentScroll && "max-h-[70vh] overflow-x-auto overflow-y-auto overscroll-y-contain",
          !unclipped && !usesParentScroll && "print:max-h-none print:overflow-visible",
          usesParentScroll && "max-h-none overflow-x-auto overflow-y-auto",
          wrapperClassName
        )}
        style={{ maxHeight }}
      >
        <span id={descriptionId} className="sr-only">
          {scrollDescription ??
            (unclipped
              ? "Scroll horizontally to view additional columns."
              : "Scroll to view additional rows and columns.")}
        </span>
        <table
          ref={ref}
          data-responsive-table="true"
          className={cn("w-full min-w-full caption-bottom border-collapse text-sm tabular-nums", className)}
          style={{ minWidth: minimumWidth, ...style }}
          {...props}
        />
      </div>
    );
  }
);
Table.displayName = "Table";

const TableHeader = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => (
    <thead
      ref={ref}
      className={cn(
        "sticky top-0 z-30 bg-muted/95 backdrop-blur supports-[backdrop-filter]:bg-muted/80 [&_tr]:border-b [&_tr]:border-slate-300 dark:[&_tr]:border-slate-600",
        className
      )}
      {...props}
    />
  )
);
TableHeader.displayName = "TableHeader";

const TableBody = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => (
    <tbody ref={ref} className={cn("[&_tr:last-child]:border-b-0", className)} {...props} />
  )
);
TableBody.displayName = "TableBody";

const TableFooter = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => (
    <tfoot
      ref={ref}
      className={cn(
        "border-t border-slate-300 bg-muted/50 font-medium [&>tr]:last:border-b-0 dark:border-slate-600",
        className
      )}
      {...props}
    />
  )
);
TableFooter.displayName = "TableFooter";

const TableRow = React.forwardRef<HTMLTableRowElement, React.HTMLAttributes<HTMLTableRowElement>>(
  ({ className, ...props }, ref) => (
    <tr
      ref={ref}
      className={cn(
        "border-b border-slate-300 transition-colors odd:bg-background even:bg-muted/20 hover:bg-primary/5 data-[state=selected]:bg-muted dark:border-slate-600",
        className
      )}
      {...props}
    />
  )
);
TableRow.displayName = "TableRow";

const TableHead = React.forwardRef<HTMLTableCellElement, React.ThHTMLAttributes<HTMLTableCellElement>>(
  ({ className, ...props }, ref) => (
    <th
      ref={ref}
      className={cn(
        "h-10 whitespace-nowrap border-r border-slate-300 px-3 text-left align-middle text-[11px] font-semibold uppercase tracking-wider text-muted-foreground last:border-r-0 dark:border-slate-600 sm:h-8 sm:px-2 sm:text-[10px] [&:has([role=checkbox])]:pr-0",
        className
      )}
      {...props}
    />
  )
);
TableHead.displayName = "TableHead";

// Text cells wrap (`break-words`), but numeric cells must not: a formatted amount like
// "$ 65.66" contains a space, so under column pressure the browser would break it across
// two lines ("$" above "65.66"), which visually shreds the column alignment. Right-aligned
// and monospaced cells are always numeric here, so they are pinned to a single line and the
// wrapper's horizontal scroll absorbs the extra width instead.
const TableCell = React.forwardRef<HTMLTableCellElement, React.TdHTMLAttributes<HTMLTableCellElement>>(
  ({ className, ...props }, ref) => (
    <td
      ref={ref}
      className={cn(
        "min-w-0 break-words border-r border-slate-300 px-3 py-2 text-xs align-middle last:border-r-0 dark:border-slate-600 sm:px-2 sm:py-1 [&.font-mono]:whitespace-nowrap [&.text-right]:whitespace-nowrap [&:has([role=checkbox])]:pr-0",
        className
      )}
      {...props}
    />
  )
);
TableCell.displayName = "TableCell";

const TableCaption = React.forwardRef<HTMLTableCaptionElement, React.HTMLAttributes<HTMLTableCaptionElement>>(
  ({ className, ...props }, ref) => (
    <caption ref={ref} className={cn("mt-4 text-sm text-muted-foreground", className)} {...props} />
  )
);
TableCaption.displayName = "TableCaption";

export { Table, TableHeader, TableBody, TableFooter, TableHead, TableRow, TableCell, TableCaption };
