import { UnifiedAccountPicker } from "@/components/accounts/UnifiedAccountPicker";
// Extracted from ./CostCenterReports.tsx to keep that module under the source-size cap.
import { Button } from "@/components/ui/button";
import { ExportButton } from "@/components/export/ReportExportMenu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { fmt, strictMoney, useCostCenterReportsState } from "./useCostCenterReportsState";

export function CostCenterReportsSection2({
  download,
  exporting,
  setOffset,
  setView,
  view,
}: Pick<ReturnType<typeof useCostCenterReportsState>, "download" | "exporting" | "setOffset" | "setView" | "view">) {
  return (
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
          <ExportButton
            key={format}
            kind={format === "xlsx" ? "excel" : format}
            size="sm"
            disabled={exporting !== null}
            busy={exporting === format}
            onClick={() => void download(format, view === "activity")}
          />
        ))}
      </div>
    </div>
  );
}

export function CostCenterReportsSection3({
  budgetAmount,
  budgetCenter,
  budgetEntry,
  budgetList,
  budgetMonth,
  budgetNotes,
  budgetReason,
  budgetSave,
  centers,
  setBudgetAmount,
  setBudgetCenter,
  setBudgetMonth,
  setBudgetNotes,
  setBudgetReason,
}: Pick<
  ReturnType<typeof useCostCenterReportsState>,
  | "budgetAmount"
  | "budgetCenter"
  | "budgetEntry"
  | "budgetList"
  | "budgetMonth"
  | "budgetNotes"
  | "budgetReason"
  | "budgetSave"
  | "centers"
  | "setBudgetAmount"
  | "setBudgetCenter"
  | "setBudgetMonth"
  | "setBudgetNotes"
  | "setBudgetReason"
>) {
  return (
    <div className="border-t pt-4 space-y-3">
      <h3 className="font-semibold text-sm">Monthly Budget (USD)</h3>
      <p className="text-xs text-muted-foreground">
        Budget one active cost center per calendar month. Budgets do not create transactions. Historical allocations
        remain unchanged.
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
        <p className="text-xs text-muted-foreground">Saved budget for this month: USD {fmt(budgetEntry.amountUsd)}</p>
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
            !budgetCenter || !strictMoney.test(budgetAmount) || budgetReason.trim().length < 3 || budgetSave.isPending
          }
          onClick={() => budgetSave.mutate()}
        >
          {budgetSave.isPending ? "Saving…" : "Save Monthly Budget"}
        </Button>
      </div>
    </div>
  );
}

export function CostCenterReportsSection4({
  accountFilter,
  accounts,
  centerFilter,
  centers,
  changeFilter,
  consolidated,
  from,
  isEditor,
  setAccountFilter,
  setCenterFilter,
  setConsolidated,
  setFrom,
  setOffset,
  setTo,
  setTreatment,
  to,
  treatment,
}: Pick<
  ReturnType<typeof useCostCenterReportsState>,
  | "accountFilter"
  | "accounts"
  | "centerFilter"
  | "centers"
  | "changeFilter"
  | "consolidated"
  | "from"
  | "isEditor"
  | "setAccountFilter"
  | "setCenterFilter"
  | "setConsolidated"
  | "setFrom"
  | "setOffset"
  | "setTo"
  | "setTreatment"
  | "to"
  | "treatment"
>) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
      <div className="space-y-1">
        <Label htmlFor="cc-report-from">From</Label>
        <Input id="cc-report-from" type="date" value={from} onChange={(e) => changeFilter(setFrom, e.target.value)} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="cc-report-to">To</Label>
        <Input id="cc-report-to" type="date" value={to} onChange={(e) => changeFilter(setTo, e.target.value)} />
      </div>
      <div className="space-y-1">
        <Label>Cost Center</Label>
        <Select value={centerFilter} onValueChange={(v) => changeFilter(setCenterFilter, v)} disabled={consolidated}>
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
        <UnifiedAccountPicker
          options={[
            { value: "all", name: "All Accounts" },
            ...(accounts?.accounts || []).map((a) => ({ value: String(a.id), name: a.name })),
          ]}
          value={accountFilter}
          onChange={(v) => changeFilter(setAccountFilter, v)}
          placeholder={"All Accounts"}
          disabled={consolidated}
        />
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
  );
}
