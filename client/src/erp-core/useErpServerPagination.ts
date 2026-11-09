import { useEffect, useState } from "react";

export interface ErpServerPaginationOptions {
  /** Active company, or other server identity defining the list scope. */
  companyId: number | string | null | undefined;
  /** Canonical serialized filter/search identity (not a mutable object). */
  filterKey?: string;
  pageSize?: number;
  /** Return metadata from the current server response, not client-row count. */
  totalPages?: number;
}

/**
 * Server paging state only. Do not slice data returned by the server.
 * Query and page size must be sent to the endpoint by the owning page.
 *
 * Switching companies or filters resets the requested page. An empty or
 * shrinking response clamps the page so the list doesn't stay stranded.
 */
export function useErpServerPagination({
  companyId,
  filterKey = "",
  pageSize: requestedPageSize = 100,
  totalPages,
}: ErpServerPaginationOptions) {
  const [page, setPage] = useState(1);
  const pageSize = Number.isInteger(requestedPageSize) && requestedPageSize > 0 ? requestedPageSize : 100;
  const lastPage = totalPages == null ? undefined : Math.max(1, totalPages);

  useEffect(() => {
    setPage(1);
  }, [companyId, filterKey]);

  useEffect(() => {
    if (lastPage === undefined) return;
    setPage((current) => (current > lastPage ? lastPage : current));
  }, [lastPage]);

  const onPageChange = (nextPage: number) => {
    const safe = Math.max(1, Math.floor(nextPage));
    setPage(lastPage == null ? safe : Math.min(safe, lastPage));
  };

  const resetPage = () => setPage(1);
  return { page, pageSize, onPageChange, resetPage };
}
