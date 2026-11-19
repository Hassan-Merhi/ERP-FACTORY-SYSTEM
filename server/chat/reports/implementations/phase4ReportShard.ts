import type { DataQueryContext, DataQueryResult, ReportImplementationShard } from "../types";
import {
  runPhase4LocationStockSummary,
  runPhase4VoucherTypeSummary,
  runPhase4CustomerPaymentHistory,
} from "./phase4ReportCases2";
import {
  runPhase4FactoryWasteAnalysis,
  runPhase4UpcomingArrivals,
  runPhase4SupplierSpend,
  runPhase4WorkerProductivity,
  runPhase4ContainerOffloadDetails,
  runPhase4IntercompanyTransfers,
  runPhase4PosSalesSummary,
} from "./phase4ReportCases";

export const phase4QueryTypes = [
  "pos_sales_summary",
  "intercompany_transfers",
  "container_offload_details",
  "worker_productivity",
  "supplier_spend",
  "upcoming_arrivals",
  "factory_waste_analysis",
  "customer_payment_history",
  "voucher_type_summary",
  "location_stock_summary",
] as const;

async function runPhase4Report(ctx: DataQueryContext): Promise<DataQueryResult> {
  const { companyId, params, dateFrom, dateTo, todayStr, todayDate, rowLimit, fmt, fmtDec } = ctx;

  switch (params.queryType) {
    case "pos_sales_summary": {
      return await runPhase4PosSalesSummary({ params, companyId, dateFrom, dateTo, rowLimit, fmt });
    }

    case "intercompany_transfers": {
      return await runPhase4IntercompanyTransfers({ companyId, dateFrom, dateTo, rowLimit, fmt });
    }

    case "container_offload_details": {
      return await runPhase4ContainerOffloadDetails({ params, companyId, rowLimit, fmtDec, fmt });
    }

    case "worker_productivity": {
      return await runPhase4WorkerProductivity({ companyId, dateFrom, dateTo, rowLimit, fmtDec });
    }

    case "supplier_spend": {
      return await runPhase4SupplierSpend({ params, companyId, dateFrom, rowLimit, fmt });
    }

    case "upcoming_arrivals": {
      return await runPhase4UpcomingArrivals({ todayDate, companyId, rowLimit });
    }

    case "factory_waste_analysis": {
      return await runPhase4FactoryWasteAnalysis({ companyId, dateFrom, dateTo, rowLimit, fmtDec });
    }

    case "customer_payment_history": {
      return await runPhase4CustomerPaymentHistory({ params, companyId, dateFrom, dateTo, rowLimit, fmt });
    }

    case "voucher_type_summary": {
      return await runPhase4VoucherTypeSummary({ companyId, dateFrom, dateTo, fmt });
    }

    case "location_stock_summary": {
      return await runPhase4LocationStockSummary({ params, companyId, rowLimit, fmtDec, fmt, todayStr });
    }

    default:
      return undefined;
  }
}

export const phase4ReportShard: ReportImplementationShard = {
  name: "phase-4",
  queryTypes: phase4QueryTypes,
  run: runPhase4Report,
};
