import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { UnifiedAccountingBudgetBridge } from "@/components/financial/UnifiedAccountingBudgetBridge";
import { PageHeader } from "@/components/PageHeader";
import { Breakdown, Value, money } from "./UnifiedAccountingDashboardTypes";
import {
  Details,
  UnifiedAccountingDashboardCardSection,
  useUnifiedAccountingDashboardState,
} from "./useUnifiedAccountingDashboardState";

export default function UnifiedAccountingDashboard() {
  const {
    asOfDate,
    csv,
    data,
    fromDate,
    go,
    nav,
    prefix,
    selectedCompany,
    setAsOfDate,
    setFromDate,
    setShowOperations,
    setTab,
    showOperations,
    tab,
    x,
  } = useUnifiedAccountingDashboardState();
  return (
    <div className="space-y-5 p-3 sm:p-5" data-testid="unified-accounting-dashboard">
      <PageHeader
        title="Unified Net Position & Accounting Dashboard"
        meta={
          <>
            {selectedCompany?.name ?? "Selected company"} · One company · Posted historical USD accounting ·
            Provisional, not certified
          </>
        }
      />
      <UnifiedAccountingDashboardCardSection
        asOfDate={asOfDate}
        csv={csv}
        data={data}
        fromDate={fromDate}
        setAsOfDate={setAsOfDate}
        setFromDate={setFromDate}
        setShowOperations={setShowOperations}
        showOperations={showOperations}
        x={x}
      />
      {data.isLoading && <p className="text-sm text-muted-foreground">Reading posted financial records…</p>}
      {data.isError && (
        <p role="alert" className="text-destructive text-sm">
          {(data.error as Error).message}
        </p>
      )}
      {data.data && !x && (
        <p role="alert" className="text-destructive text-sm">
          Dashboard company or accounting basis does not match the selected company. Figures have been withheld.
        </p>
      )}
      {x && (
        <>
          <div className="space-y-1">
            <p className="font-semibold text-sm">
              Period {x.fromDate} through {x.asOfDate} · USD
            </p>
            <p className="text-destructive text-sm">
              PROVISIONAL — NOT CERTIFIED.
              {x.controls.blockers.length > 0 ? " " + x.controls.blockers.length + " accounting blocker(s)." : ""}
            </p>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <Value label="Booked assets" value={x.financialPosition.assetsUsd} />
            <Value label="Booked liabilities" value={x.financialPosition.liabilitiesUsd} />
            <Value
              label="Booked net assets"
              value={x.financialPosition.netAssetsUsd}
              explain="Assets less liabilities, no unposted stock added"
            />
            <Value label="Equity incl. unclosed earnings" value={x.financialPosition.equityIncludingEarningsUsd} />
            <Value label="Period revenue" value={x.performance.salesRevenueUsd} />
            <Value label="Period gross profit" value={x.performance.grossProfitUsd} />
            <Value label="Period net profit" value={x.performance.netProfitUsd} />
            <Value label="Cash movement (posted)" value={x.performance.recognizedCashMovementUsd} />
          </div>
          <div className="flex flex-wrap gap-2">
            {(["position", "profit", "budgets", "stock", "controls"] as const).map((k) => (
              <Button size="sm" key={k} variant={tab === k ? "default" : "outline"} onClick={() => setTab(k)}>
                {
                  (
                    {
                      position: "Booked net position",
                      profit: "Income & costs",
                      budgets: "Cost centers & budgets",
                      stock: "Stock & management bridge",
                      controls: "Controls & source detail",
                    } as const
                  )[k]
                }
              </Button>
            ))}
          </div>
          {tab === "position" && (
            <Card>
              <CardHeader>
                <CardTitle>Posted accounting net position</CardTitle>
              </CardHeader>
              <CardContent className="space-y-5">
                <div className="grid sm:grid-cols-2 gap-6">
                  <Breakdown title="Booked asset composition" totals={x.financialPosition.assetClasses} />
                  <Breakdown title="Booked liability composition" totals={x.financialPosition.liabilityClasses} />
                </div>
                <div className="space-y-2 border-t pt-3">
                  <div className="flex justify-between text-sm gap-3">
                    <strong>Assets less liabilities</strong>
                    <strong className="tabular-nums">{money(x.financialPosition.netAssetsUsd)} USD</strong>
                  </div>
                  <div className="flex justify-between text-sm gap-3">
                    <span>Booked equity (incl. unclosed earnings)</span>
                    <span className="tabular-nums">{money(x.financialPosition.equityIncludingEarningsUsd)}</span>
                  </div>
                  <div className="flex justify-between text-sm gap-3 text-destructive">
                    <span>Assets − liabilities − equity (before unclassified)</span>
                    <strong className="tabular-nums">
                      {money(x.financialPosition.reportedBalanceSheetDifferenceUsd)}
                    </strong>
                  </div>
                  <div className="flex justify-between text-sm gap-3">
                    <span>Unclassified posted accounts (signed net, not assigned to equity)</span>
                    <span className="tabular-nums">{money(x.financialPosition.unclassifiedUsd)}</span>
                  </div>
                  <div className="flex justify-between text-sm gap-3">
                    <span>Residual after separately displaying unclassified accounts</span>
                    <strong className="tabular-nums">{money(x.financialPosition.unexplainedDifferenceUsd)}</strong>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  Company standalone booked balances only. The accounting difference is displayed, not forced to zero.
                  This is not the operating Factory 'What We Have / What We Owe' presentation.
                </p>
                <Button variant="outline" onClick={() => nav("/accounting/statements")}>
                  Open financial statements
                </Button>
              </CardContent>
            </Card>
          )}
          {tab === "profit" && (
            <Card>
              <CardHeader>
                <CardTitle>Period recognized revenue and expenses</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                  <Value label="Sales revenue" value={x.performance.salesRevenueUsd} />
                  <Value label="Cost of sales" value={x.performance.costOfSalesUsd} />
                  <Value label="Gross profit" value={x.performance.grossProfitUsd} />
                  <Value label="Other income" value={x.performance.otherIncomeUsd} />
                  <Value label="Operating expenses" value={x.performance.operatingExpensesUsd} />
                  <Value label="Net booked result" value={x.performance.netProfitUsd} />
                </div>
                <p className="text-sm text-muted-foreground">
                  COGS is only the recognized posted cost of sales, not an estimated cost from an open Factory mix or
                  pending-loading invoice. Other income is separate from sales.
                </p>
                <Details title="Largest recorded revenue accounts" rows={x.drilldown.topRevenueAccounts} />
                <Details title="Largest recorded COGS accounts" rows={x.drilldown.topCostAccounts} />
                <Details title="Largest recorded expense accounts" rows={x.drilldown.topExpenses} />
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" onClick={() => nav("/accounting/statements")}>
                    Full profit & loss
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}
          {tab === "budgets" && (
            <UnifiedAccountingBudgetBridge
              companyId={x.companyId}
              fromDate={x.fromDate}
              asOfDate={x.asOfDate}
              mode={prefix === "/factory" ? "factory" : prefix === "/properties" ? "properties" : "erp"}
              onOpenCostCenters={() => go(prefix === "/factory" ? "/factory/cost-centers" : "/cost-centers")}
            />
          )}
          {tab === "stock" && (
            <Card>
              <CardHeader>
                <CardTitle>Operational cost versus booked inventory</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm font-medium">
                  Booked net assets do not include any added management inventory figure. Operational stock is a
                  distinct memorandum, not a balancing journal.
                </p>
                {!showOperations && (
                  <Button variant="outline" onClick={() => setShowOperations(true)}>
                    Load operational stock at recorded cost
                  </Button>
                )}
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                  <Value label="Stock accounts already recognized in ledger" value={x.operations.bookedStockAssetUsd} />
                  {x.operations.erpStock && (
                    <Value
                      label={
                        x.operations.erpStock.asOfBasis === "as-of"
                          ? "ERP stock at replayed historical cost"
                          : "ERP stock at current recorded cost"
                      }
                      value={x.operations.erpStock.costUsd}
                    />
                  )}
                  {x.operations.factoryStock && (
                    <>
                      <Value label="Factory raw stock cost" value={x.operations.factoryStock.rawUsd} />
                      <Value label="Factory work-in-progress cost" value={x.operations.factoryStock.wipUsd} />
                      <Value label="Factory finished bales cost" value={x.operations.factoryStock.finishedUsd} />
                      <Value
                        label="Factory stock cost total (current only)"
                        value={x.operations.factoryStock.totalUsd}
                      />
                    </>
                  )}
                  {x.operations.managementCostCandidateUsd !== null && (
                    <Value
                      label="ERP + Factory operational cost (current-date memo only)"
                      value={x.operations.managementCostCandidateUsd}
                    />
                  )}
                </div>
                {x.operations.managementCostCandidateBasis === "WITHHELD_MIXED_DATES" && (
                  <p className="text-sm text-destructive">
                    Combined management stock cost withheld: the ERP value is historical, but the Factory value is
                    current. They cannot form a valid total for the selected accounting date.
                  </p>
                )}
                {x.operations.managementCostCandidateBasis === "WITHHELD_INCOMPLETE_COST" && (
                  <p className="text-sm text-destructive">
                    Combined management stock cost withheld because ERP or Factory cost evidence is incomplete.
                  </p>
                )}
                {x.operations.factoryStock && (
                  <p className="text-sm text-muted-foreground">
                    {x.operations.factoryStock.reservedForOrders.bales} reserved/open-order bales and{" "}
                    {x.operations.factoryStock.soldNotInvoiced.bales} sold-not-invoiced bales are included at their
                    recorded costs, not recognized as customer COGS before finalization.
                  </p>
                )}
                {x.operations.factoryStock && x.operations.factoryStock.unvaluedCount > 0 && (
                  <p className="text-sm text-destructive">
                    Factory has {x.operations.factoryStock.unvaluedCount}
                    unvalued raw/mix/bale cost sources. The stock cost total is incomplete.
                  </p>
                )}
                {showOperations && (
                  <p className="text-sm text-muted-foreground">
                    ERP costing: {x.operations.erpStock?.asOfBasis ?? "not available"} · Factory costing: current only.
                    Perpetual stock ledger cutover at date:
                    {x.operations.perpetualStockLedgerActiveAsOf ? " Active" : " Not active"}.
                  </p>
                )}
                {showOperations && x.operations.glToOperationalAtCost.length > 0 && (
                  <div className="border-t pt-3 space-y-3">
                    <h3 className="font-semibold">Cost sub-ledger versus booked GL — diagnostic only</h3>
                    <p className="text-xs text-muted-foreground">
                      Only an active perpetual cutover and matching dated, complete cost records make a financial
                      GL-to-stock comparison meaningful. Blank differences are intentionally not estimated.
                    </p>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b text-left">
                            <th className="p-2">Account</th>
                            <th className="p-2 text-right">Booked GL USD</th>
                            <th className="p-2 text-right">Stock cost USD</th>
                            <th className="p-2 text-right">Difference USD</th>
                          </tr>
                        </thead>
                        <tbody>
                          {x.operations.glToOperationalAtCost.map((line) => (
                            <tr key={line.accountCode} className="border-b">
                              <td className="p-2">
                                {line.accountCode}
                                <div className="text-xs text-muted-foreground">{line.reason}</div>
                              </td>
                              <td className="p-2 text-right tabular-nums">{money(line.bookedGlUsd)}</td>
                              <td className="p-2 text-right tabular-nums">
                                {line.operationalCostUsd === null ? "—" : money(line.operationalCostUsd)}
                              </td>
                              <td className="p-2 text-right tabular-nums">
                                {line.comparable && line.differenceUsd !== null
                                  ? money(line.differenceUsd)
                                  : "Not comparable"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Reconciliation differences are flags for source review; this dashboard never posts an adjustment
                      or activates inventory cutover.
                    </p>
                  </div>
                )}
                <div className="border-t pt-3 space-y-2">
                  <p className="font-semibold text-sm">Stock in Selling Value — management mode</p>
                  <p className="text-sm text-muted-foreground">
                    Selling valuation is available in the existing Factory Net Position report, with its persisted
                    Cost/Selling selection. It is not inserted into book value, financial net assets or historical COGS
                    here. The original management screen may use a separately selected or pinned Factory company; never
                    compare its totals to this dashboard without independently verifying company ownership.
                  </p>
                  <Button
                    variant="outline"
                    onClick={() =>
                      go(
                        prefix === "/factory"
                          ? "/factory/intelligence/financial-hub"
                          : prefix === "/properties"
                            ? "/properties/net-position-details"
                            : "/net-position-details"
                      )
                    }
                  >
                    Open existing management Net Position
                  </Button>
                </div>
                {x.operations.warnings.map((w, i) => (
                  <p key={i} className="text-xs text-muted-foreground">
                    {w}
                  </p>
                ))}
              </CardContent>
            </Card>
          )}
          {tab === "controls" && (
            <Card>
              <CardHeader>
                <CardTitle>Reconciliation and accounting controls</CardTitle>
              </CardHeader>
              <CardContent className="space-y-5">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  <Value label="Trial balance difference" value={x.financialPosition.trialBalanceDifferenceUsd} />
                  <Value
                    label="Assets − liabilities − equity (before unclassified)"
                    value={x.financialPosition.reportedBalanceSheetDifferenceUsd}
                  />
                  <Value label="Remaining ledger residual" value={x.financialPosition.unexplainedDifferenceUsd} />
                  <Value
                    label="Cash-flow classification difference"
                    value={x.performance.cashFlowClassificationDifferenceUsd}
                  />
                  <div>
                    <p className="text-xs text-muted-foreground">Inventory posting cutover globally ready</p>
                    <p className="font-semibold">{x.controls.perpetualPostingGloballyReady ? "Yes" : "No"}</p>
                  </div>
                  <div className="col-span-2 sm:col-span-4 text-sm">
                    Historical FX compatibility check:{" "}
                    {x.historicalFx.legacyCompatibilityMode
                      ? "Legacy compatibility only — historical USD conversion is NOT verified"
                      : x.historicalFx.ready
                        ? "No tracked missing rows (not certified)"
                        : x.historicalFx.unresolvedEntryCount + " source line(s) missing historical USD base"}
                    .<p className="text-xs text-muted-foreground">{x.historicalFx.caveat}</p>
                  </div>
                </div>
                {x.controls.blockers.map((w, i) => (
                  <p key={i} className="text-sm text-destructive">
                    {w}
                  </p>
                ))}
                {x.controls.warnings.map((w, i) => (
                  <p key={i} className="text-sm">
                    {w}
                  </p>
                ))}
                <Details title="Largest recognized assets" rows={x.drilldown.topAssetAccounts} />
                <Details title="Largest recognized liabilities" rows={x.drilldown.topLiabilities} />
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" onClick={() => nav("/accounting/fiscal-review")}>
                    Fiscal closing controls
                  </Button>
                  <Button variant="outline" onClick={() => nav("/accounting/history")}>
                    Historical accounting
                  </Button>
                  <Button variant="outline" onClick={() => nav("/accounting/statements")}>
                    Detailed statement
                  </Button>
                  <Button variant="outline" onClick={() => nav("/accounting/consolidation")}>
                    Intercompany workpaper
                  </Button>
                </div>
                <div className="space-y-2 border-t pt-3">
                  <h3 className="font-semibold">Accounting source disclosures</h3>
                  {x.disclosures.map((line, i) => (
                    <p key={i} className="text-xs text-muted-foreground">
                      {line}
                    </p>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
