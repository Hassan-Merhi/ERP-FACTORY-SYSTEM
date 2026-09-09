import type { Plugin } from "vite";

export const SALES_REPORT_SUFFIX = "/client/src/pages/SalesReportLegacy.tsx";
export const SALES_DETAIL_SUFFIX = "/client/src/pages/salesreportdetail/useSalesReportDetailModel.ts";
export const SALES_COMPARISON_SUFFIX = "/client/src/pages/SalesReportComparison.tsx";

function replaceExactly(source: string, before: string, after: string, label: string): string {
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`[sales-report-bandwidth] Missing transform target: ${label}`);
  if (source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`[sales-report-bandwidth] Ambiguous transform target: ${label}`);
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

function replaceBetween(source: string, start: string, end: string, replacement: string, label: string): string {
  const startIndex = source.indexOf(start);
  if (startIndex < 0) throw new Error(`[sales-report-bandwidth] Missing start target: ${label}`);
  if (source.indexOf(start, startIndex + start.length) >= 0) {
    throw new Error(`[sales-report-bandwidth] Ambiguous start target: ${label}`);
  }
  const endIndex = source.indexOf(end, startIndex + start.length);
  if (endIndex < 0) throw new Error(`[sales-report-bandwidth] Missing end target: ${label}`);
  return source.slice(0, startIndex) + replacement + source.slice(endIndex);
}

