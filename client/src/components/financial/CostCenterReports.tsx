import { type CostCenter } from "@/api/costCentersApi";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { LineChart, Line, CartesianGrid, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer } from "recharts";
import { RefreshCw, BarChart3 } from "lucide-react";
import { CostCenterReportsSection, fmt, message, useCostCenterReportsState } from "./useCostCenterReportsState";
import {
  CostCenterReportsSection2,
  CostCenterReportsSection3,
  CostCenterReportsSection4,
} from "./CostCenterReportsSection3";

export function CostCenterReports(props: { baseUrl: string; centers: CostCenter[] }) {
  const {
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
  } = useCostCenterReportsState(props);
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
        <CostCenterReportsSection4
          accountFilter={accountFilter}
          accounts={accounts}
          centerFilter={centerFilter}
          centers={centers}
          changeFilter={changeFilter}
          consolidated={consolidated}
          from={from}
          isEditor={isEditor}
          setAccountFilter={setAccountFilter}
          setCenterFilter={setCenterFilter}
          setConsolidated={setConsolidated}
          setFrom={setFrom}
          setOffset={setOffset}
          setTo={setTo}
          setTreatment={setTreatment}
          to={to}
          treatment={treatment}
        />
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
            <CostCenterReportsSection2
              download={download}
              exporting={exporting}
              setOffset={setOffset}
              setView={setView}
              view={view}
            />
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
                <CostCenterReportsSection
                  activity={activity}
                  activityError={activityError}
                  activityLoading={activityLoading}
                  navigateTo={navigateTo}
                />
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
          <CostCenterReportsSection3
            budgetAmount={budgetAmount}
            budgetCenter={budgetCenter}
            budgetEntry={budgetEntry}
            budgetList={budgetList}
            budgetMonth={budgetMonth}
            budgetNotes={budgetNotes}
            budgetReason={budgetReason}
            budgetSave={budgetSave}
            centers={centers}
            setBudgetAmount={setBudgetAmount}
            setBudgetCenter={setBudgetCenter}
            setBudgetMonth={setBudgetMonth}
            setBudgetNotes={setBudgetNotes}
            setBudgetReason={setBudgetReason}
          />
        )}
      </CardContent>
    </Card>
  );
}
