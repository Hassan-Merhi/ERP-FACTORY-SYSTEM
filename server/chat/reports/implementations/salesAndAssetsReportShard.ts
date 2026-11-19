import type { DataQueryContext, DataQueryResult, ReportImplementationShard } from "../types";
import {
  runPhase3FactoryKpi,
  runPhase3FixedAssetsSummary,
  runPhase3BankTransactions,
} from "./salesAndAssetsReportCases2";
import {
  runPhase3CreditNotesSummary,
  runPhase3CustomerOrderStatus,
  runPhase3ExpenseBreakdown,
  runPhase3StockValuation,
  runPhase3ContainerProfitability,
  runPhase3TopSellingItems,
  runPhase3SalesAnalysis,
} from "./salesAndAssetsReportCases";

export const phase3QueryTypes = [
  "sales_analysis",
  "top_selling_items",
  "container_profitability",
  "stock_valuation",
  "expense_breakdown",
  "customer_order_status",
  "credit_notes_summary",
  "bank_transactions",
  "fixed_assets_summary",
  "factory_kpi",
] as const;

async function runPhase3Report(ctx: DataQueryContext): Promise<DataQueryResult> {
  const { companyId, params, dateFrom, dateTo, todayStr, rowLimit, fmt, fmtDec } = ctx;

  switch (params.queryType) {
    case "sales_analysis": {
      return await runPhase3SalesAnalysis({ params, companyId, dateFrom, dateTo, rowLimit, fmtDec, fmt });
    }

    case "top_selling_items": {
      return await runPhase3TopSellingItems({ companyId, dateFrom, dateTo, rowLimit, fmtDec, fmt });
    }

    case "container_profitability": {
      return await runPhase3ContainerProfitability({ companyId, dateFrom, dateTo, rowLimit, fmt });
    }

    case "stock_valuation": {
      return await runPhase3StockValuation({ companyId, rowLimit, fmtDec, fmt, todayStr });
    }

    case "expense_breakdown": {
      return await runPhase3ExpenseBreakdown({ companyId, dateFrom, dateTo, rowLimit, fmt });
    }

    case "customer_order_status": {
      return await runPhase3CustomerOrderStatus({ params, companyId, dateFrom, dateTo, rowLimit, fmt });
    }

    case "credit_notes_summary": {
      return await runPhase3CreditNotesSummary({ companyId, dateFrom, dateTo, rowLimit, fmtDec, fmt });
    }

    case "bank_transactions": {
      return await runPhase3BankTransactions({ params, companyId, dateFrom, dateTo, rowLimit, fmt });
    }

    case "fixed_assets_summary": {
      return await runPhase3FixedAssetsSummary({ params, companyId, rowLimit, fmt });
    }

    case "factory_kpi": {
      return await runPhase3FactoryKpi({ companyId, dateFrom, dateTo, rowLimit, fmtDec });
    }

    default:
      return undefined;
  }
}

export const phase3ReportShard: ReportImplementationShard = {
  name: "phase-3",
  queryTypes: phase3QueryTypes,
  run: runPhase3Report,
};