function transformSalesReport(source: string): string {
  let code = source;

  code = replaceExactly(
    code,
    `import { format, parseISO, startOfDay, startOfMonth, startOfYear } from "date-fns";`,
    `import { format, parseISO } from "date-fns";`,
    "remove browser-side grouping date helpers"
  );

  code = replaceExactly(
    code,
    `import type { DailySummary, GroupingType, ProfitFilter, SalesReportItem } from "./salesreportlegacy/types";`,
    `import type { DailySummary, GroupingType, ProfitFilter, SalesReportItem } from "./salesreportlegacy/types";\nimport {\n  EMPTY_SALES_REPORT_TOTALS,\n  fetchSalesReportRows,\n  fetchSalesReportSummary,\n  type SalesReportSummaryResponse,\n} from "@/lib/salesReportBandwidthClient";`,
    "sales report compact client import"
  );

  code = replaceExactly(
    code,
    `  const [searchTerm, setSearchTerm] = useState("");`,
    `  const [searchTerm, setSearchTerm] = useState("");\n  const [debouncedSearchTerm, setDebouncedSearchTerm] = useState("");`,
    "sales report debounced search state"
  );

  code = replaceExactly(
    code,
    `  const { toast: _toast } = useToast();`,
    `  const { toast } = useToast();`,
    "sales report export toast"
  );

  code = replaceExactly(
    code,
    `  const { formatAmount } = useCurrencyContext();`,
    `  const { formatAmount } = useCurrencyContext();\n\n  useEffect(() => {\n    const timer = window.setTimeout(() => setDebouncedSearchTerm(searchTerm.trim()), 350);\n    return () => window.clearTimeout(timer);\n  }, [searchTerm]);`,
    "sales report debounced search effect"
  );

  code = replaceExactly(
    code,
    `  // Fetch stock items (lightweight — only needs id/name/code for filter dropdown)\n  const { data: stockItems = [] } = useQuery<any[]>({\n    queryKey: ["/api/stock-items/light", selectedCompany?.id],\n    staleTime: 10 * 60 * 1000,\n    refetchOnWindowFocus: false,\n    refetchOnMount: false,\n    refetchOnReconnect: false,\n  });\n\n`,
    ``,
    "remove stock item download from summary screen"
  );

  code = replaceBetween(
    code,
    `  // Build query params for single-company mode (location/group filtered client-side)\n`,
    `  const handleClearFilters = () => {`,
    `  // Wave 4 heavy-read path: the interactive list requests only SQL-aggregated\n  // summary rows. Raw sale lines are fetched only for explicit export/drill-down.\n  const singleSummaryParams = new URLSearchParams();\n  if (periodFilter.fromDate) singleSummaryParams.set("startDate", periodFilter.fromDate);\n  if (periodFilter.toDate) singleSummaryParams.set("endDate", periodFilter.toDate);\n  singleSummaryParams.set("grouping", grouping);\n  singleSummaryParams.set("mergeView", String(mergeView));\n  singleSummaryParams.set("profitFilter", profitFilter);\n  if (debouncedSearchTerm) singleSummaryParams.set("search", debouncedSearchTerm);\n  if (selectedLocations.length > 0) singleSummaryParams.set("locationIds", selectedLocations.join(","));\n  if (selectedStockGroups.length > 0) singleSummaryParams.set("stockGroupIds", selectedStockGroups.join(","));\n  const singleSummaryUrl = \`/api/sales-report/summary?\${singleSummaryParams.toString()}\`;\n\n  const multiSummaryParams = new URLSearchParams();\n  if (periodFilter.fromDate) multiSummaryParams.set("startDate", periodFilter.fromDate);\n  if (periodFilter.toDate) multiSummaryParams.set("endDate", periodFilter.toDate);\n  multiSummaryParams.set("grouping", grouping);\n  multiSummaryParams.set("mergeView", String(mergeView));\n  multiSummaryParams.set("profitFilter", profitFilter);\n  if (debouncedSearchTerm) multiSummaryParams.set("search", debouncedSearchTerm);\n  if (selectedCompanies.length > 0) multiSummaryParams.set("companyFilter", selectedCompanies.join(","));\n  if (selectedStockGroupNames.length > 0) {\n    multiSummaryParams.set("stockGroupNames", JSON.stringify(selectedStockGroupNames));\n  }\n  const multiSummaryUrl = \`/api/dashboard/sales-report-all/summary?\${multiSummaryParams.toString()}\`;\n\n  const singleRawParams = new URLSearchParams();\n  if (periodFilter.fromDate) singleRawParams.set("startDate", periodFilter.fromDate);\n  if (periodFilter.toDate) singleRawParams.set("endDate", periodFilter.toDate);\n  const singleCompanyRawUrl = singleRawParams.toString()\n    ? \`/api/sales-report?\${singleRawParams.toString()}\`\n    : "/api/sales-report";\n\n  const multiRawParams = new URLSearchParams();\n  if (periodFilter.fromDate) multiRawParams.set("startDate", periodFilter.fromDate);\n  if (periodFilter.toDate) multiRawParams.set("endDate", periodFilter.toDate);\n  if (selectedCompanies.length > 0) multiRawParams.set("companyFilter", selectedCompanies.join(","));\n  if (selectedStockGroupNames.length > 0) multiRawParams.set("stockGroupName", selectedStockGroupNames[0]);\n  const multiCompanyRawUrl = multiRawParams.toString()\n    ? \`/api/dashboard/sales-report-all?\${multiRawParams.toString()}\`\n    : "/api/dashboard/sales-report-all";\n\n  const {\n    data: singleCompanySummary,\n    isLoading: isLoadingSingle,\n    isError: isErrorSingle,\n    refetch: refetchSingle,\n  } = useQuery<SalesReportSummaryResponse>({\n    queryKey: [singleSummaryUrl],\n    queryFn: () => fetchSalesReportSummary(singleSummaryUrl),\n    enabled: !isMultiCompanyMode,\n    staleTime: 60_000,\n    refetchOnWindowFocus: false,\n    refetchOnReconnect: false,\n    placeholderData: (previous) => previous,\n  });\n\n  const {\n    data: allCompaniesSummary,\n    isLoading: isLoadingMulti,\n    isError: isErrorMulti,\n    refetch: refetchMulti,\n  } = useQuery<SalesReportSummaryResponse>({\n    queryKey: [multiSummaryUrl],\n    queryFn: () => fetchSalesReportSummary(multiSummaryUrl),\n    enabled: isMultiCompanyMode,\n    staleTime: 60_000,\n    refetchOnWindowFocus: false,\n    refetchOnReconnect: false,\n    placeholderData: (previous) => previous,\n  });\n\n  const activeSummary = isMultiCompanyMode ? allCompaniesSummary : singleCompanySummary;\n  const isLoading = isMultiCompanyMode ? isLoadingMulti : isLoadingSingle;\n  const isError = isMultiCompanyMode ? isErrorMulti : isErrorSingle;\n  const refetchReport = isMultiCompanyMode ? refetchMulti : refetchSingle;\n\n  const filteredGroupedData = useMemo<DailySummary[]>(\n    () =>\n      (activeSummary?.groups ?? []).map((group) => ({\n        ...group,\n        displayDate:\n          grouping === "daily"\n            ? formatDisplayDate(parseISO(group.dateKey))\n            : grouping === "monthly"\n              ? format(parseISO(\`\${group.dateKey}-01\`), "MMMM yyyy")\n              : group.dateKey,\n      })),\n    [activeSummary?.groups, grouping, formatDisplayDate]\n  );\n  const groupedData = filteredGroupedData;\n  const totals = activeSummary?.totals ?? EMPTY_SALES_REPORT_TOTALS;\n  const companyFilterOptions = useMemo<[string, string][]>(\n    () => (isMultiCompanyMode ? (allCompaniesSummary?.companies ?? []).map((company) => [company.code, company.name]) : []),\n    [isMultiCompanyMode, allCompaniesSummary?.companies]\n  );\n\n`,
    "replace raw sales list aggregation with server summary"
  );

  code = replaceExactly(
    code,
    `    if (selectedStockGroups.length === 1) params.set("stockGroupId", selectedStockGroups[0]);`,
    `    if (selectedStockGroups.length === 1) {\n      if (isMultiCompanyMode && selectedStockGroupNames.length === 1) {\n        params.set("stockGroupName", selectedStockGroupNames[0]);\n      } else {\n        params.set("stockGroupId", selectedStockGroups[0]);\n      }\n    }`,
    "sales report drill-down stock group scope"
  );

  code = replaceExactly(
    code,
    `  const handleExportExcel = () => exportSalesReportExcel(salesData);`,
    `  const handleExportExcel = async () => {\n    try {\n      const salesData = await fetchSalesReportRows(isMultiCompanyMode ? multiCompanyRawUrl : singleCompanyRawUrl);\n      await exportSalesReportExcel(salesData);\n    } catch (error: unknown) {\n      toast({\n        title: "Export failed",\n        description: error instanceof Error ? error.message : "The detailed sales rows could not be loaded.",\n        variant: "destructive",\n      });\n    }\n  };`,
    "sales report raw rows only on explicit export"
  );

  code = replaceExactly(
    code,
    `{formatNumber(localFilteredData.length, 0)}`,
    `{formatNumber(totals.itemCount, 0)}`,
    "sales report total item count"
  );

  return code;
}

