import { UnifiedAccountPicker } from "@/components/accounts/UnifiedAccountPicker";
// Extracted from ./SpReports.tsx to keep that module under the source-size cap.
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { BarChart3, FileSpreadsheet } from "lucide-react";
import { ExportButton } from "@/components/export/ReportExportMenu";
import { useSpReportsState, type ReportTab } from "./useSpReportsState";
import { SpReportsTabsSectionTabsContent } from "./SpReportsTabsSectionTabsContent";

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

      <SpReportsTabsSectionTabsContent
        completeMonth={completeMonth}
        developerCorrection={developerCorrection}
        endDate={endDate}
        isDeveloper={isDeveloper}
        profit={profit}
        profitLoading={profitLoading}
        recordChanges={recordChanges}
        selectedCompany={selectedCompany}
        setCorrectedProfit={setCorrectedProfit}
        setCorrectionConfirmation={setCorrectionConfirmation}
        setCorrectionReason={setCorrectionReason}
        setEditProfitOpen={setEditProfitOpen}
        setEndDate={setEndDate}
        setStartDate={setStartDate}
        splits={splits}
        splitsLoading={splitsLoading}
        startDate={startDate}
      />

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
                <UnifiedAccountPicker
                  options={[
                    { value: "none", name: "No account (manual entry)" },
                    ...accounts.map((a) => ({ value: String(a.id), name: a.name })),
                  ]}
                  value={exportCashAccountId}
                  onChange={setExportCashAccountId}
                  placeholder={"GC Sales Cash"}
                  testId={"select-sp-export-cash-account"}
                />
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
