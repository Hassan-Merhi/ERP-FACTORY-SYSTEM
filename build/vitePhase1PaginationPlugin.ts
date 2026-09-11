import type { Plugin } from "vite";

const MAIN_SUFFIX = "/client/src/main.tsx";
const DAYBOOK_SUFFIX = "/client/src/pages/Daybook.tsx";
const DAYBOOK_TABLE_SUFFIX = "/client/src/pages/daybook/DaybookTable.tsx";
const ACCOUNTS_MODEL_SUFFIX = "/client/src/pages/accountslegacy/useAccountsLegacyModel.ts";

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

  const queryReplacement = `  const [accountNameCache] = useState<Record<number, string>>({});\n\n  const daybookQueryParams = useMemo(() => {\n    const params = new URLSearchParams();\n    if (periodFilter.fromDate) params.set("startDate", periodFilter.fromDate);\n    if (periodFilter.toDate) params.set("endDate", periodFilter.toDate);\n    if (filters.voucherType !== "all") params.set("voucherType", filters.voucherType);\n    if (filters.searchQuery.trim()) params.set("search", filters.searchQuery.trim());\n    if (filters.minAmount.trim()) params.set("minAmount", filters.minAmount.trim());\n    if (filters.maxAmount.trim()) params.set("maxAmount", filters.maxAmount.trim());\n    if (filters.statusFilter !== "all") params.set("statusFilter", filters.statusFilter);\n    params.set("sortOrder", filters.sortOrder);\n    return params;\n  }, [\n    periodFilter.fromDate,\n    periodFilter.toDate,\n    filters.voucherType,\n    filters.searchQuery,\n    filters.minAmount,\n    filters.maxAmount,\n    filters.statusFilter,\n    filters.sortOrder,\n  ]);\n\n  const {\n    data: daybookPages,\n    isLoading,\n    isError,\n    error,\n    refetch: refetchVouchers,\n    hasNextPage,\n    isFetchingNextPage,\n    fetchNextPage,\n  } = useInfiniteQuery({\n    queryKey: [\n      "/api/daybook",\n      selectedCompany?.id,\n      daybookQueryParams.toString(),\n      "continuous",\n    ],\n    initialPageParam: null as string | null,\n    queryFn: ({ pageParam, signal }) =>\n      fetchErpDaybookChunk(daybookQueryParams, pageParam, 250, signal),\n    getNextPageParam: (lastPage: ErpDaybookChunk) =>\n      lastPage.hasMore && lastPage.nextCursor ? lastPage.nextCursor : undefined,\n    enabled: !!selectedCompany,\n    staleTime: 30 * 1000,\n    gcTime: 10 * 60 * 1000,\n    refetchOnWindowFocus: false,\n    refetchOnReconnect: false,\n  });\n\n  useEffect(() => {\n    if (!hasNextPage || isFetchingNextPage || isError) return;\n    void fetchNextPage();\n  }, [hasNextPage, isFetchingNextPage, isError, fetchNextPage]);\n\n  const allRows: DaybookRow[] = useMemo(\n    () => (daybookPages?.pages.flatMap((page) => page.items) ?? []) as DaybookRow[],\n    [daybookPages?.pages]\n  );\n\n  const daybookErrorMessage = isBlockingQueryError(isError ? error : null, allRows.length > 0)\n    ? error instanceof Error\n      ? error.message\n      : "Failed to load transactions"\n    : null;\n\n  const loadAllDaybookVouchers = async (): Promise<Voucher[]> => {\n    const rows = await fetchAllErpDaybookRows(daybookQueryParams);\n    return rows\n      .filter((row) => row._type === "voucher")\n      .map((row) => row.data as unknown as Voucher);\n  };\n\n`;
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