function transformSalesDetail(source: string): string {
  let code = source;
  code = replaceExactly(
    code,
    `  const stockGroupId = params.get("stockGroupId") || "";`,
    `  const stockGroupId = params.get("stockGroupId") || "";\n  const stockGroupName = params.get("stockGroupName") || "";`,
    "sales detail stock group name parameter"
  );
  code = replaceExactly(
    code,
    `  if (stockGroupId && stockGroupId !== "all") queryParams.append("stockGroupId", stockGroupId);\n  if (allCompanies && companyFilter) queryParams.append("companyFilter", companyFilter);`,
    `  if (stockGroupId && stockGroupId !== "all") queryParams.append("stockGroupId", stockGroupId);\n  if (allCompanies && stockGroupName) queryParams.append("stockGroupName", stockGroupName);\n  if (allCompanies && companyFilter) queryParams.append("companyFilter", companyFilter);`,
    "sales detail all-company stock group filter"
  );
  return code;
}

function transformSalesComparison(source: string): string {
  return replaceExactly(
    source,
    `    queryKey: ["/api/dashboard/sales-report-all", queryString],\n    enabled,`,
    `    queryKey: [\n      queryString\n        ? \`/api/dashboard/sales-report-comparison?\${queryString}\`\n        : "/api/dashboard/sales-report-comparison",\n    ],\n    enabled,\n    staleTime: 60_000,\n    refetchOnWindowFocus: false,\n    refetchOnReconnect: false,`,
    "sales comparison aggregate endpoint"
  );
}

export function transformSalesReportBandwidthSource(source: string, id: string): string | null {
  const normalizedId = id.replaceAll("\\", "/").split("?")[0];
  if (normalizedId.endsWith(SALES_REPORT_SUFFIX)) return transformSalesReport(source);
  if (normalizedId.endsWith(SALES_DETAIL_SUFFIX)) return transformSalesDetail(source);
  if (normalizedId.endsWith(SALES_COMPARISON_SUFFIX)) return transformSalesComparison(source);
  return null;
}

export function salesReportBandwidthPlugin(): Plugin {
  return {
    name: "erp-sales-report-bandwidth",
    enforce: "pre",
    transform(source, id) {
      const code = transformSalesReportBandwidthSource(source, id);
      return code === null ? null : { code, map: null };
    },
  };
}
