import { ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { PaginationBar } from "@/components/PaginationBar";

export interface ErpListPaginationProps {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  totalItems?: number;
  pageSize?: number;
  /** Render pagination even when only one page exists. */
  alwaysShow?: boolean;
}

/**
 * Shared ERP pagination controls. Pages still own their query and page state;
 * this component never fetches or modifies records.
 */
export function ErpListPagination({
  page,
  totalPages,
  onPageChange,
  totalItems,
  pageSize,
  alwaysShow = false,
}: ErpListPaginationProps) {
  const safePages = Math.max(1, totalPages);
  const current = Math.min(Math.max(page, 1), safePages);
  if (!alwaysShow && safePages <= 1) return null;

  // For real server metadata delegate to the existing shared PaginationBar;
  // retain the lightweight fallback for callers that do not know totalItems.
  if (totalItems != null && pageSize != null && totalItems > 0) {
    return (
      <PaginationBar
        page={current}
        totalPages={safePages}
        total={totalItems}
        pageSize={pageSize}
        onPageChange={onPageChange}
        noun="items"
        ariaLabel="Table pagination"
      />
    );
  }

  const range =
    totalItems != null && pageSize != null
      ? `Showing ${totalItems === 0 ? 0 : (current - 1) * pageSize + 1}–${Math.min(current * pageSize, totalItems)} of ${totalItems.toLocaleString()}`
      : null;

  return (
    <nav aria-label="Table pagination" className="flex flex-wrap items-center justify-between gap-3 py-2 text-xs text-muted-foreground">
      <span>{range ?? `Page ${current} of ${safePages}`}</span>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-label="Previous page"
          disabled={current <= 1}
          onClick={() => onPageChange(current - 1)}
        >
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        </Button>
        <span className="tabular-nums">Page {current} of {safePages}</span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-label="Next page"
          disabled={current >= safePages}
          onClick={() => onPageChange(current + 1)}
        >
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
    </nav>
  );
}
