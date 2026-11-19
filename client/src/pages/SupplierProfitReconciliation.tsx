import { ExternalLink, RefreshCw } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PeriodFilter } from "@/components/ui/period-filter";
import { ErpField, ErpNativeSelect } from "@/erp-core";
import { dollars, SummaryRow, SummarySection, type Period } from "./SupplierProfitReconciliationParts";
import { useSupplierProfitReconciliationState } from "./useSupplierProfitReconciliationState";

export default function SupplierProfitReconciliation() {
  const {
    navigate,
    supplierId,
    setSupplierId,
    setGroupId,
    groupId,
    period,
    setPeriod,
    day,
    setDay,
    month,
    setMonth,
    year,
    setYear,
    from,
    setFrom,
    to,
    setTo,
    optionsQuery,
    options,
    range,
    validRange,
    reportQuery,
    supplierBalanceQuery,
    report,
    totals,
    isAllTime,
    bridgeGap,
    salesReportUrl,
  } = useSupplierProfitReconciliationState();

  return (
    <div className="flex h-full min-w-0 flex-col" data-testid="supplier-profit-reconciliation">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-background px-4 py-3">
        <PageHeader title="Supplier Profit Review" />
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void optionsQuery.refetch();
            void reportQuery.refetch();
            void supplierBalanceQuery.refetch();
          }}
        >
          <RefreshCw className="mr-2 h-4 w-4" />
          Refresh
        </Button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto p-3 sm:p-5">
        <div className="mx-auto max-w-4xl space-y-4">
          <Card>
            <CardContent className="grid gap-3 p-4 sm:grid-cols-3">
              <ErpField id="profit-supplier" label="Supplier">
                {(control) => (
                  <ErpNativeSelect
                    {...control}
                    value={supplierId}
                    onChange={(event) => {
                      setSupplierId(event.target.value);
                      setGroupId("");
                    }}
                  >
                    <option value="">Select supplier</option>
                    {options?.suppliers.map((supplier) => (
                      <option key={supplier.id} value={supplier.id}>
                        {supplier.name}
                      </option>
                    ))}
                  </ErpNativeSelect>
                )}
              </ErpField>
              <ErpField id="profit-stock-group" label="Stock group">
                {(control) => (
                  <ErpNativeSelect {...control} value={groupId} onChange={(event) => setGroupId(event.target.value)}>
                    <option value="">All groups (items received from supplier)</option>
                    {options?.groups.map((group) => (
                      <option key={group.id} value={group.id}>
                        {group.name}
                      </option>
                    ))}
                  </ErpNativeSelect>
                )}
              </ErpField>
              <ErpField id="profit-period" label="Date selection">
                {(control) => (
                  <ErpNativeSelect
                    {...control}
                    value={period}
                    onChange={(event) => setPeriod(event.target.value as Period)}
                  >
                    <option value="all">All time</option>
                    <option value="day">Specific day</option>
                    <option value="month">Specific month</option>
                    <option value="year">Specific year</option>
                    <option value="custom">Custom date range</option>
                  </ErpNativeSelect>
                )}
              </ErpField>
              {period === "day" && (
                <ErpField id="profit-day" label="Day">
                  {(control) => (
                    <Input {...control} type="date" value={day} onChange={(event) => setDay(event.target.value)} />
                  )}
                </ErpField>
              )}
              {period === "month" && (
                <ErpField id="profit-month" label="Month">
                  {(control) => (
                    <Input {...control} type="month" value={month} onChange={(event) => setMonth(event.target.value)} />
                  )}
                </ErpField>
              )}
              {period === "year" && (
                <ErpField id="profit-year" label="Year">
                  {(control) => (
                    <Input
                      {...control}
                      type="number"
                      min="2000"
                      max="2100"
                      value={year}
                      onChange={(event) => setYear(event.target.value)}
                    />
                  )}
                </ErpField>
              )}
              {period === "custom" && (
                <div className="flex items-end">
                  <PeriodFilter
                    value={{ fromDate: from, toDate: to, preset: "custom" }}
                    onChange={(v) => {
                      setFrom(v.fromDate);
                      setTo(v.toDate);
                    }}
                    data-testid="profit-custom-period"
                  />
                </div>
              )}
            </CardContent>
          </Card>

          {optionsQuery.isError && <p className="text-sm text-destructive">{(optionsQuery.error as Error).message}</p>}
          {reportQuery.isError && (
            <p className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">
              {(reportQuery.error as Error).message}
            </p>
          )}
          {!validRange && <p className="text-sm text-destructive">Choose a valid date range.</p>}
          {reportQuery.isLoading && supplierId && (
            <p className="text-sm text-muted-foreground">Calculating supplier amounts…</p>
          )}
          {!optionsQuery.isLoading && !options?.suppliers.length && (
            <p className="text-sm text-muted-foreground">No container-linked suppliers in this company.</p>
          )}

          {report && totals && validRange && (
            <Card>
              <CardContent className="space-y-4 p-4 sm:p-6">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold">{report.supplier.name}</h2>
                    <p className="text-xs text-muted-foreground">
                      {isAllTime ? "All time" : (range.from || "Beginning") + " — " + (range.to || "Now")}
                    </p>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => navigate(salesReportUrl)}>
                    <ExternalLink className="mr-2 h-4 w-4" />
                    Open Sales Report
                  </Button>
                </div>

                <SummarySection title="CONTAINERS">
                  <SummaryRow
                    label={"Offloading cost (" + totals.offloadedContainers + " offloaded containers)"}
                    value={dollars(totals.offloadingCharges)}
                  />
                  <SummaryRow
                    label={"Offloaded " + totals.offloadedContainers + " containers (without offloading cost)"}
                    value={dollars(totals.offloadedBase)}
                  />
                  <SummaryRow
                    label={"OTW " + totals.otwContainers + " containers (without offloading cost)"}
                    value={dollars(totals.otwBase)}
                  />
                  {isAllTime && (
                    <SummaryRow
                      label="Total cost of all containers"
                      value={dollars(totals.offloadedBase + totals.offloadingCharges + totals.otwBase)}
                      emphasis
                    />
                  )}
                </SummarySection>

                <SummarySection title="STOCK + SALES">
                  <SummaryRow label="Sold bales" value={dollars(totals.salesRevenue)} />
                  <SummaryRow label="Stock in hand (including offloading cost)" value={dollars(totals.currentStock)} />
                  <SummaryRow
                    label="Total stock + sales"
                    value={dollars(totals.salesRevenue + totals.currentStock)}
                    emphasis
                  />
                </SummarySection>

                <SummarySection title="PROFIT & SUPPLIER BALANCE">
                  {isAllTime && (
                    <SummaryRow label="Calculated profit from containers" value={dollars(totals.modeledProfit)} />
                  )}
                  <SummaryRow label="Total profit on the system" value={dollars(totals.storedProfit)} emphasis />
                  {isAllTime && (
                    <SummaryRow label="Difference" value={dollars(bridgeGap)} attention={Math.abs(bridgeGap) > 0.009} />
                  )}
                  <SummaryRow
                    label="Amount owed to supplier"
                    value={
                      supplierBalanceQuery.isLoading
                        ? "…"
                        : supplierBalanceQuery.data
                          ? dollars(supplierBalanceQuery.data.balance)
                          : "Unavailable"
                    }
                    emphasis
                  />
                </SummarySection>

                <p className="text-xs leading-relaxed text-muted-foreground">
                  {isAllTime
                    ? "Container profit is an estimate; shared stock items can belong to other suppliers. Supplier balance comes from the ledger."
                    : "Sales and offloaded receipts follow the selected dates. Stock, OTW and supplier balance are current; historical container profit is not calculated."}
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