function transformDaybookTable(source: string): string {
  let code = source;
  code = replaceExactly(
    code,
    `import { isVoucherMutationBlocked, voucherLockLabel } from "@/lib/migratedVoucherGuard";`,
    `import { isVoucherMutationBlocked, voucherLockLabel } from "@/lib/migratedVoucherGuard";\nimport { useBoundedTableRows } from "@/hooks/useBoundedTableRows";`,
    "Daybook bounded-render import",
  );

  code = replaceExactly(
    code,
    `  // Loading, failure and empty are three different situations. Rendering a bare`,
    `  const daybookDesktopWindow = useBoundedTableRows({\n    rowCount: displayedRows.length,\n    rowHeight: 52,\n    minimumRows: 120,\n    overscan: 18,\n    enabled: viewMode === "detailed" && expandedVoucherId === null,\n  });\n  const daybookMobileWindow = useBoundedTableRows({\n    rowCount: displayedRows.length,\n    rowHeight: 86,\n    minimumRows: 80,\n    overscan: 12,\n    enabled: viewMode === "detailed",\n  });\n  const desktopRows = displayedRows.slice(daybookDesktopWindow.startIndex, daybookDesktopWindow.endIndex);\n  const mobileRows = displayedRows.slice(daybookMobileWindow.startIndex, daybookMobileWindow.endIndex);\n\n  // Loading, failure and empty are three different situations. Rendering a bare`,
    "Daybook bounded windows",
  );

  code = replaceExactly(
    code,
    `  const tableRows: React.JSX.Element[] = [];\n  let lastDate = "";\n  for (const row of displayedRows) {`,
    `  const tableRows: React.JSX.Element[] = [];\n  if (daybookDesktopWindow.topSpacerHeight > 0) {\n    tableRows.push(\n      <TableRow key="daybook-virtual-spacer-top" aria-hidden="true" data-testid="daybook-virtual-spacer-top">\n        <TableCell colSpan={hideAmounts ? 4 : 5} className="p-0 border-0" style={{ height: daybookDesktopWindow.topSpacerHeight }} />\n      </TableRow>\n    );\n  }\n  let lastDate = "";\n  for (const row of desktopRows) {`,
    "Daybook desktop render window",
  );
  code = replaceAllChecked(
    code,
    `const dayRows = displayedRows.filter((r) => {`,
    `const dayRows = visibleRows.filter((r) => {`,
    2,
    "Daybook complete date totals",
  );
  code = replaceExactly(
    code,
    `  // ── Build mobile card items ───────────────────────────────────────────────\n  const mobileItems: React.JSX.Element[] = [];\n  let mobileLastDate = "";\n  for (const row of displayedRows) {`,
    `  if (daybookDesktopWindow.bottomSpacerHeight > 0) {\n    tableRows.push(\n      <TableRow key="daybook-virtual-spacer-bottom" aria-hidden="true" data-testid="daybook-virtual-spacer-bottom">\n        <TableCell colSpan={hideAmounts ? 4 : 5} className="p-0 border-0" style={{ height: daybookDesktopWindow.bottomSpacerHeight }} />\n      </TableRow>\n    );\n  }\n\n  // ── Build mobile card items ───────────────────────────────────────────────\n  const mobileItems: React.JSX.Element[] = [];\n  if (daybookMobileWindow.topSpacerHeight > 0) {\n    mobileItems.push(\n      <div key="daybook-mobile-spacer-top" aria-hidden="true" data-testid="daybook-mobile-spacer-top" style={{ height: daybookMobileWindow.topSpacerHeight }} />\n    );\n  }\n  let mobileLastDate = "";\n  for (const row of mobileRows) {`,
    "Daybook mobile render window",
  );
  code = replaceExactly(
    code,
    `  const loadMoreButton = displayedRows.length < visibleRows.length && (`,
    `  if (daybookMobileWindow.bottomSpacerHeight > 0) {\n    mobileItems.push(\n      <div key="daybook-mobile-spacer-bottom" aria-hidden="true" data-testid="daybook-mobile-spacer-bottom" style={{ height: daybookMobileWindow.bottomSpacerHeight }} />\n    );\n  }\n\n  const loadMoreButton = displayedRows.length < visibleRows.length && (`,
    "Daybook mobile bottom spacer",
  );
  code = replaceAllChecked(
    code,
    `<Table wrapperClassName="max-h-[calc(100vh-220px)]">`,
    `<Table scrollRef={daybookDesktopWindow.scrollRef} wrapperClassName="max-h-[calc(100vh-220px)]">`,
    2,
    "Daybook table scroll owner",
  );
  code = replaceExactly(
    code,
    `<div className="sm:hidden -mx-4 overflow-y-auto max-h-[calc(100vh-260px)]">`,
    `<div ref={daybookMobileWindow.scrollRef} className="sm:hidden -mx-4 overflow-y-auto max-h-[calc(100vh-260px)]">`,
    "Daybook mobile scroll owner",
  );
  return code;
}

