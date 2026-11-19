import type { DataQueryContext, DataQueryResult, ReportImplementationShard } from "../types";
import {
  runPhase7QuarterlyComparison,
  runPhase7LocationList,
  runPhase7FactoryWorkerProfile,
  runPhase7IncomeBreakdown,
  runPhase7SupplierContainerHistory,
} from "./phase7ReportCases2";
import {
  runPhase7PendingContainerSales,
  runPhase7ContainerTracking,
  runPhase7StockAdjustments,
  runPhase7BankAccountList,
  runPhase7AuditTrail,
} from "./phase7ReportCases";

export const phase7QueryTypes = [
  "audit_trail",
  "bank_account_list",
  "stock_adjustments",
  "container_tracking",
  "pending_container_sales",
  "supplier_container_history",
  "income_breakdown",
  "factory_worker_profile",
  "location_list",
  "quarterly_comparison",
] as const;

async function runPhase7Report(ctx: DataQueryContext): Promise<DataQueryResult> {
  const { companyId, params, dateFrom, dateTo, todayStr, rowLimit, fmt, fmtDec } = ctx;

  switch (params.queryType) {
    case "audit_trail": {
      return await runPhase7AuditTrail({ params, companyId, dateFrom, rowLimit });
    }

    case "bank_account_list": {
      return await runPhase7BankAccountList({ companyId, fmt, todayStr });
    }

    case "stock_adjustments": {
      return await runPhase7StockAdjustments({ params, companyId, dateFrom, dateTo, rowLimit, fmtDec, fmt });
    }

    case "container_tracking": {
      return await runPhase7ContainerTracking({ params, companyId, rowLimit });
    }

    case "pending_container_sales": {
      return await runPhase7PendingContainerSales({ companyId, rowLimit, fmt });
    }

    case "supplier_container_history": {
      return await runPhase7SupplierContainerHistory({ params, companyId, rowLimit, fmtDec, fmt });
    }

    case "income_breakdown": {
      return await runPhase7IncomeBreakdown({ dateFrom, dateTo, companyId, rowLimit, fmt });
    }

    case "factory_worker_profile": {
      return await runPhase7FactoryWorkerProfile({ params, companyId, dateFrom, dateTo, fmt, fmtDec });
    }

    case "location_list": {
      return await runPhase7LocationList({ companyId, fmt });
    }

    case "quarterly_comparison": {
      return await runPhase7QuarterlyComparison({ params, todayStr, companyId, fmt });
    }

    default:
      return undefined;
  }
}

export const phase7ReportShard: ReportImplementationShard = {
  name: "phase-7",
  queryTypes: phase7QueryTypes,
  run: runPhase7Report,
};
