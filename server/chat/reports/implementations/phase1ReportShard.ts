import type { DataQueryContext, DataQueryResult, ReportImplementationShard } from "../types";
import {
  runPhase1ContainersPendingOffload,
  runPhase1ContainerStatus,
  runPhase1BaleProduction,
} from "./phase1ReportCases2";
import {
  runPhase1WorkerAttendance,
  runPhase1OutstandingSuppliers,
  runPhase1TopCustomers,
  runPhase1SupplierStatement,
  runPhase1CustomerStatement,
  runPhase1OverduePayments,
  runPhase1CashPosition,
  runPhase1PlSummary,
} from "./phase1ReportCases";

export const phase1QueryTypes = [
  "pl_summary",
  "cash_position",
  "overdue_payments",
  "customer_statement",
  "supplier_statement",
  "top_customers",
  "outstanding_suppliers",
  "worker_attendance",
  "bale_production",
  "container_status",
  "containers_pending_offload",
] as const;

async function runPhase1Report(ctx: DataQueryContext): Promise<DataQueryResult> {
  const { companyId, params, dateFrom, dateTo, todayStr, rowLimit, userMessage, fmt, fmtDec } = ctx;

  switch (params.queryType) {
    case "pl_summary": {
      return await runPhase1PlSummary({ companyId, dateFrom, dateTo, fmt });
    }

    case "cash_position": {
      return await runPhase1CashPosition({ companyId, fmt, todayStr });
    }

    case "overdue_payments": {
      return await runPhase1OverduePayments({ companyId, rowLimit, fmt });
    }

    case "customer_statement": {
      return await runPhase1CustomerStatement({ params, companyId, rowLimit, fmtDec });
    }

    case "supplier_statement": {
      return await runPhase1SupplierStatement({ params, companyId, rowLimit, fmtDec });
    }

    case "top_customers": {
      return await runPhase1TopCustomers({ companyId, dateFrom, dateTo, rowLimit, fmt });
    }

    case "outstanding_suppliers": {
      return await runPhase1OutstandingSuppliers({ companyId, rowLimit, fmt });
    }

    case "worker_attendance": {
      return await runPhase1WorkerAttendance({ companyId, dateFrom, dateTo });
    }

    case "bale_production": {
      return await runPhase1BaleProduction({ companyId, dateFrom, dateTo, fmtDec, fmt });
    }

    case "container_status": {
      return await runPhase1ContainerStatus({ params, userMessage, companyId });
    }

    case "containers_pending_offload": {
      return await runPhase1ContainersPendingOffload({ companyId, rowLimit });
    }

    default:
      return undefined;
  }
}

export const phase1ReportShard: ReportImplementationShard = {
  name: "phase-1",
  queryTypes: phase1QueryTypes,
  run: runPhase1Report,
};