function transformAccountsModel(source: string): string {
  let code = source;
  code = replaceExactly(
    code,
    `import { useQuery, useMutation } from "@tanstack/react-query";`,
    `import { useQuery, useMutation, useInfiniteQuery } from "@tanstack/react-query";`,
    "Accounts infinite-query import",
  );
  code = replaceExactly(
    code,
    `import { queryClient, apiRequest } from "@/lib/queryClient";`,
    `import { queryClient, apiRequest } from "@/lib/queryClient";\nimport { fetchAccountStatementChunk, type AccountStatementChunk } from "@/lib/accountStatementContinuousClient";`,
    "Accounts continuous-list helper import",
  );

  const statementReplacement = `  const accountStatementBaseKey = selectedAccount\n    ? [\n        "account-statement",\n        selectedCompany?.id,\n        selectedAccount.type,\n        selectedAccount.accountId,\n        periodFilter.fromDate || null,\n        periodFilter.toDate || null,\n      ]\n    : ["account-statement", "disabled"];\n\n  const accountStatementUrl = useMemo(() => {\n    if (!selectedAccount) return "";\n    const params = new URLSearchParams();\n    if (periodFilter.fromDate) params.append("startDate", periodFilter.fromDate);\n    if (periodFilter.toDate) params.append("endDate", periodFilter.toDate);\n    if (selectedAccount.type === "factoryWorker") {\n      return \`/api/factory/workers/\${selectedAccount.accountId}/statement?\${params.toString()}\`;\n    }\n    const accountType = (selectedAccount.type || "").toLowerCase().replace(" ", "-");\n    return \`/api/accounts/\${accountType}/\${selectedAccount.accountId}/transactions?\${params.toString()}\`;\n  }, [selectedAccount, periodFilter.fromDate, periodFilter.toDate]);\n\n  const {\n    data: statementPages,\n    isLoading: transactionsLoading,\n    isError: transactionsQueryIsError,\n    error: transactionsQueryError,\n    hasNextPage: statementHasNextPage,\n    isFetchingNextPage: statementFetchingNextPage,\n    fetchNextPage: fetchNextStatementPage,\n  } = useInfiniteQuery({\n    queryKey: [...accountStatementBaseKey, "continuous-pages"],\n    initialPageParam: null as string | null,\n    queryFn: async ({ pageParam, signal }): Promise<AccountStatementChunk<Transaction>> => {\n      if (!selectedAccount) throw new Error("Account selection is required");\n      if (selectedAccount.type !== "factoryWorker") {\n        return fetchAccountStatementChunk<Transaction>(accountStatementUrl, pageParam, signal);\n      }\n\n      const response = await fetch(accountStatementUrl, { credentials: "include", signal });\n      const payload = await response.json().catch(() => null);\n      if (!response.ok) {\n        const message =\n          payload && typeof payload === "object" && "message" in payload && typeof payload.message === "string"\n            ? payload.message\n            : \`Failed to load account statement (\${response.status})\`;\n        throw new Error(message);\n      }\n      const workerTransactions = (Array.isArray(payload)\n        ? payload\n        : payload && typeof payload === "object" && "transactions" in payload && Array.isArray(payload.transactions)\n          ? payload.transactions\n          : []) as Transaction[];\n      const preNetBalance =\n        payload && !Array.isArray(payload) && typeof payload === "object" && "preNetBalance" in payload\n          ? Number(payload.preNetBalance) || 0\n          : 0;\n      const periodDebitTotal = workerTransactions.reduce((sum, row) => sum + (Number.parseFloat(row.debitAmount) || 0), 0);\n      const periodCreditTotal = workerTransactions.reduce((sum, row) => sum + (Number.parseFloat(row.creditAmount) || 0), 0);\n      return {\n        transactions: workerTransactions,\n        preNetBalance,\n        periodPreNetBalance: preNetBalance,\n        periodDebitTotal,\n        periodCreditTotal,\n        closingNetBalance: preNetBalance + periodDebitTotal - periodCreditTotal,\n        total: workerTransactions.length,\n        limit: Math.max(workerTransactions.length, 1),\n        asOfDate: periodFilter.toDate || "",\n        startDate: periodFilter.fromDate || null,\n        endDate: periodFilter.toDate || "",\n        continuous: true,\n        chunkOpeningNet: preNetBalance,\n        hasMore: false,\n        nextCursor: null,\n      };\n    },\n    getNextPageParam: (lastPage: AccountStatementChunk<Transaction>) =>\n      lastPage.hasMore && lastPage.nextCursor ? lastPage.nextCursor : undefined,\n    enabled: !!selectedAccount,\n    staleTime: 30 * 1000,\n    gcTime: 10 * 60 * 1000,\n    refetchOnWindowFocus: false,\n    refetchOnReconnect: false,\n  });\n\n  useEffect(() => {\n    if (!statementHasNextPage || statementFetchingNextPage || transactionsQueryIsError) return;\n    void fetchNextStatementPage();\n  }, [statementHasNextPage, statementFetchingNextPage, transactionsQueryIsError, fetchNextStatementPage]);\n\n  const rawTransactionData = useMemo(() => {\n    const pages = statementPages?.pages ?? [];\n    const first = pages[0];\n    if (!first) return undefined;\n    return {\n      ...first,\n      transactions: pages.flatMap((page) => page.transactions),\n    };\n  }, [statementPages?.pages]);\n\n  useEffect(() => {\n    if (!selectedAccount || !rawTransactionData) return;\n    queryClient.setQueryData(accountStatementBaseKey, rawTransactionData);\n  }, [selectedAccount, rawTransactionData, accountStatementBaseKey.join("|")]);\n\n`;
  code = replaceRange(
    code,
    `  const {\n    data: rawTransactionData,`,
    `  // Unwrap response`,
    statementReplacement,
    "Accounts statement query",
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
      if (normalizedId.endsWith(DAYBOOK_TABLE_SUFFIX)) {
        return { code: transformDaybookTable(source), map: null };
      }
      if (normalizedId.endsWith(ACCOUNTS_MODEL_SUFFIX)) {
        return { code: transformAccountsModel(source), map: null };
      }
      return null;
    },
  };
}
