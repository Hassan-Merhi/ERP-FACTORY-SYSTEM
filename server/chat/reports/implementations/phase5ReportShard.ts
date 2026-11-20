import type { DataQueryContext, DataQueryResult, ReportImplementationShard } from "../types";
import { runPhase5DebitNoteSummary } from "./phase5ReportCases3";
import {
  runPhase5ProfitByLocation,
  runPhase5DailyReport,
  runPhase5LedgerAccountBalance,
  runPhase5CashFlowSummary,
  runPhase5StockTransfers,
} from "./phase5ReportCases2";
import {
  runPhase5WorkerDocumentExpiry,
  runPhase5PurchaseOrderDetail,
  runPhase5TrialBalance,
} from "./phase5ReportCases";

// container_cost_breakdown stays listed so the public query registry keeps it,
// but reportImplementationRegistry routes it to the schema-compatibility shard
// (the legacy phase 5 SQL read a container column that no longer exists).
export const phase5QueryTypes = [
  "trial_balance",
  "purchase_order_detail",
  "container_cost_breakdown",
  "worker_document_expiry",
  "stock_transfers",
  "cash_flow_summary",
  "ledger_account_balance",
  "daily_report",
  "profit_by_location",
  "debit_note_summary",
] as const;

async function runPhase5Report(ctx: DataQueryContext): Promise<DataQueryResult> {
  const { companyId, params, dateFrom, dateTo, todayStr, todayDate, rowLimit, fmt, fmtDec } = ctx;

  switch (params.queryType) {
    case "trial_balance": {
      return await runPhase5TrialBalance({ companyId, dateFrom, dateTo, fmt });
    }

    case "purchase_order_detail": {
      return await runPhase5PurchaseOrderDetail({ params, companyId, fmtDec, fmt });
    }

    case "worker_document_expiry": {
      return await runPhase5WorkerDocumentExpiry({ todayDate, companyId, rowLimit, todayStr });
    }

    case "stock_transfers": {
      return await runPhase5StockTransfers({ params, companyId, dateFrom, dateTo, rowLimit, fmtDec, fmt });
    }

    case "cash_flow_summary": {
      return await runPhase5CashFlowSummary({ dateFrom, dateTo, companyId, fmt });
    }

    case "ledger_account_balance": {
      return await runPhase5LedgerAccountBalance({ params, companyId, dateFrom, dateTo, rowLimit, fmt });
    }

    case "daily_report": {
      return await runPhase5DailyReport({ params, todayStr, companyId, rowLimit, fmt });
    }

    case "profit_by_location": {
      return await runPhase5ProfitByLocation({ companyId, dateFrom, dateTo, rowLimit, fmt });
    }

    case "debit_note_summary": {
      return await runPhase5DebitNoteSummary({ companyId, dateFrom, dateTo, rowLimit, fmt });
    }

    default:
      return undefined;
  }
}

export const phase5ReportShard: ReportImplementationShard = {
  name: "phase-5",
  queryTypes: phase5QueryTypes,
  run: runPhase5Report,
};
