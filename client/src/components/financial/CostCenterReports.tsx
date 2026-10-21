/**
 * ERP + Factory cost-center reporting, analytics and budget management.
 * Reports use historical USD accounting facts; inventory cost is distinct
 * from recognized P&L expense. Does not post GL entries.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useCompany } from "@/contexts/CompanyContext";
import { useAppMode } from "@/contexts/AppModeContext";
import { useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { readCostCenterApi, writeCostCenterApi, type CostCenter } from "@/api/costCentersApi";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectTrigger, SelectContent, SelectValue, SelectItem } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { LineChart, Line, CartesianGrid, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer } from "recharts";
import { Download, RefreshCw, BarChart3 } from "lucide-react";

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
const fmt = (v: string | number | null | undefined) =>
  Number(v || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const message = (e: unknown) => (e instanceof Error ? e.message : "Request failed");
const strictMoney = /^(?:0|[1-9]\d{0,13})(?:\.\d{1,6})?$/;

export function CostCenterReports({ baseUrl, centers }: { baseUrl: string; centers: CostCenter[] }) {
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
      const response = await fetch(
        base +
          "?" +
          params +
          "&format=" +
          format +
          "&view=" +
          (detail ? "activity" : view === "centers" ? "summary" : view),
        { credentials: "include" }
      );
      if (!response.ok) {
        const err = (await response.json().catch(() => null)) as { message?: string } | null;
        throw new Error(err?.message || "Export unavailable");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "cost-centers-" + (detail ? "activity" : view) + "-" + from + "-" + to + "." + format;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 3000);
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
  return (
    <Card data-testid="cost-center-reports" className="overflow-hidden">
      <CardHeader className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base flex items-center gap-2">
            <BarChart3 className="w-4 h-4" /> Reports, Budgets & Analytics
          </CardTitle>
          <Button size="sm" variant="ghost" title="Refresh cost center reporting" onClick={() => void refetch()}>
            <RefreshCw className="w-4 h-4 mr-1" /> Refresh
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Amounts use posted historical USD. Expense credits reduce expense; reversed and optional vouchers are
          excluded. Capitalized inventory is displayed separately from operating expense. Monthly budgets are not
          prorated for partial date ranges.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
          <div className="space-y-1">
            <Label htmlFor="cc-report-from">From</Label>
            <Input
              id="cc-report-from"
              type="date"
              value={from}
              onChange={(e) => changeFilter(setFrom, e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="cc-report-to">To</Label>
            <Input id="cc-report-to" type="date" value={to} onChange={(e) => changeFilter(setTo, e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>Cost Center</Label>
            <Select
              value={centerFilter}
              onValueChange={(v) => changeFilter(setCenterFilter, v)}
              disabled={consolidated}
            >
              <SelectTrigger>
                <SelectValue placeholder="All centers" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Centers</SelectItem>
                {centers.map((c) => (
                  <SelectItem value={String(c.id)} key={c.id}>
                    {c.code} — {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Cost Treatment</Label>
            <Select value={treatment} onValueChange={(v) => changeFilter(setTreatment, v)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All (separate totals)</SelectItem>
                <SelectItem value="EXPENSE">Recognized expense only</SelectItem>
                <SelectItem value="INVENTORY_COST">Capitalized inventory only</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Expense Account</Label>
            <Select
              value={accountFilter}
              onValueChange={(v) => changeFilter(setAccountFilter, v)}
              disabled={consolidated}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Accounts</SelectItem>
                {(accounts?.accounts || []).map((a) => (
                  <SelectItem key={a.id} value={String(a.id)}>
                    {a.code} — {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {isEditor && (
            <div className="space-y-1">
              <Label>Company Scope</Label>
              <Select
                value={consolidated ? "consolidated" : "current"}
                onValueChange={(v) => {
                  setConsolidated(v === "consolidated");
                  setCenterFilter("all");
                  setAccountFilter("all");
                  setOffset(0);
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="current">Current Company</SelectItem>
                  <SelectItem value="consolidated">Authorized Companies (consolidated)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
        {!queryActive && <p className="text-sm text-destructive">Select a valid date range.</p>}
        {isError && (
          <p role="alert" className="text-sm text-destructive">
            Cannot load report: {message(error)}
          </p>
        )}
        {isLoading && <p className="text-sm text-muted-foreground">Loading analytical report…</p>}
        {summary && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-2">
              {(
                [
                  ["Allocated expense (USD)", summary.totals.expense],
                  [
                    "Unallocated expense (USD)",
                    summary.totals.unallocatedApplicable ? summary.totals.unallocated : "—",
                  ],
                  ["Recognized expense in scope", summary.totals.recognizedExpense],
                  ["Budget (USD)", summary.totals.budget],
                  ["Variance: over/(under)", summary.totals.variance],
                  ["Inventory cost — separate", summary.totals.inventoryCost],
                ] as Array<[string, string]>
              ).map(([label, value]) => (
                <div key={label} className="rounded-md border p-3 min-w-0">
                  <p className="text-xs text-muted-foreground">{label}</p>
                  <p className="font-semibold font-mono break-all">{value === "—" ? "—" : fmt(value)}</p>
                </div>
              ))}
            </div>
            {accountFilter !== "all" && (
              <p className="text-xs text-muted-foreground">
                Account filters do not proportionally divide cost-center budgets; budget comparison is omitted for this
                filtered view.
              </p>
            )}
            {centerFilter !== "all" && (
              <p className="text-xs text-muted-foreground">
                Unallocated source spending cannot be attributed to a specific center and is excluded from this
                selected-center view.
              </p>
            )}
            {consolidated && (
              <p className="text-xs text-muted-foreground">
                Consolidated from {summary.companyIds.length} companies with approved accounting access. This is an
                analytical view: no intercompany vouchers are recreated.
              </p>
            )}
            {chart.length > 0 && (
              <div className="rounded-md border p-2">
                <p className="text-sm font-medium px-2">Monthly expense vs budget</p>
                <div className="h-64 w-full" role="img" aria-label="Cost center expense versus budget monthly trend">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={chart} margin={{ top: 10, right: 18, left: 4, bottom: 4 }}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="month" fontSize={11} />
                      <YAxis fontSize={11} width={65} />
                      <Tooltip formatter={(v) => fmt(String(v))} />
                      <Legend />
                      <Line type="monotone" dataKey="Expense" stroke="#2463af" dot={false} strokeWidth={2} />
                      <Line type="monotone" dataKey="Budget" stroke="#c68624" dot={false} strokeWidth={2} />
                      {summary.totals.unallocatedApplicable && (
                        <Line type="monotone" dataKey="Unallocated" stroke="#b74c55" dot={false} strokeWidth={1} />
                      )}
                      {treatment !== "EXPENSE" && (
                        <Line
                          type="monotone"
                          dataKey="Inventory (separate)"
                          stroke="#72768a"
                          dot={false}
                          strokeWidth={1}
                        />
                      )}
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex gap-1 flex-wrap">
                {(["centers", "departments", "accounts", "months", "activity"] as const).map((tab) => (
                  <Button
                    key={tab}
                    size="sm"
                    variant={view === tab ? "default" : "outline"}
                    onClick={() => {
                      setView(tab);
                      setOffset(0);
                    }}
                  >
                    {tab === "centers"
                      ? "By Cost Center"
                      : tab === "departments"
                        ? "Departments"
                        : tab === "accounts"
                          ? "By Expense Account"
                          : tab === "months"
                            ? "Monthly"
                            : "Source Drill-down"}
                  </Button>
                ))}
              </div>
              <div className="flex flex-wrap gap-1">
                {(["csv", "xlsx", "pdf"] as const).map((format) => (
                  <Button
                    key={format}
                    variant="outline"
                    size="sm"
                    disabled={exporting !== null}
                    onClick={() => void download(format, view === "activity")}
                  >
                    <Download className="w-3 h-3 mr-1" />
                    {format.toUpperCase()}
                  </Button>
                ))}
              </div>
            </div>
            <div className="max-w-full overflow-x-auto rounded-md border">
              {view === "centers" && (
                <table className="w-full text-sm min-w-[700px]">
                  <thead className="bg-muted/40">
                    <tr className="text-left">
                      <th className="p-2">Company / Center</th>
                      <th className="p-2 text-right">Expense USD</th>
                      <th className="p-2 text-right">Budget USD</th>
                      <th className="p-2 text-right">Variance USD</th>
                      <th className="p-2 text-right">Inventory USD</th>
                      <th className="p-2 text-right">Entries</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.centers.map((x) => (
                      <tr key={x.companyId + ":" + x.costCenterId} className="border-t">
                        <td className="p-2">
                          <span className="font-medium">
                            {x.code} — {x.name}
                          </span>
                          <span className="text-xs text-muted-foreground block">{x.companyName}</span>
                          {!x.active && <Badge variant="secondary">Archived</Badge>}
                        </td>
                        <td className="p-2 text-right font-mono">{fmt(x.expense)}</td>
                        <td className="p-2 text-right font-mono">{fmt(x.budget)}</td>
                        <td className="p-2 text-right font-mono">{fmt(x.variance)}</td>
                        <td className="p-2 text-right font-mono">{fmt(x.inventoryCost)}</td>
                        <td className="p-2 text-right">{x.entries}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {view === "departments" && (
                <table className="w-full text-sm min-w-[640px]">
                  <thead className="bg-muted/40">
                    <tr className="text-left">
                      <th className="p-2">Department / Parent Center</th>
                      <th className="p-2 text-right">Members</th>
                      <th className="p-2 text-right">Expense USD</th>
                      <th className="p-2 text-right">Budget USD</th>
                      <th className="p-2 text-right">Variance USD</th>
                      <th className="p-2 text-right">Inventory USD</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.departments.map((x) => (
                      <tr className="border-t" key={x.companyId + ":" + x.costCenterId}>
                        <td className="p-2">
                          {x.code} — {x.name}
                          <span className="text-xs text-muted-foreground block">{x.companyName}</span>
                        </td>
                        <td className="p-2 text-right">{x.members}</td>
                        <td className="p-2 text-right font-mono">{fmt(x.expense)}</td>
                        <td className="p-2 text-right font-mono">{fmt(x.budget)}</td>
                        <td className="p-2 text-right font-mono">{fmt(x.variance)}</td>
                        <td className="p-2 text-right font-mono">{fmt(x.inventoryCost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {view === "months" && (
                <table className="w-full text-sm min-w-[640px]">
                  <thead className="bg-muted/40">
                    <tr className="text-left">
                      <th className="p-2">Month</th>
                      <th className="p-2 text-right">Allocated expense</th>
                      <th className="p-2 text-right">Unallocated</th>
                      <th className="p-2 text-right">Budget</th>
                      <th className="p-2 text-right">Variance</th>
                      <th className="p-2 text-right">Inventory costs</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.months.map((x) => (
                      <tr key={x.month} className="border-t">
                        <td className="p-2">{x.month}</td>
                        <td className="p-2 text-right font-mono">{fmt(x.expense)}</td>
                        <td className="p-2 text-right font-mono">{fmt(x.unallocated)}</td>
                        <td className="p-2 text-right font-mono">{fmt(x.budget)}</td>
                        <td className="p-2 text-right font-mono">{fmt(x.variance)}</td>
                        <td className="p-2 text-right font-mono">{fmt(x.inventoryCost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {view === "accounts" && (
                <table className="w-full text-sm min-w-[500px]">
                  <thead className="bg-muted/40">
                    <tr className="text-left">
                      <th className="p-2">Account</th>
                      <th className="p-2 text-right">Expense USD</th>
                      <th className="p-2 text-right">Inventory USD</th>
                      <th className="p-2 text-right">Entries</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.accounts.map((x) => (
                      <tr key={x.companyId + ":" + (x.accountId ?? "factory")} className="border-t">
                        <td className="p-2">
                          {x.accountName}{" "}
                          {consolidated && <span className="text-xs text-muted-foreground">({x.companyId})</span>}
                        </td>
                        <td className="p-2 text-right font-mono">{fmt(x.expense)}</td>
                        <td className="p-2 text-right font-mono">{fmt(x.inventoryCost)}</td>
                        <td className="p-2 text-right">{x.entries}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {view === "activity" && (
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
                              <button
                                className="text-primary text-xs hover:underline text-left"
                                onClick={() => navigateTo(x)}
                              >
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
              )}
            </div>
            {view === "activity" && (
              <div className="flex gap-2 justify-between">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={offset === 0 || activityLoading}
                  onClick={() => setOffset((v) => Math.max(0, v - 50))}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={activityLoading || (activity?.activity.length || 0) < 50}
                  onClick={() => setOffset((v) => v + 50)}
                >
                  Next
                </Button>
              </div>
            )}
          </div>
        )}
        {!consolidated && isEditor && (
          <div className="border-t pt-4 space-y-3">
            <h3 className="font-semibold text-sm">Monthly Budget (USD)</h3>
            <p className="text-xs text-muted-foreground">
              Budget one active cost center per calendar month. Budgets do not create transactions. Historical
              allocations remain unchanged.
            </p>
            <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-2">
              <div className="space-y-1">
                <Label>Cost Center</Label>
                <Select
                  value={budgetCenter}
                  onValueChange={(v) => {
                    setBudgetCenter(v);
                    const existing = budgetList?.budgets.find((x) => x.costCenterId === Number(v));
                    setBudgetAmount(existing?.amountUsd || "0");
                    setBudgetNotes(existing?.notes || "");
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Choose a center" />
                  </SelectTrigger>
                  <SelectContent>
                    {centers
                      .filter((x) => x.active)
                      .map((x) => (
                        <SelectItem key={x.id} value={String(x.id)}>
                          {x.code} — {x.name}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="cc-budget-month">Budget Month</Label>
                <Input
                  id="cc-budget-month"
                  type="month"
                  value={budgetMonth}
                  onChange={(e) => {
                    setBudgetMonth(e.target.value);
                    setBudgetAmount("0");
                    setBudgetNotes("");
                  }}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="cc-budget-value">Budget USD</Label>
                <Input
                  id="cc-budget-value"
                  inputMode="decimal"
                  value={budgetAmount}
                  onChange={(e) => setBudgetAmount(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="cc-budget-reason">Reason</Label>
                <Input
                  id="cc-budget-reason"
                  value={budgetReason}
                  maxLength={500}
                  onChange={(e) => setBudgetReason(e.target.value)}
                />
              </div>
            </div>
            {budgetCenter && budgetEntry && (
              <p className="text-xs text-muted-foreground">
                Saved budget for this month: USD {fmt(budgetEntry.amountUsd)}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <Input
                value={budgetNotes}
                placeholder="Budget notes (optional)"
                maxLength={1200}
                onChange={(e) => setBudgetNotes(e.target.value)}
                className="w-full sm:max-w-md"
              />
              <Button
                disabled={
                  !budgetCenter ||
                  !strictMoney.test(budgetAmount) ||
                  budgetReason.trim().length < 3 ||
                  budgetSave.isPending
                }
                onClick={() => budgetSave.mutate()}
              >
                {budgetSave.isPending ? "Saving…" : "Save Monthly Budget"}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
