/**
 * Unified Accounting Phase 12 — read-only view into the existing Cost Centers
 * reporting service. This is an analytical dimension, NEVER a second GL/P&L.
 * ERP and Factory use their existing per-company report/permission boundaries.
 */
import { useQuery } from "@tanstack/react-query";
import { readCostCenterApi } from "@/api/costCentersApi";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

type CostCenterMode = "erp" | "factory" | "properties";
type BudgetSummary = {
  scope: string;
  companyIds: number[];
  currency: string;
  period: { from: string; to: string; budgetBasis: string };
  totals: {
    expense: string;
    inventoryCost: string;
    budget: string;
    unallocated: string;
    recognizedExpense: string;
    variance: string;
    unallocatedApplicable: boolean;
  };
  centers: Array<{
    companyId: number;
    costCenterId: number;
    code: string;
    name: string;
    expense: string;
    budget: string;
    variance: string;
    inventoryCost: string;
    utilization: string | null;
  }>;
  months: Array<{
    month: string;
    expense: string;
    unallocated: string;
    budget: string;
    variance: string;
  }>;
};

const displayMoney = (value: string) =>
  Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-b pb-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="font-semibold tabular-nums">{displayMoney(value)} USD</p>
    </div>
  );
}

export function UnifiedAccountingBudgetBridge({
  companyId,
  fromDate,
  asOfDate,
  mode,
  onOpenCostCenters,
}: {
  companyId: number;
  fromDate: string;
  asOfDate: string;
  mode: CostCenterMode;
  onOpenCostCenters: () => void;
}) {
  const supported = mode !== "properties";
  const baseUrl = mode === "factory" ? "/api/factory/cost-centers" : "/api/cost-centers";
  const query = new URLSearchParams({
    fromDate,
    toDate: asOfDate,
    treatment: "ALL",
  });
  const { data, isLoading, isError, error, refetch } = useQuery<BudgetSummary>({
    queryKey: ["unified-accounting", "phase12", mode, companyId, fromDate, asOfDate],
    queryFn: () => readCostCenterApi<BudgetSummary>(baseUrl + "/reports/summary?" + query.toString()),
    enabled: supported && Number.isSafeInteger(companyId) && companyId > 0 && fromDate <= asOfDate,
    staleTime: 30000,
    retry: false,
  });
  const validScope =
    data?.scope === "company" &&
    data.companyIds.length === 1 &&
    data.companyIds[0] === companyId &&
    data.period.from === fromDate &&
    data.period.to === asOfDate &&
    data.currency === "USD";
  const centers = validScope ? data.centers.filter((center) => center.companyId === companyId) : [];
  return (
    <Card data-testid="unified-accounting-phase12-budget">
      <CardHeader>
        <CardTitle>Cost center budgets & analytical spending — Phase 12</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          This is the existing Cost Centers analytical report, not an extra accounting ledger. Expense allocations and
          whole-month USD budgets are compared separately from posted Profit & Loss. Inventory-capitalized allocations
          are not operating expenses.
        </p>
        {!supported ? (
          <p className="text-sm text-muted-foreground">
            Properties/Rentals does not have a native cost-center workspace. No ERP or Factory budgets are shown for
            this shell or copied into rental accounts.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={onOpenCostCenters}>
                Open Cost Centers & budgets
              </Button>
              <Button variant="outline" onClick={() => refetch()} disabled={isLoading}>
                Refresh analytical report
              </Button>
            </div>
            {isLoading && <p className="text-sm text-muted-foreground">Loading company cost-center budget…</p>}
            {isError && (
              <p role="alert" className="text-sm text-destructive">
                Cost-center reporting is unavailable: {(error as Error).message}. No budget values were estimated.
              </p>
            )}
            {data && !validScope && (
              <p role="alert" className="text-sm text-destructive">
                Returned company, currency or accounting dates do not match this dashboard. Analytical totals are
                withheld.
              </p>
            )}
            {data && validScope && (
              <>
                <p className="text-xs text-muted-foreground">
                  Posted eligible source dates: {data.period.from} – {data.period.to}. Budgets include each full
                  calendar month touched by this range, without prorating partial months. Variance = recognized
                  analytical expense (including unallocated) minus budget.
                </p>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  <Metric label="Allocated recognized expense" value={data.totals.expense} />
                  <Metric label="Unallocated recognized expense" value={data.totals.unallocated} />
                  <Metric label="Total recognized analytical expense" value={data.totals.recognizedExpense} />
                  <Metric label="Whole-month budget" value={data.totals.budget} />
                  <Metric label="Expense minus budget (positive = over)" value={data.totals.variance} />
                  <Metric label="Capitalized inventory (separate)" value={data.totals.inventoryCost} />
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <caption className="text-left text-xs text-muted-foreground pb-2">
                      Cost-center allocation, not a reconciliation of all company GL expenses
                    </caption>
                    <thead>
                      <tr className="border-b text-left">
                        <th scope="col" className="p-2">
                          Cost center
                        </th>
                        <th scope="col" className="p-2 text-right">
                          Expense USD
                        </th>
                        <th scope="col" className="p-2 text-right">
                          Budget USD
                        </th>
                        <th scope="col" className="p-2 text-right">
                          Variance USD
                        </th>
                        <th scope="col" className="p-2 text-right">
                          Utilization
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {centers.slice(0, 12).map((center) => (
                        <tr key={center.companyId + ":" + center.costCenterId} className="border-b">
                          <th scope="row" className="p-2 text-left font-normal">
                            {center.code} · {center.name}
                          </th>
                          <td className="p-2 text-right tabular-nums">{displayMoney(center.expense)}</td>
                          <td className="p-2 text-right tabular-nums">{displayMoney(center.budget)}</td>
                          <td className="p-2 text-right tabular-nums">{displayMoney(center.variance)}</td>
                          <td className="p-2 text-right tabular-nums">
                            {center.utilization === null ? "No budget" : center.utilization + "%"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {centers.length === 0 && (
                    <p className="text-sm text-muted-foreground">
                      No cost centers have been configured for this company.
                    </p>
                  )}
                  {centers.length > 12 && (
                    <p className="text-xs text-muted-foreground">
                      Showing 12 of {centers.length} cost centers. Open Cost Centers for the complete report.
                    </p>
                  )}
                </div>
                {data.months.length > 0 && (
                  <div className="overflow-x-auto">
                    <p className="font-medium text-sm mb-2">Monthly analytical spend against budgets</p>
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-left">
                          <th scope="col" className="p-2">
                            Month
                          </th>
                          <th scope="col" className="p-2 text-right">
                            Allocated expense USD
                          </th>
                          <th scope="col" className="p-2 text-right">
                            Unallocated expense USD
                          </th>
                          <th scope="col" className="p-2 text-right">
                            Budget USD
                          </th>
                          <th scope="col" className="p-2 text-right">
                            Variance USD
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.months.map((month) => (
                          <tr key={month.month} className="border-b">
                            <th scope="row" className="p-2 text-left font-normal">
                              {month.month}
                            </th>
                            <td className="p-2 text-right tabular-nums">{displayMoney(month.expense)}</td>
                            <td className="p-2 text-right tabular-nums">{displayMoney(month.unallocated)}</td>
                            <td className="p-2 text-right tabular-nums">{displayMoney(month.budget)}</td>
                            <td className="p-2 text-right tabular-nums">{displayMoney(month.variance)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <p className="text-xs text-muted-foreground">
                  This tab is read-only. Budgets never post vouchers, create inventory assets, revalue stock or change
                  the booked net position. Unallocated source expense may not be comparable to financial-statement
                  operating expenses without a separate independent mapping of journal types and fiscal exclusions.
                </p>
              </>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
