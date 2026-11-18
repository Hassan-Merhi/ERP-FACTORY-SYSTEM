import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export interface PaginationBarProps {
  /** One-based current page. */
  page: number;
  totalPages: number;
  total: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (size: number) => void;
  pageSizeOptions?: readonly number[];
  noun?: string;
  ariaLabel?: string;
  "data-testid"?: string;
}

export function PaginationBar({
  page,
  totalPages,
  total,
  pageSize,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [10, 20, 25, 50, 100],
  noun = "items",
  ariaLabel,
  "data-testid": testId = "pagination-bar",
}: PaginationBarProps) {
  const pages = Math.max(1, totalPages);
  const safePage = Math.min(Math.max(1, page), pages);
  const start = total === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const end = Math.min(total, safePage * pageSize);
  // Consumers render their own empty-result row; a 0–0 summary would only add noise.
  if (total <= 0) return null;
  if (pages <= 1 && !onPageSizeChange) return null;

  const sizes = [...new Set([...pageSizeOptions, pageSize])]
    .filter((size) => Number.isInteger(size) && size > 0)
    .sort((a, b) => a - b);

  return (
    <nav
      aria-label={ariaLabel ?? `Pagination for ${noun}`}
      className="flex min-w-0 flex-wrap items-center justify-between gap-3 border-t px-2 py-3"
      data-testid={testId}
    >
      <p className="text-sm text-muted-foreground" aria-live="polite">
        Showing {start.toLocaleString()}–{end.toLocaleString()} of {total.toLocaleString()} {noun}
      </p>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {onPageSizeChange && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground" aria-hidden="true">
              Rows
            </span>
            <Select value={String(pageSize)} onValueChange={(value) => onPageSizeChange(Number(value))}>
              <SelectTrigger className="h-9 w-20" aria-label="Rows per page">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {sizes.map((size) => (
                  <SelectItem key={size} value={String(size)}>
                    {size}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        {pages > 1 && (
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-11 sm:min-h-8"
              disabled={safePage <= 1}
              aria-label="Previous page"
              onClick={() => onPageChange(safePage - 1)}
            >
              Previous
            </Button>
            <span className="min-w-20 text-center text-sm tabular-nums">
              Page {safePage} of {pages}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-11 sm:min-h-8"
              disabled={safePage >= pages}
              aria-label="Next page"
              onClick={() => onPageChange(safePage + 1)}
            >
              Next
            </Button>
          </>
        )}
      </div>
    </nav>
  );
}
