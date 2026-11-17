// Extracted from ./SpReports.tsx to keep that module under the source-size cap.
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { BarChart3, FileSpreadsheet, Loader2 } from "lucide-react";
import { ExportButton } from "@/components/export/ReportExportMenu";
import { QuickMonthlyClose } from "./golden-coast/QuickMonthlyClose";
import { fmt, useSpReportsState, type ReportTab } from "./useSpReportsState";
import { PeriodFilter } from "@/components/ui/period-filter";

export function SpReportsTabsSection({
  accounts,
  completeMonth,
  developerCorrection,
  endDate,
  exportCashAccountId,
  exportFrom,
  exportLocationId,
  exportTo,
  exporting,
  exportingV2,
  handleExportSalesForm,
  handleExportSalesFormV2,
  isDeveloper,
  locations,
  profit,
  profitLoading,
  recordChanges,
  selectedCompany,
  setCorrectedProfit,
  setCorrectionConfirmation,
  setCorrectionReason,
  setEditProfitOpen,
  setEndDate,
  setExportCashAccountId,
  setExportFrom,
  setExportLocationId,
  setExportTo,
  setStartDate,
  setTab,
  splits,
  splitsLoading,
  startDate,
  tab,
}: Pick<
  ReturnType<typeof useSpReportsState>,
  | "accounts"
  | "completeMonth"
  | "developerCorrection"
  | "endDate"
  | "exportCashAccountId"
  | "exportFrom"
  | "exportLocationId"
  | "exportTo"
  | "exporting"
  | "exportingV2"
  | "handleExportSalesForm"
  | "handleExportSalesFormV2"
  | "isDeveloper"
  | "locations"
  | "profit"
  | "profitLoading"
  | "recordChanges"
  | "selectedCompany"
  | "setCorrectedProfit"
  | "setCorrectionConfirmation"
  | "setCorrectionReason"
  | "setEditProfitOpen"
  | "setEndDate"
  | "setExportCashAccountId"
  | "setExportFrom"
  | "setExportLocationId"
  | "setExportTo"
  | "setStartDate"
  | "setTab"
  | "splits"
  | "splitsLoading"
  | "startDate"
  | "tab"
>) {
  return (
    <Tabs value={tab} onValueChange={(value) => setTab(value as ReportTab)}>
      <div className="erp-mobile-scroll-tabs pb-1">
        <TabsList
          data-testid="tabs-sp-reports"
          className="w-max min-w-full sm:min-w-0 sm:w-fit"
          aria-label="Supplier Partner reports"
        >
          <TabsTrigger value="profit" data-testid="tab-sp-profit">
            <BarChart3 className="h-3.5 w-3.5 mr-1.5" /> Profit & Loss
          </TabsTrigger>
          <TabsTrigger value="sales-form" data-testid="tab-sp-salesform">
            <FileSpreadsheet className="h-3.5 w-3.5 mr-1.5" /> Sales Form
          </TabsTrigger>
        </TabsList>
      </div>

      <TabsContent value="profit" className="mt-4 space-y-4">
        <div className="flex items-center gap-3 flex-wrap">
          <PeriodFilter
            value={{ fromDate: startDate, toDate: endDate, preset: startDate || endDate ? "custom" : "all_time" }}
            onChange={(v) => {
              setStartDate(v.fromDate);
              setEndDate(v.toDate);
            }}
            data-testid="sp-profit-period"
          />
        </div>

        {profitLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-8 justify-center">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading...
          </div>
        ) : profit ? (
          <>
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div>
                    <CardTitle className="text-sm">Profit & Loss Summary</CardTitle>
                    <CardDescription className="text-xs">{profit.saleCount} sales in period</CardDescription>
                  </div>
                  {recordChanges.allowed && isDeveloper && completeMonth && developerCorrection && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={developerCorrection?.finalized === true}
                      data-testid="button-sp-developer-edit-profit"
                      onClick={() => {
                        setCorrectedProfit(String(developerCorrection?.effectiveNetProfit ?? profit.netProfit ?? "0"));
                        setCorrectionReason("");
                        setCorrectionConfirmation("");
                        setEditProfitOpen(true);
                      }}
                    >
                      Edit Profit
                    </Button>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                <div className="space-y-1">
                  {[
                    { label: "Total Revenue", value: profit.totalRevenue ?? 0, className: "text-green-600" },
                    {
                      label: "COGS (base + landed)",
                      value: -(profit.totalCogs ?? 0),
                      className: "text-destructive",
                    },
                    {
                      label: "Gross Profit",
                      value: profit.grossProfit ?? 0,
                      className: "font-semibold border-t border-border/40 pt-1 mt-1",
                    },
                    {
                      label: "Shared Charges",
                      value: -(profit.totalSharedCharges ?? 0),
                      className: "text-destructive",
                    },
                    {
                      label: "Net Profit",
                      value: profit.netProfit ?? 0,
                      className: "font-bold border-t border-border/40 pt-1 mt-1 text-base",
                    },
                  ].map((row, i) => (
                    <div
                      key={i}
                      className={`flex items-center justify-between text-sm py-0.5 ${row.className || ""}`}
                      data-testid={`row-sp-pl-${i}`}
                    >
                      <span>{row.label}</span>
                      <span className="tabular-nums">
                        {fmt(Math.abs(row.value))}
                        {row.value < 0 ? " (cost)" : ""}
                      </span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Profit Split</CardTitle>
                <CardDescription className="text-xs">
                  Choose the report month and split it using the ledger-derived Golden Coast monthly close.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <QuickMonthlyClose
                  periodMonth={endDate.length >= 7 ? endDate.slice(0, 7) : ""}
                  companyKey={selectedCompany?.id ?? "no-company"}
                />
              </CardContent>
            </Card>
          </>
        ) : null}

        {!splitsLoading && splits.length > 0 && (
          <div className="space-y-1">
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Finalized Splits</h3>
            {splits.map((s) => (
              <div
                key={s.id}
                className="flex items-center justify-between text-xs py-1.5 border-b border-border/30"
                data-testid={`row-sp-split-${s.id}`}
              >
                <span className="font-mono">{s.periodMonth}</span>
                <span className="text-muted-foreground">
                  Net {fmt(Number(s.ourShare ?? 0) + Number(s.supplierShare ?? 0))}
                </span>
                <span className="text-green-600">Our: {fmt(s.ourShare)}</span>
                <span className="text-orange-600">Sup: {fmt(s.supplierShare)}</span>
              </div>
            ))}
          </div>
        )}
      </TabsContent>

      <TabsContent value="sales-form" className="mt-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Export Sales Form Excel</CardTitle>
            <CardDescription className="text-xs">
              Downloads the same workbook format as the supplier sales form — Costing, Sales, ENTRY, Summary, and
              Summary-Itemwise sheets filled with current data.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-end gap-3 flex-wrap">
              <div>
                <label className="text-xs text-muted-foreground">From</label>
                <Input
                  type="date"
                  value={exportFrom}
                  onChange={(e) => setExportFrom(e.target.value)}
                  className="mt-1 w-36"
                  data-testid="input-sp-export-from"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">To</label>
                <Input
                  type="date"
                  value={exportTo}
                  onChange={(e) => setExportTo(e.target.value)}
                  className="mt-1 w-36"
                  data-testid="input-sp-export-to"
                />
              </div>
              <div className="min-w-40">
                <label className="text-xs text-muted-foreground">Location (optional)</label>
                <Select
                  value={exportLocationId}
                  onValueChange={setExportLocationId}
                  data-testid="select-sp-export-location"
                >
                  <SelectTrigger className="mt-1" data-testid="select-sp-export-location-trigger">
                    <SelectValue placeholder="All locations" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All locations</SelectItem>
                    {locations.map((l) => (
                      <SelectItem key={l.id} value={String(l.id)} data-testid={`option-location-${l.id}`}>
                        {l.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="min-w-48">
                <label className="text-xs text-muted-foreground">Opening Cash Account</label>
                <Select
                  value={exportCashAccountId}
                  onValueChange={setExportCashAccountId}
                  data-testid="select-sp-export-cash-account"
                >
                  <SelectTrigger className="mt-1" data-testid="select-sp-export-cash-account-trigger">
                    <SelectValue placeholder="GC Sales Cash" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No account (manual entry)</SelectItem>
                    {accounts.map((a) => (
                      <SelectItem key={a.id} value={String(a.id)} data-testid={`option-cash-account-${a.id}`}>
                        {a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="flex flex-wrap gap-3 pt-1">
              <ExportButton
                kind="excel"
                label="Export Excel (Template Form)"
                busy={exporting}
                onClick={handleExportSalesForm}
                disabled={exporting || exportingV2 || !exportFrom || !exportTo}
                variant="outline"
                data-testid="button-sp-export-sales-form"
              />
              <ExportButton
                kind="excel"
                label="Export Excel (System Sales Form)"
                busy={exportingV2}
                onClick={handleExportSalesFormV2}
                disabled={exporting || exportingV2 || !exportFrom || !exportTo}
                variant="default"
                data-testid="button-sp-export-sales-form-v2"
              />
            </div>

            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">Export Excel (Template Form)</span> — fills the original
                supplier template with your data (18-day max, formula-based).
              </p>
              <p className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">Export Excel (System Sales Form)</span> — clean
                from-scratch workbook built from your live system data. Opening &amp; closing stock match the Location
                Inventory page. Supports any date range. Three sheets: ENTRY (visible) plus Costing and Sales (hidden).
                Items with no opening, closing, or sales activity are omitted. Opening cash defaults to GC Sales Cash
                when that account exists for the selected company.
              </p>
            </div>
          </CardContent>
        </Card>
      </TabsContent>
    </Tabs>
  );
}
