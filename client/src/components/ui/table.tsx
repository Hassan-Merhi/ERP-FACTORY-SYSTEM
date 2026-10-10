import * as React from "react";

import { cn } from "@/lib/utils";

import { useMobileCardTable } from "./mobile-card-table";
import { usePhoneSheet } from "./phone-sheet";

type TableProps = React.TableHTMLAttributes<HTMLTableElement> & {
  wrapperClassName?: string;
  scrollLabel?: string;
  scrollDescription?: string;
  minimumWidth?: string;
  /** Optional ref to the actual scroll-region wrapper, used by bounded large-list rendering. */
  scrollRef?: React.Ref<HTMLDivElement>;
  /**
   * Caps the scroll region's height so the table scrolls inside its own box. Any CSS length.
   * Without it, workspace tables let the page scroll (narrow ones keep a page-sticky header,
   * wide ones scroll sideways), and tables inside dialogs/sheets cap at 70vh.
   */
  maxHeight?: string;
  /**
   * Phone presentation. `"cards"` restacks each body row as a labelled card on ERP and Factory
   * phone layouts (see `mobile-card-table.ts`); tablet and desktop always render the table. Omit it
   * (or pass `"scroll"`) for matrix-style tables whose columns must stay side by side.
   */
  mobileLayout?: "cards" | "scroll";
  /**
   * Keeps the first column in view while the table scrolls sideways (reference numbers, names).
   * Only meaningful for tables that are wider than their container.
   */
  stickyFirstColumn?: boolean;
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
      mobileLayout,
      stickyFirstColumn,
      style,
      ...props
    },
    ref
  ) => {
    const descriptionId = React.useId();
    const { cards, ref: setCardTable } = useMobileCardTable(mobileLayout === "cards");
    const setTableRef = React.useCallback(
      (node: HTMLTableElement | null) => {
        setCardTable(node);
        if (typeof ref === "function") ref(node);
        else if (ref) ref.current = node;
      },
      [ref, setCardTable]
    );
    const wrapperRef = React.useRef<HTMLDivElement>(null);
    // Inside a phone bottom sheet the sheet is the one scroll container, so entry lists never
    // scroll inside it.
    const phoneSheet = usePhoneSheet();
    // How the region scrolls:
    //  - "capped": its own 70vh scroll region (dialogs, sheets, and anything outside a workspace);
    //  - "parent": the element directly above it already scrolls, so it must not;
    //  - "page": inside #main-content, the page scrolls and the table runs its full height.
    const [scrollMode, setScrollMode] = React.useState<"capped" | "parent" | "page">("capped");
    // In page mode a table wider than its box keeps a sideways scroller (which also pins the
    // sticky header to the box); one that fits is left unclipped so the header sticks to the page.
    const [wide, setWide] = React.useState(true);
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
    // Callers that size the region themselves (an explicit cap or overflow) keep their own scroll.
    const callerScroll = Boolean(maxHeight) || /overflow-y-|overflow-auto|max-h-/.test(wrapperClassName ?? "");

    React.useLayoutEffect(() => {
      const wrapper = wrapperRef.current;
      const parent = wrapper?.parentElement;

      if (!wrapper || !parent || unclipped || callerScroll) {
        setScrollMode("capped");
        return;
      }

      // If this table already sits directly inside a constrained vertical scroll container,
      // let that parent own vertical scrolling instead of creating a second nested scrollbar.
      const parentStyle = window.getComputedStyle(parent);
      const parentCanScrollVertically = parentStyle.overflowY === "auto" || parentStyle.overflowY === "scroll";
      const parentIsConstrained = parentStyle.maxHeight !== "none" || parent.scrollHeight > parent.clientHeight;
      if (parentCanScrollVertically && parentIsConstrained) {
        setScrollMode("parent");
        return;
      }

      // Workspace tables let the page scroll. Dialogs and sheets keep their own capped region so
      // a long list never pushes the dialog's actions out of reach.
      const inOverlay = wrapper.closest('[role="dialog"], [role="alertdialog"], [data-slot="sheet-content"]');
      const inWorkspace = wrapper.closest("#main-content");
      if (inOverlay && phoneSheet) {
        setScrollMode("parent");
        return;
      }
      setScrollMode(inWorkspace && !inOverlay ? "page" : "capped");
    }, [maxHeight, unclipped, callerScroll, wrapperClassName, phoneSheet]);

    React.useEffect(() => {
      const wrapper = wrapperRef.current;
      const table = wrapper?.querySelector("table");
      if (scrollMode !== "page" || cards || !wrapper || !table || typeof ResizeObserver === "undefined") return;
      const measure = () => setWide(table.scrollWidth > wrapper.clientWidth + 1);
      const observer = new ResizeObserver(measure);
      observer.observe(wrapper);
      observer.observe(table);
      measure();
      return () => observer.disconnect();
    }, [scrollMode, cards]);

    return (
      <div
        ref={setWrapperRef}
        role="region"
        aria-label={scrollLabel}
        aria-describedby={descriptionId}
        tabIndex={0}
        data-horizontal-scroll="true"
        data-table-scroll-region="true"
        data-mobile-cards={cards ? "true" : undefined}
        data-scroll-mode={scrollMode}
        className={cn(
          "relative max-w-full touch-pan-x overscroll-x-contain rounded-md border border-slate-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 dark:border-slate-600",
          // A sticky `thead` sticks to its nearest scrollport, which is this wrapper (declaring
          // overflow on one axis makes the other `auto` too). Without a height cap the scrollport
          // is exactly as tall as the table, so the header has no room to stick and scrolls away
          // with the page. Capping the height gives long tables their own scroll and makes the
          // header behave. Short tables never reach the cap, so their layout is unchanged.
          // Printing must never clip rows, so the cap lifts and the table paginates naturally.
          !unclipped && scrollMode === "capped" && "max-h-[70vh] overflow-x-auto overflow-y-auto overscroll-y-contain",
          !unclipped && scrollMode === "capped" && "print:max-h-none print:overflow-visible",
          scrollMode === "parent" && "max-h-none overflow-x-auto overflow-y-auto",
          scrollMode === "page" &&
            (wide ? "max-h-none overflow-x-auto overflow-y-hidden" : "max-h-none overflow-visible"),
          scrollMode === "page" && "print:overflow-visible",
          stickyFirstColumn &&
            !cards &&
            "[&_tr>*:first-child]:sticky [&_tr>*:first-child]:left-0 [&_tr>*:first-child]:z-20 [&_thead_tr>*:first-child]:bg-muted [&_tbody_tr>*:first-child]:bg-background [&_tr>*:first-child]:shadow-[1px_0_0_hsl(var(--border))]",
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
          ref={setTableRef}
          data-responsive-table="true"
          data-mobile-cards={cards ? "true" : undefined}
          className={cn("w-full min-w-full caption-bottom border-collapse text-sm tabular-nums", className)}
          style={{ minWidth: cards ? undefined : minimumWidth, ...style }}
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
        // Opaque: rows scrolling under a translucent header read through it.
        "sticky top-0 z-30 bg-muted [&_tr]:border-b [&_tr]:border-slate-300 dark:[&_tr]:border-slate-600",
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
        // 11px at every width (10px uppercase labels were hard to read on 1080p) and a stronger
        // foreground tone so headers stay legible on the opaque muted background.
        "h-10 whitespace-nowrap border-r border-slate-300 px-3 text-left align-middle text-[11px] font-semibold uppercase tracking-wider text-foreground/80 last:border-r-0 dark:border-slate-600 sm:h-8 sm:px-2 [&:has([role=checkbox])]:pr-0",
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
