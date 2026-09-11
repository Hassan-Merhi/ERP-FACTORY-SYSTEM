import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";

interface BoundedTableRowsOptions {
  rowCount: number;
  rowHeight: number;
  overscan?: number;
  minimumRows?: number;
  enabled?: boolean;
}

export interface BoundedTableRowsWindow {
  scrollRef: RefObject<HTMLDivElement | null>;
  startIndex: number;
  endIndex: number;
  topSpacerHeight: number;
  bottomSpacerHeight: number;
  virtualized: boolean;
}

/**
 * Keeps large tables cheap without changing their logical dataset.
 *
 * The caller still owns every loaded row, totals, selection and export scope;
 * this hook only limits how many rows are mounted inside the scroll viewport.
 * Fixed-height table rows make spacer math deterministic, and beforeprint
 * temporarily expands the window so browser printing is not narrowed to the
 * current viewport.
 */
export function useBoundedTableRows({
  rowCount,
  rowHeight,
  overscan = 12,
  minimumRows = 120,
  enabled = true,
}: BoundedTableRowsOptions): BoundedTableRowsWindow {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [printing, setPrinting] = useState(false);
  const [range, setRange] = useState(() => ({ startIndex: 0, endIndex: Math.min(rowCount, minimumRows) }));
  const frameRef = useRef<number | null>(null);

  const shouldVirtualize = enabled && !printing && rowCount > minimumRows;

  const measure = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller || !shouldVirtualize) {
      setRange((current) =>
        current.startIndex === 0 && current.endIndex === rowCount ? current : { startIndex: 0, endIndex: rowCount }
      );
      return;
    }

    const safeRowHeight = Math.max(1, rowHeight);
    const viewportStart = Math.max(0, scroller.scrollTop);
    const viewportEnd = viewportStart + Math.max(scroller.clientHeight, safeRowHeight * minimumRows);
    const requestedStart = Math.max(0, Math.floor(viewportStart / safeRowHeight) - overscan);
    const maxStart = Math.max(0, rowCount - minimumRows);
    const startIndex = Math.min(requestedStart, maxStart);
    const requestedEnd = Math.ceil(viewportEnd / safeRowHeight) + overscan;
    const endIndex = Math.min(rowCount, Math.max(requestedEnd, startIndex + minimumRows));

    setRange((current) =>
      current.startIndex === startIndex && current.endIndex === endIndex ? current : { startIndex, endIndex }
    );
  }, [minimumRows, overscan, rowCount, rowHeight, shouldVirtualize]);

  useLayoutEffect(() => {
    measure();
  }, [measure]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;

    const scheduleMeasure = () => {
      if (frameRef.current !== null) return;
      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = null;
        measure();
      });
    };

    scroller.addEventListener("scroll", scheduleMeasure, { passive: true });
    window.addEventListener("resize", scheduleMeasure);
    return () => {
      scroller.removeEventListener("scroll", scheduleMeasure);
      window.removeEventListener("resize", scheduleMeasure);
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [measure]);

  useEffect(() => {
    const beforePrint = () => setPrinting(true);
    const afterPrint = () => setPrinting(false);
    window.addEventListener("beforeprint", beforePrint);
    window.addEventListener("afterprint", afterPrint);
    return () => {
      window.removeEventListener("beforeprint", beforePrint);
      window.removeEventListener("afterprint", afterPrint);
    };
  }, []);

  const startIndex = shouldVirtualize ? range.startIndex : 0;
  const endIndex = shouldVirtualize ? Math.max(range.endIndex, Math.min(rowCount, minimumRows)) : rowCount;

  return {
    scrollRef,
    startIndex,
    endIndex,
    topSpacerHeight: startIndex * rowHeight,
    bottomSpacerHeight: Math.max(0, rowCount - endIndex) * rowHeight,
    virtualized: shouldVirtualize,
  };
}
