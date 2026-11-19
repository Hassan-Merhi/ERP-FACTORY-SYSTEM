// Extracted from ./FactoryWorkerDetailView.tsx to keep that module under the source-size cap.
import { useState } from "react";
import { useHubQueryState } from "@/hooks/use-hub-query-state";
import { useToast } from "@/hooks/use-toast";
import {
  exportPeopleTableExcel,
  exportPeopleTablePdf,
  printPeopleTable,
  type PeopleExportSpec,
} from "../people/peopleExport";
import { PAYROLL_STATUS } from "./utils";
import type { useFactoryWorkerDetailModel } from "./useFactoryWorkerDetailModel";

const WORKER_DETAIL_TABS = ["profile", "statement", "advances", "attendance", "bales", "documents"] as const;
export type WorkerDetailTab = (typeof WORKER_DETAIL_TABS)[number];

/** Detail tab kept in ?tab= plus the statement Excel/PDF/print export. */
export function useFactoryWorkerDetailViewTabs(model: ReturnType<typeof useFactoryWorkerDetailModel>) {
  const {
    formatDate,
    payrolls,
    showAdvances,
    showAttendance,
    showBales,
    showDocuments,
    showProfile,
    showStatement,
    worker,
  } = model;
  const { toast } = useToast();
  const visibleDetailTabs = [
    showProfile ? "profile" : null,
    showStatement ? "statement" : null,
    showAdvances ? "advances" : null,
    showAttendance ? "attendance" : null,
    showBales ? "bales" : null,
    showDocuments ? "documents" : null,
  ].filter((value): value is WorkerDetailTab => value !== null);
  // The open tab lives in ?tab= so links and reloads keep it; until access loads every tab stays allowed.
  const [requestedDetailTab, setRequestedDetailTab] = useHubQueryState<WorkerDetailTab>({
    key: "tab",
    allowedValues: visibleDetailTabs.length ? visibleDetailTabs : WORKER_DETAIL_TABS,
    knownValues: WORKER_DETAIL_TABS,
    defaultValue: visibleDetailTabs[0] ?? "profile",
    omitDefault: true,
  });
  const activeDetailTab = visibleDetailTabs.includes(requestedDetailTab) ? requestedDetailTab : visibleDetailTabs[0];
  const [statementExportBusy, setStatementExportBusy] = useState(false);

  const exportStatement = async (format: "excel" | "pdf" | "print") => {
    if (!worker) return;
    const rows = payrolls ?? [];
    const sum = (pick: (row: (typeof rows)[number]) => string | null | undefined) =>
      rows.reduce((total, row) => total + (parseFloat(pick(row) || "0") || 0), 0);
    const spec: PeopleExportSpec<(typeof rows)[number]> = {
      title: "Worker Statement",
      fileStem: `${worker.fullName} statement`,
      subtitle: [worker.employeeCode, worker.fullName].filter(Boolean).join(" · "),
      columns: [
        {
          header: "Period",
          width: 26,
          value: (p) => `${p.periodStart?.slice(0, 10) ?? ""} – ${p.periodEnd?.slice(0, 10) ?? ""}`,
        },
        { header: "Base", type: "money", value: (p) => p.baseSalary },
        { header: "Transport", type: "money", value: (p) => p.transport || "0" },
        { header: "Bonus", type: "money", value: (p) => p.bonuses },
        { header: "Advances", type: "money", value: (p) => p.advances },
        { header: "Net", type: "money", value: (p) => p.netSalary },
        { header: "Status", value: (p) => (PAYROLL_STATUS[p.status] || PAYROLL_STATUS.DRAFT).label },
        { header: "Paid On", value: (p) => (p.paidAt ? formatDate(p.paidAt) : "") },
      ],
      rows,
      footer: [
        "TOTAL",
        sum((p) => p.baseSalary),
        sum((p) => p.transport),
        sum((p) => p.bonuses),
        sum((p) => p.advances),
        sum((p) => p.netSalary),
        "",
        "",
      ],
    };
    if (format === "print") {
      if (!printPeopleTable(spec)) {
        toast({ title: "Print failed", description: "Allow pop-ups to print.", variant: "destructive" });
      }
      return;
    }
    setStatementExportBusy(true);
    try {
      if (format === "excel") await exportPeopleTableExcel(spec);
      else await exportPeopleTablePdf(spec);
    } catch (error) {
      toast({
        title: "Export failed",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setStatementExportBusy(false);
    }
  };

  return { activeDetailTab, setRequestedDetailTab, statementExportBusy, exportStatement };
}
