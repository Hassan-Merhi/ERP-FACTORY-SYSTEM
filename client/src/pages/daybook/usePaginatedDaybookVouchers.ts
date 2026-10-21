import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import {
  canonicalApiUrl,
  frontendQueryPolicies,
  paginatedCompanyDataKey,
  unwrapList,
  unwrapPage,
  type QueryParams,
} from "@/lib/frontendDataArchitecture";
import type { Voucher } from "./types";

interface DaybookFilterState {
  voucherType: string;
  searchQuery: string;
  sortOrder: "asc" | "desc";
  minAmount: string;
  maxAmount: string;
  statusFilter: "all" | "active" | "optional";
  costCenterId: string;
}

interface UsePaginatedDaybookVouchersOptions {
  companyId?: number;
  fromDate: string;
  toDate: string;
  filters: DaybookFilterState;
  page: number;
  pageSize: number;
}

export interface PaginatedVoucherResponse {
  data: Voucher[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasMore: boolean;
  summary: {
    total: number;
    active: number;
    optional: number;
    totalAmount: number;
  };
}

export function usePaginatedDaybookVouchers(options: UsePaginatedDaybookVouchersOptions) {
  const debouncedSearch = useDebouncedValue(options.filters.searchQuery, 250);
  const queryParams = useMemo<QueryParams>(
    () => ({
      profile: "page",
      page: options.page,
      pageSize: options.pageSize,
      startDate: options.fromDate,
      endDate: options.toDate,
      sort: options.filters.sortOrder,
      sortOrder: options.filters.sortOrder,
      type: options.filters.voucherType !== "all" ? options.filters.voucherType : undefined,
      voucherType: options.filters.voucherType !== "all" ? options.filters.voucherType : undefined,
      status: options.filters.statusFilter !== "all" ? options.filters.statusFilter : undefined,
      statusFilter: options.filters.statusFilter !== "all" ? options.filters.statusFilter : undefined,
      search: debouncedSearch.trim() || undefined,
      minAmount: options.filters.minAmount || undefined,
      maxAmount: options.filters.maxAmount || undefined,
      costCenterId: options.filters.costCenterId !== "all" ? options.filters.costCenterId : undefined,
    }),
    [
      options.page,
      options.pageSize,
      options.fromDate,
      options.toDate,
      options.filters.voucherType,
      options.filters.statusFilter,
      options.filters.sortOrder,
      options.filters.minAmount,
      options.filters.maxAmount,
      options.filters.costCenterId,
      debouncedSearch,
    ]
  );
  const queryUrl = useMemo(() => canonicalApiUrl("/api/vouchers", queryParams), [queryParams]);

  const query = useQuery<PaginatedVoucherResponse | Voucher[]>({
    queryKey: paginatedCompanyDataKey(queryUrl, options.companyId, options.page, options.pageSize, "daybook-vouchers"),
    queryFn: async ({ signal }) => {
      const response = await fetch(queryUrl, { credentials: "include", signal });
      if (!response.ok) {
        const body = await response.json().catch(() => ({ message: "Failed to load vouchers" }));
        throw new Error(body.message || "Failed to load vouchers");
      }
      return response.json();
    },
    enabled: !!options.companyId,
    ...frontendQueryPolicies.operational,
    placeholderData: (previous) => previous,
  });

  // The endpoint answers with a paginated envelope, but a plain array is still a
  // valid legacy shape. Normalizing both keeps the table populated either way
  // instead of silently rendering zero rows when the envelope is missing.
  const page = useMemo(
    () => unwrapPage<Voucher>(query.data, { page: options.page, pageSize: options.pageSize }),
    [query.data, options.page, options.pageSize]
  );

  const loadAllVouchers = async (): Promise<Voucher[]> => {
    // A filtered export must be drawn from the same SQL predicate as Daybook's
    // paged list. The legacy unpaged endpoint does not implement cost-center filtering.
    if (options.filters.costCenterId && options.filters.costCenterId !== "all") {
      const items: Voucher[] = [];
      for (let pageNumber = 1; pageNumber <= 1000; pageNumber++) {
        const url = canonicalApiUrl("/api/vouchers", {
          ...queryParams,
          profile: "page",
          page: pageNumber,
          pageSize: 250,
        });
        const response = await fetch(url, { credentials: "include" });
        if (!response.ok) throw new Error("Failed to export cost-center vouchers");
        const batch = (await response.json()) as { items: Voucher[]; totalPages: number };
        if (!Array.isArray(batch.items)) throw new Error("Invalid voucher export result");
        items.push(...batch.items);
        if (pageNumber >= batch.totalPages) return items;
      }
      throw new Error("Too many matching vouchers to export at once; narrow the date range");
    }
    const exportUrl = canonicalApiUrl("/api/vouchers", {
      ...queryParams,
      profile: undefined,
      page: undefined,
      pageSize: undefined,
    });
    const response = await fetch(exportUrl, { credentials: "include" });
    if (!response.ok) {
      const body = await response.json().catch(() => ({ message: "Failed to load complete Daybook export" }));
      throw new Error(body.message || "Failed to load complete Daybook export");
    }
    return unwrapList<Voucher>(await response.json());
  };

  return {
    ...query,
    queryUrl,
    response: page,
    vouchers: page.data,
    loadAllVouchers,
  };
}
