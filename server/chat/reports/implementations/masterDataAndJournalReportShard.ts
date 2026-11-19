import type { DataQueryContext, DataQueryResult, ReportImplementationShard } from "../types";
import {
  runPhase6JournalEntries,
  runPhase6EmployeeList,
  runPhase6ContainerItemsList,
  runPhase6WeeklySales,
} from "./masterDataAndJournalReportCases2";
import {
  runPhase6SupplierProformas,
  runPhase6CustomerProformas,
  runPhase6FactoryMixBatches,
  runPhase6StockItemDetail,
  runPhase6SupplierList,
  runPhase6CustomerList,
} from "./masterDataAndJournalReportCases";

/** One debit/credit leg aggregated into a journal_entries row by json_agg. */
export type JournalEntryLine = { account: string; dr: number; cr: number };

export const phase6QueryTypes = [
  "customer_list",
  "supplier_list",
  "stock_item_detail",
  "factory_mix_batches",
  "customer_proformas",
  "supplier_proformas",
  "weekly_sales",
  "container_items_list",
  "employee_list",
  "journal_entries",
] as const;

async function runPhase6Report(ctx: DataQueryContext): Promise<DataQueryResult> {
  const { companyId, params, dateFrom, dateTo, rowLimit, fmt, fmtDec } = ctx;

  switch (params.queryType) {
    case "customer_list": {
      return await runPhase6CustomerList({ params, companyId, rowLimit, fmt });
    }

    case "supplier_list": {
      return await runPhase6SupplierList({ params, companyId, rowLimit, fmt });
    }

    case "stock_item_detail": {
      return await runPhase6StockItemDetail({ params, companyId, fmtDec, fmt });
    }

    case "factory_mix_batches": {
      return await runPhase6FactoryMixBatches({ params, companyId, rowLimit, fmtDec, fmt });
    }

    case "customer_proformas": {
      return await runPhase6CustomerProformas({ params, companyId, rowLimit, fmt });
    }

    case "supplier_proformas": {
      return await runPhase6SupplierProformas({ params, companyId, rowLimit, fmt });
    }

    case "weekly_sales": {
      return await runPhase6WeeklySales({ companyId, dateFrom, dateTo, rowLimit, fmt });
    }

    case "container_items_list": {
      return await runPhase6ContainerItemsList({ params, companyId, rowLimit, fmtDec, fmt });
    }

    case "employee_list": {
      return await runPhase6EmployeeList({ params, companyId, rowLimit, fmt });
    }

    case "journal_entries": {
      return await runPhase6JournalEntries({ companyId, dateFrom, dateTo, rowLimit, fmt });
    }

    default:
      return undefined;
  }
}

export const phase6ReportShard: ReportImplementationShard = {
  name: "phase-6",
  queryTypes: phase6QueryTypes,
  run: runPhase6Report,
};
