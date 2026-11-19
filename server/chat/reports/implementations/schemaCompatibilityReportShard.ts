import type { DataQueryContext, DataQueryResult, ReportImplementationShard } from "../types";
import {
  runSchemaCompatibilitySupplierContainerHistory,
  runSchemaCompatibilityStockItemDetail,
  runSchemaCompatibilityContainerCostBreakdown,
} from "./schemaCompatibilityReportCases2";
import {
  runSchemaCompatibilityUpcomingArrivals,
  runSchemaCompatibilityWorkerProductivity,
  runSchemaCompatibilityContainerProfitability,
  runSchemaCompatibilityPayrollSummary,
  runSchemaCompatibilityContainerList,
} from "./schemaCompatibilityReportCases";

/**
 * Current-schema implementations for reports whose legacy SQL drifted behind
 * table/column renames. Keep this list intentionally small: the registry
 * overrides only these query types while the original phase shards continue to
 * serve every unaffected report.
 */
export const schemaCompatibilityQueryTypes = [
  "container_list",
  "payroll_summary",
  "container_profitability",
  "worker_productivity",
  "upcoming_arrivals",
  "container_cost_breakdown",
  "stock_item_detail",
  "supplier_container_history",
] as const;

async function runSchemaCompatibilityReport(ctx: DataQueryContext): Promise<DataQueryResult> {
  const { companyId, params, dateFrom, dateTo, todayDate, rowLimit, fmt, fmtDec } = ctx;

  switch (params.queryType) {
    case "container_list": {
      return await runSchemaCompatibilityContainerList({ params, companyId, dateFrom, dateTo, rowLimit, fmtDec });
    }

    case "payroll_summary": {
      return await runSchemaCompatibilityPayrollSummary({ companyId, dateFrom, dateTo, rowLimit, fmt });
    }

    case "container_profitability": {
      return await runSchemaCompatibilityContainerProfitability({ companyId, dateFrom, dateTo, rowLimit, fmt });
    }

    case "worker_productivity": {
      return await runSchemaCompatibilityWorkerProductivity({ companyId, dateFrom, dateTo, rowLimit, fmtDec });
    }

    case "upcoming_arrivals": {
      return await runSchemaCompatibilityUpcomingArrivals({ todayDate, companyId, rowLimit });
    }

    case "container_cost_breakdown": {
      return await runSchemaCompatibilityContainerCostBreakdown({ params, companyId, fmtDec, fmt });
    }

    case "stock_item_detail": {
      return await runSchemaCompatibilityStockItemDetail({ params, companyId, fmtDec, fmt });
    }

    case "supplier_container_history": {
      return await runSchemaCompatibilitySupplierContainerHistory({ params, companyId, rowLimit, fmtDec, fmt });
    }

    default:
      throw new Error(`Schema compatibility report received unsupported query type: ${String(params.queryType)}`);
  }
}

export const schemaCompatibilityReportShard: ReportImplementationShard = {
  name: "schema-compatibility",
  queryTypes: schemaCompatibilityQueryTypes,
  run: runSchemaCompatibilityReport,
};
