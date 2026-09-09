import type { Plugin } from "vite";
import {
  SALES_COMPARISON_SUFFIX,
  SALES_DETAIL_SUFFIX,
  SALES_REPORT_SUFFIX,
  transformSalesReportBandwidthSource,
} from "./viteSalesReportBandwidthPlugin";

const ORPHANED_RECORDS_SUFFIX = "/client/src/pages/OrphanedRecords.tsx";
const DATA_TOOLS_SUFFIX = "/client/src/pages/settings/datatoolstab/useDataToolsModel.ts";

const LEGACY_INVALIDATION = `queryClient.invalidateQueries({ queryKey: ["/api/sales-report"] });`;
const BANDWIDTH_SAFE_INVALIDATION = `queryClient.invalidateQueries({
        predicate: (query) => {
          const key = query.queryKey[0];
          return (
            typeof key === "string" &&
            (key.startsWith("/api/sales-report") || key.startsWith("/api/dashboard/sales-report"))
          );
        },
        refetchType: "active",
      });`;

function replaceExpected(
  source: string,
  before: string,
  after: string,
  expectedCount: number,
  label: string
): string {
  const count = source.split(before).length - 1;
  if (count !== expectedCount) {
    throw new Error(
      `[sales-report-invalidation] Expected ${expectedCount} transform target(s) for ${label}, found ${count}`
    );
  }
  return source.split(before).join(after);
}

function compactTransformAlreadyApplied(source: string, normalizedId: string): boolean {
  if (normalizedId.endsWith(SALES_REPORT_SUFFIX)) return source.includes("fetchSalesReportSummary");
  if (normalizedId.endsWith(SALES_DETAIL_SUFFIX)) return source.includes('params.get("stockGroupName")');
  if (normalizedId.endsWith(SALES_COMPARISON_SUFFIX)) return source.includes("/api/dashboard/sales-report-comparison");
  return false;
}

export function salesReportInvalidationPlugin(): Plugin {
  return {
    name: "erp-sales-report-invalidation",
    enforce: "pre",
    transform(source, id) {
      const normalizedId = id.replaceAll("\\", "/").split("?")[0];

      // Wave 4 makes the already-proven compact Sales Report implementation the
      // normal path. The older dedicated plugin may still be enabled explicitly
      // during rollout testing; avoid applying the fail-loud transform twice.
      if (
        normalizedId.endsWith(SALES_REPORT_SUFFIX) ||
        normalizedId.endsWith(SALES_DETAIL_SUFFIX) ||
        normalizedId.endsWith(SALES_COMPARISON_SUFFIX)
      ) {
        if (compactTransformAlreadyApplied(source, normalizedId)) return null;
        const compactCode = transformSalesReportBandwidthSource(source, id);
        return compactCode === null ? null : { code: compactCode, map: null };
      }

      if (normalizedId.endsWith(ORPHANED_RECORDS_SUFFIX)) {
        return {
          code: replaceExpected(
            source,
            LEGACY_INVALIDATION,
            BANDWIDTH_SAFE_INVALIDATION,
            2,
            "Orphaned Records sales-report invalidation"
          ),
          map: null,
        };
      }
      if (normalizedId.endsWith(DATA_TOOLS_SUFFIX)) {
        return {
          code: replaceExpected(
            source,
            LEGACY_INVALIDATION,
            BANDWIDTH_SAFE_INVALIDATION,
            1,
            "Data Tools sales-report invalidation"
          ),
          map: null,
        };
      }
      return null;
    },
  };
}
