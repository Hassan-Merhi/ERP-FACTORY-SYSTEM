import type { Plugin } from "vite";

const MAIN_SUFFIX = "/client/src/main.tsx";
const DAYBOOK_SUFFIX = "/client/src/pages/Daybook.tsx";

function replaceExactly(
  source: string,
  before: string,
  after: string,
  label: string,
): string {
  const first = source.indexOf(before);
  if (first < 0) {
    throw new Error(`[phase1-pagination] Missing transform target: ${label}`);
  }
  if (source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`[phase1-pagination] Ambiguous transform target: ${label}`);
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

function replaceRange(
  source: string,
  start: string,
  end: string,
  replacement: string,
  label: string,
): string {
  const startIndex = source.indexOf(start);
  if (startIndex < 0) {
    throw new Error(`[phase1-pagination] Missing start target: ${label}`);
  }
  const endIndex = source.indexOf(end, startIndex + start.length);
  if (endIndex < 0) {
    throw new Error(`[phase1-pagination] Missing end target: ${label}`);
  }
  return source.slice(0, startIndex) + replacement + source.slice(endIndex);
}

function replaceAllChecked(
  source: string,
  before: string,
  after: string,
  minimum: number,
  label: string,
): string {
  const count = source.split(before).length - 1;
  if (count < minimum) {
    throw new Error(
      `[phase1-pagination] Expected at least ${minimum} targets for ${label}, found ${count}`,
    );
  }
  return source.split(before).join(after);
}

function transformMain(source: string): string {
  return replaceExactly(
    source,
    `import "./lib/v5AllocationPaginationClient";`,
    `import "./lib/v5AllocationPaginationClient";\nimport "./lib/accountStatementPaginationClient";\nimport "./lib/containerPaginationClient";`,
    "pagination bootstrap import",
  );
}

function transformDaybook(source: string): string {
  let code = source;
  code = replaceExactly(
    code,
    `import { useQuery, useMutation } from "@tanstack/react-query";`,
    `import { useQuery, useMutation, useInfiniteQuery } from "@tanstack/react-query";`,
    "Daybook infinite-query import",
  );
  code = replaceExactly(
    code,
    `import { apiRequest, queryClient } from "@/lib/queryClient";`,
    `import { apiRequest, queryClient } from "@/lib/queryClient";\nimport { fetchAllErpDaybookRows, fetchErpDaybookChunk, type ErpDaybookChunk } from "@/lib/erpDaybookPaginationClient";`,
    "Daybook continuous-list helper import",
  );

  const queryReplacement = `  const [accountNameCache] = useState<Record<number, string>>({});\n\n  const daybookQueryParams = useMemo(() => {\n    const params = new URLSearchParams();\n    if (periodFilter.fromDate) params.set("startDate", periodFilter.fromDate);\n    if (periodFilter.toDate) params.set("endDate", periodFilter.toDate);\n    if (filters.voucherType !== "all") params.set("voucherType", filters.voucherType);\n    if (filters.searchQuery.trim()) params.set("search", filters.searchQuery.trim());\n    if (filters.minAmount.trim()) params.set("minAmount", filters.minAmount.trim());\n    if (filters.maxAmount.trim()) params.set("maxAmount", filters.maxAmount.trim());\n    if (filters.statusFilter !== "all") params.set("statusFilter", filters.statusFilter);\n    params.set("sortOrder", filters.sortOrder);\n    return params;\n  }, [\n    periodFilter.fromDate,\n    periodFilter.toDate,\n    filters.voucherType,\n    filters.searchQuery,\n    filters.minAmount,\n    filters.maxAmount,\n    filters.statusFilter,\n    filters.sortOrder,\n  ]);\n\n  const {\n    data: daybookPages,\n    isLoading,\n    isError,\n    error,\n    refetch: refetchVouchers,\n    hasNextPage,\n    isFetchingNextPage,\n    fetchNextPage,\n  } = useInfiniteQuery({\n    queryKey: [\n      "/api/daybook",\n      selectedCompany?.id,\n      daybookQueryParams.toString(),\n      "continuous",\n    ],\n    initialPageParam: null as string | null,\n    queryFn: ({ pageParam, signal }) =>\n      fetchErpDaybookChunk(daybookQueryParams, pageParam, 250, signal),\n    getNextPageParam: (lastPage: ErpDaybookChunk) =>\n      lastPage.hasMore && lastPage.nextCursor ? lastPage.nextCursor : undefined,\n    enabled: !!selectedCompany,\n    staleTime: 30 * 1000,\n    gcTime: 10 * 60 * 1000,\n    refetchOnWindowFocus: false,\n    refetchOnReconnect: false,\n  });\n\n  useEffect(() => {\n    if (!hasNextPage || isFetchingNextPage || isError) return;\n    void fetchNextPage();\n  }, [hasNextPage, isFetchingNextPage, isError, fetchNextPage]);\n\n  const allRows: DaybookRow[] = useMemo(\n    () => (daybookPages?.pages.flatMap((page) => page.items) ?? []) as DaybookRow[],\n    [daybookPages?.pages]\n  );\n\n  const daybookErrorMessage = isBlockingQueryError(isError ? error : null, allRows.length > 0)\n    ? error instanceof Error\n      ? error.message\n      : "Failed to load transactions"\n    : null;\n\n  const loadAllDaybookVouchers = async (): Promise<Voucher[]> => {\n    const rows = await fetchAllErpDaybookRows(daybookQueryParams);\n    return rows\n      .filter((row): row is Extract<typeof row, { _type: "voucher" }> => row._type === "voucher")\n      .map((row) => row.data as unknown as Voucher);\n  };\n\n`;
  code = replaceRange(
    code,
    `  const [accountNameCache] = useState<Record<number, string>>({});`,
    `  const visibleRows = useMemo(`,
    queryReplacement,
    "Daybook unified continuous query block",
  );
  code = replaceExactly(
    code,
    `  const displayedRows = useMemo(() => visibleRows.slice(0, daybookRowLimit), [visibleRows, daybookRowLimit]);`,
    `  const displayedRows = visibleRows;`,
    "Daybook full-list rows",
  );
  code = replaceAllChecked(
    code,
    `const exportVouchers = await loadAllVouchers();`,
    `const exportVouchers = await loadAllDaybookVouchers();`,
    2,
    "Daybook complete exports",
  );
  code = replaceAllChecked(
    code,
    `      void invalidateCompanyApiFamily(queryClient, "/api/vouchers", selectedCompany?.id);`,
    `      void invalidateCompanyApiFamily(queryClient, "/api/vouchers", selectedCompany?.id);\n      void queryClient.invalidateQueries({ queryKey: ["/api/daybook"] });`,
    2,
    "Daybook mutation invalidation",
  );
  code = replaceExactly(
    code,
    `              daybookRowLimit={daybookRowLimit}\n              setDaybookRowLimit={setDaybookRowLimit}\n              DAYBOOK_PAGE_SIZE={DAYBOOK_PAGE_SIZE}`,
    `              daybookRowLimit={visibleRows.length}\n              setDaybookRowLimit={() => undefined}\n              DAYBOOK_PAGE_SIZE={DAYBOOK_PAGE_SIZE}`,
    "Daybook obsolete row-limit props",
  );
  code = replaceExactly(
    code,
    `            <PaginationBar\n              page={voucherPageResponse?.page ?? voucherPage}\n              totalPages={voucherPageResponse?.totalPages ?? 0}\n              total={voucherPageResponse?.total ?? 0}\n              pageSize={voucherPageResponse?.pageSize ?? VOUCHER_PAGE_SIZE}\n              onPageChange={(nextPage) => {\n                setVoucherPage(nextPage);\n                setDaybookRowLimit(DAYBOOK_PAGE_SIZE);\n              }}\n              noun="vouchers"\n            />`,
    `            {isFetchingNextPage && (\n              <p className="py-2 text-center text-xs text-muted-foreground" data-testid="erp-daybook-loading-remaining">\n                Loading remaining transactions… {allRows.length} of {daybookPages?.pages[0]?.total ?? allRows.length}\n              </p>\n            )}`,
    "Daybook visible pagination controls",
  );
  return code;
}

export function phase1PaginationPlugin(): Plugin {
  return {
    name: "erp-phase1-pagination",
    enforce: "pre",
    transform(source, id) {
      const normalizedId = id.replaceAll("\\", "/").split("?")[0];
      if (normalizedId.endsWith(MAIN_SUFFIX)) {
        return { code: transformMain(source), map: null };
      }
      if (normalizedId.endsWith(DAYBOOK_SUFFIX)) {
        return { code: transformDaybook(source), map: null };
      }
      return null;
    },
  };
}
