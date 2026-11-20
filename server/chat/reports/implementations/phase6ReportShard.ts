import type { DataQueryContext, DataQueryResult, ReportImplementationShard } from "../types";
import {
  runPhase6JournalEntries,
  runPhase6EmployeeList,
  runPhase6ContainerItemsList,
  runPhase6WeeklySales,
} from "./phase6ReportCases2";
import {
  runPhase6SupplierProformas,
  runPhase6CustomerProformas,
  runPhase6FactoryMixBatches,
  runPhase6SupplierList,
  runPhase6CustomerList,
} from "./phase6ReportCases";

/** One debit/credit leg aggregated into a journal_entries row by json_agg. */
export type JournalEntryLine = { account: string; dr: number; cr: number };

// stock_item_detail stays listed so the public query registry keeps it, but
// reportImplementationRegistry routes it to the schema-compatibility shard
// (which only overrides types a phase shard registers).
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
