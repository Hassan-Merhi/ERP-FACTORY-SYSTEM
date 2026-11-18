// Extracted from ./CostCenterReports.tsx to keep that module under the source-size cap.
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useCompany } from "@/contexts/CompanyContext";
import { useAppMode } from "@/contexts/AppModeContext";
import { useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { type CostCenter, readCostCenterApi, writeCostCenterApi } from "@/api/costCentersApi";
import { downloadFromUrl, exportFileName } from "@/lib/exportFile";

type AmountRow = { expense: string; inventoryCost: string; budget: string; variance: string; entries?: number };

type TotalRow = AmountRow & { unallocated: string; recognizedExpense: string; unallocatedApplicable: boolean };

type CenterRow = AmountRow & {
  companyId: number;
  companyName: string;
  costCenterId: number;
  code: string;
  name: string;
  active: boolean;
  utilization: string | null;
};

type AccountRow = {
  companyId: number;
  accountId: number | null;
  accountName: string;
  expense: string;
  inventoryCost: string;
  entries: number;
};

type MonthRow = {
  month: string;
  expense: string;
  unallocated: string;
  inventoryCost: string;
  budget: string;
  variance: string;
};

type Summary = {
  currency: string;
  scope: string;
  companyIds: number[];
  period: { from: string; to: string; budgetBasis: string };
  totals: TotalRow;
  centers: CenterRow[];
  departments: Array<CenterRow & { members: number }>;
  accounts: AccountRow[];
  months: MonthRow[];
};

type Activity = {
  id: number;
  companyId: number;
  costCenterId: number;
  costCenterName: string;
  costCenterCode: string;
  accountId: number | null;
  accountName: string;
  voucherId: number | null;
  voucherNumber: string | null;
  voucherEntryId: number | null;
  factoryDaybookEntryId: number | null;
  sourceModule: string;
  sourceDate: string;
  treatment: string;
  allocationOrigin: string;
  currency: string;
  amountNative: string;
  amountUsd: string;
};

type ExpenseAccount = { id: number; code: string; name: string };

type BudgetRow = { id: number; costCenterId: number; month: string; amountUsd: string; notes: string | null };

function dateStart(): string {
  const now = new Date();
  return now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") + "-01";
}

function dateEnd(): string {
  const now = new Date();
  return (
    now.getFullYear() +
    "-" +
    String(now.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()).padStart(2, "0")
  );
}

export const fmt = (v: string | number | null | undefined) =>
  Number(v || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const message = (e: unknown) => (e instanceof Error ? e.message : "Request failed");

export const strictMoney = /^(?:0|[1-9]\d{0,13})(?:\.\d{1,6})?$/;

export function useCostCenterReportsState({ baseUrl, centers }: { baseUrl: string; centers: CostCenter[] }) {
  const { selectedCompany } = useCompany();
  const factory = useAppMode() === "factory";
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const role = selectedCompany?.role || "";
  const companyId = selectedCompany?.id;
  const isEditor = ["Developer", "Owner", "Admin"].includes(role);
  const [from, setFrom] = useState(dateStart);
  const [to, setTo] = useState(dateEnd);
  const [centerFilter, setCenterFilter] = useState("all");
  const [accountFilter, setAccountFilter] = useState("all");
  const [treatment, setTreatment] = useState("ALL");
  const [consolidated, setConsolidated] = useState(false);
  const [view, setView] = useState<"centers" | "departments" | "accounts" | "months" | "activity">("centers");
  const [offset, setOffset] = useState(0);
  const [exporting, setExporting] = useState<string | null>(null);
  const [budgetCenter, setBudgetCenter] = useState("");
  const [budgetMonth, setBudgetMonth] = useState(() => dateStart().slice(0, 7));
  const [budgetAmount, setBudgetAmount] = useState("0");
  const [budgetNotes, setBudgetNotes] = useState("");
  const [budgetReason, setBudgetReason] = useState("Monthly cost center budget");
  const params = useMemo(() => {
    const p = new URLSearchParams({ fromDate: from, toDate: to, treatment });
    if (centerFilter !== "all") p.set("costCenterId", centerFilter);
    if (accountFilter !== "all") p.set("accountId", accountFilter);
    return p.toString();
  }, [from, to, treatment, centerFilter, accountFilter]);
  const summaryUrl = baseUrl + (consolidated ? "/reports/consolidated" : "/reports/summary") + "?" + params;
  const activityUrl =
    baseUrl +
    (consolidated ? "/reports/consolidated/activity" : "/reports/activity") +
    "?" +
    params +
    "&limit=50&offset=" +
    offset;
  const queryActive = !!companyId && from.length === 10 && to.length === 10 && from <= to;
  const {
    data: summary,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery<Summary>({
    queryKey: [baseUrl, companyId, "phase6", "summary", consolidated, params],
    queryFn: () => readCostCenterApi<Summary>(summaryUrl),
    enabled: queryActive,
    staleTime: 30000,
  });
  const {
    data: activity,
    isLoading: activityLoading,
    error: activityError,
  } = useQuery<{ activity: Activity[] }>({
    queryKey: [baseUrl, companyId, "phase6", "activity", consolidated, params, offset],
    queryFn: () => readCostCenterApi<{ activity: Activity[] }>(activityUrl),
    enabled: queryActive && view === "activity",
    staleTime: 30000,
  });
  const { data: accounts } = useQuery<{ accounts: ExpenseAccount[] }>({
    queryKey: [baseUrl, companyId, "automation", "accounts"],
    queryFn: () => readCostCenterApi<{ accounts: ExpenseAccount[] }>(baseUrl + "/automation/accounts"),
    enabled: !!companyId,
  });
  const { data: budgetList } = useQuery<{ budgets: BudgetRow[] }>({
    queryKey: [baseUrl, companyId, "phase6", "budgets", budgetMonth],
    queryFn: () =>
      readCostCenterApi<{ budgets: BudgetRow[] }>(
        baseUrl + "/budgets?fromDate=" + budgetMonth + "-01&toDate=" + budgetMonth + "-28"
      ),
    enabled: !!companyId && !!budgetMonth && !consolidated,
  });
  const chart = useMemo(
    () =>
      (summary?.months || []).map((m) => ({
        month: m.month,
        Expense: Number(m.expense),
        Unallocated: Number(m.unallocated),
        Budget: Number(m.budget),
        "Inventory (separate)": Number(m.inventoryCost),
      })),
    [summary]
  );
  const budgetEntry = budgetList?.budgets.find((b) => b.costCenterId === Number(budgetCenter));
  useEffect(() => {
    if (!budgetCenter || !budgetList) return;
    const existing = budgetList.budgets.find((b) => b.costCenterId === Number(budgetCenter));
    setBudgetAmount(existing?.amountUsd || "0");
    setBudgetNotes(existing?.notes || "");
  }, [budgetCenter, budgetMonth, budgetList]);

  const budgetSave = useMutation({
    mutationFn: () =>
      writeCostCenterApi("PUT", baseUrl + "/budgets/" + budgetCenter + "/" + budgetMonth, {
        amountUsd: budgetAmount.trim(),
        notes: budgetNotes.trim() || null,
        reason: budgetReason.trim(),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: [baseUrl, companyId, "phase6"] });
      toast({ title: "Budget saved", description: "Analytical budget only; no accounting voucher was posted." });
    },
    onError: (e) => toast({ title: "Could not save budget", description: message(e), variant: "destructive" }),
  });
  function changeFilter(set: (v: string) => void, v: string) {
    set(v);
    setOffset(0);
  }
  async function download(format: "xlsx" | "pdf" | "csv", detail = false) {
    setExporting(format);
    try {
      const base = baseUrl + (consolidated ? "/reports/consolidated/export" : "/reports/export");
      await downloadFromUrl(
        base +
          "?" +
          params +
          "&format=" +
          format +
          "&view=" +
          (detail ? "activity" : view === "centers" ? "summary" : view),
        { fileName: exportFileName("cost centers " + (detail ? "activity" : view), format, { from, to }) }
      );
    } catch (e) {
      toast({ title: "Export failed", description: message(e), variant: "destructive" });
    } finally {
      setExporting(null);
    }
  }
  function navigateTo(row: Activity) {
    if (row.voucherId) {
      navigate((factory ? "/factory/voucher-detail/" : "/voucher-detail/") + row.voucherId);
    } else if (factory && row.factoryDaybookEntryId) {
      navigate("/factory/daybook?entryId=" + row.factoryDaybookEntryId);
    }
  }
  return {
    accountFilter,
    accounts,
    activity,
    activityError,
    activityLoading,
    budgetAmount,
    budgetCenter,
    budgetEntry,
    budgetList,
    budgetMonth,
    budgetNotes,
    budgetReason,
    budgetSave,
    centerFilter,
    centers,
    changeFilter,
    chart,
    consolidated,
    download,
    error,
    exporting,
    from,
    isEditor,
    isError,
    isLoading,
    navigateTo,
    offset,
    queryActive,
    refetch,
    setAccountFilter,
    setBudgetAmount,
    setBudgetCenter,
    setBudgetMonth,
    setBudgetNotes,
    setBudgetReason,
    setCenterFilter,
    setConsolidated,
    setFrom,
    setOffset,
    setTo,
    setTreatment,
    setView,
    summary,
    to,
    treatment,
    view,
  };
}

export function CostCenterReportsSection({
  activity,
  activityError,
  activityLoading,
  navigateTo,
}: Pick<
  ReturnType<typeof useCostCenterReportsState>,
  "activity" | "activityError" | "activityLoading" | "navigateTo"
>) {
  return (
    <div>
      {activityLoading && <p className="p-3 text-sm">Loading source transactions…</p>}
      {activityError && <p className="p-3 text-sm text-destructive">{message(activityError)}</p>}
      <table className="w-full text-sm min-w-[780px]">
        <thead className="bg-muted/40">
          <tr className="text-left">
            <th className="p-2">Date / Source</th>
            <th className="p-2">Cost Center</th>
            <th className="p-2">Account</th>
            <th className="p-2">Treatment</th>
            <th className="p-2 text-right">Original amount</th>
            <th className="p-2 text-right">USD</th>
          </tr>
        </thead>
        <tbody>
          {(activity?.activity || []).map((x) => (
            <tr className="border-t" key={x.companyId + ":" + x.id}>
              <td className="p-2">
                <p>{x.sourceDate?.slice(0, 10)}</p>
                {x.voucherId || x.factoryDaybookEntryId ? (
                  <button className="text-primary text-xs hover:underline text-left" onClick={() => navigateTo(x)}>
                    {x.voucherNumber || "Daybook #" + x.factoryDaybookEntryId}
                  </button>
                ) : (
                  <span className="text-xs">Allocation #{x.id}</span>
                )}
              </td>
              <td className="p-2">
                {x.costCenterCode} — {x.costCenterName}
              </td>
              <td className="p-2">{x.accountName}</td>
              <td className="p-2">
                <span className="block">{x.treatment}</span>
                <span className="text-xs text-muted-foreground">{x.allocationOrigin}</span>
              </td>
              <td className="p-2 text-right font-mono">
                {x.currency} {fmt(x.amountNative)}
              </td>
              <td className="p-2 text-right font-mono">{fmt(x.amountUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
