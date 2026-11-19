// Extracted from ./SpReportsTabsSection.tsx
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { TabsContent } from "@/components/ui/tabs";
import { Loader2 } from "lucide-react";
import { QuickMonthlyClose } from "./golden-coast/QuickMonthlyClose";
import { fmt, useSpReportsState } from "./useSpReportsState";
import { PeriodFilter } from "@/components/ui/period-filter";

export function SpReportsTabsSectionTabsContent({
  completeMonth,
  developerCorrection,
  endDate,
  isDeveloper,
  profit,
  profitLoading,
  recordChanges,
  selectedCompany,
  setCorrectedProfit,
  setCorrectionConfirmation,
  setCorrectionReason,
  setEditProfitOpen,
  setEndDate,
  setStartDate,
  splits,
  splitsLoading,
  startDate,
}: Pick<
  Pick<
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
  >,
  | "completeMonth"
  | "developerCorrection"
  | "endDate"
  | "isDeveloper"
  | "profit"
  | "profitLoading"
  | "recordChanges"
  | "selectedCompany"
  | "setCorrectedProfit"
  | "setCorrectionConfirmation"
  | "setCorrectionReason"
  | "setEditProfitOpen"
  | "setEndDate"
  | "setStartDate"
  | "splits"
  | "splitsLoading"
  | "startDate"
>) {
  return (
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
  );
}
