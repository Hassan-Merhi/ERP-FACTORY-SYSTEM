import type { DataQueryContext, DataQueryResult, ReportImplementationShard } from "../types";
import {
  runPhase2PayrollSummary,
  runPhase2RentalSummary,
  runPhase2MonthlyComparison,
  runPhase2ContainerList,
} from "./phase2ReportCases2";
import {
  runPhase2SupplierAging,
  runPhase2CustomerAging,
  runPhase2OpenPurchaseOrders,
  runPhase2StockMovement,
  runPhase2LowStockItems,
  runPhase2InventoryCheck,
} from "./phase2ReportCases";

export const phase2QueryTypes = [
  "inventory_check",
  "low_stock_items",
  "stock_movement",
  "open_purchase_orders",
  "customer_aging",
  "supplier_aging",
  "container_list",
  "monthly_comparison",
  "rental_summary",
  "payroll_summary",
] as const;

async function runPhase2Report(ctx: DataQueryContext): Promise<DataQueryResult> {
  const {
    companyId,
    params,
    dateFrom,
    dateTo,
    todayStr,
    todayDate,
    thisMonthStart,
    lastMonthStart,
    lastMonthEnd,
    rowLimit,
    fmt,
    fmtDec,
  } = ctx;

  switch (params.queryType) {
    case "inventory_check": {
      return await runPhase2InventoryCheck({ params, companyId, rowLimit, fmtDec, fmt });
    }

    case "low_stock_items": {
      return await runPhase2LowStockItems({ companyId, rowLimit, fmtDec });
    }

    case "stock_movement": {
      return await runPhase2StockMovement({ params, companyId, dateFrom, dateTo, rowLimit, fmtDec });
    }

    case "open_purchase_orders": {
      return await runPhase2OpenPurchaseOrders({ params, companyId, rowLimit, fmtDec });
    }

    case "customer_aging": {
      return await runPhase2CustomerAging({ companyId, rowLimit, fmt, todayStr });
    }

    case "supplier_aging": {
      return await runPhase2SupplierAging({ companyId, rowLimit, fmt, todayStr });
    }

    case "container_list": {
      return await runPhase2ContainerList({ params, companyId, dateFrom, dateTo, rowLimit, fmtDec });
    }

    case "monthly_comparison": {
      return await runPhase2MonthlyComparison({
        companyId,
        thisMonthStart,
        todayStr,
        lastMonthStart,
        lastMonthEnd,
        fmt,
      });
    }

    case "rental_summary": {
      return await runPhase2RentalSummary({ todayDate, companyId, rowLimit, fmt });
    }

    case "payroll_summary": {
      return await runPhase2PayrollSummary({ companyId, dateFrom, dateTo, rowLimit, fmt });
    }

    default:
      return undefined;
  }
}

export const phase2ReportShard: ReportImplementationShard = {
  name: "phase-2",
  queryTypes: phase2QueryTypes,
  run: runPhase2Report,
};
