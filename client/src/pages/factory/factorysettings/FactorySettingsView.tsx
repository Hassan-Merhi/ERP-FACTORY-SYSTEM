import { OfflinePrepPanel } from "@/components/OfflinePrepPanel";
import { OfflineModePanel } from "@/components/OfflineModePanel";
import { OFFLINE_MODE_ENABLED } from "@/lib/featureFlags";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ArrowRight, Images, Loader2, Save, ToggleRight, WifiOff } from "lucide-react";
import type { FactorySettingsData } from "./types";
import { FactorySettingsAdminTools } from "./FactorySettingsAdminTools";
import { AutomaticPriorityPrintingCard } from "./AutomaticPriorityPrintingCard";
import { RecalculateBaleCostsCard } from "./components/RecalculateBaleCostsCard";
import { DeveloperChristmasModePanel } from "@/pages/settings/DeveloperChristmasModePanel";
import {
  FactorySettingsViewCardSection,
  FactorySettingsViewCardSection2,
  useFactorySettingsViewState,
  type Props,
} from "./FactorySettingsViewCardSection2";
import { FactorySettingsViewCardSection3, FactorySettingsViewCardSection4 } from "./FactorySettingsViewCardSection3";

export function FactorySettingsView(props: Props) {
  const {
    attendanceWaChats,
    attendanceWaChatsLoading,
    attendanceWaGroupId,
    attendanceWaPickerOpen,
    attendanceWaSearch,
    filteredAttendanceWaChats,
    filteredWaChats,
    filteredWeeklyWaChats,
    handleEnableAll,
    handleNumberChange,
    handleSave,
    handleToggle,
    isLoading,
    model,
    mutation,
    prodWaGroupId,
    prodWaPickerOpen,
    prodWaSearch,
    saveAttendanceWaGroupMutation,
    saveProdWaGroupMutation,
    saveWeeklyWaGroupMutation,
    setAttendanceWaGroupId,
    setAttendanceWaPickerOpen,
    setAttendanceWaSearch,
    setProdWaGroupId,
    setProdWaPickerOpen,
    setProdWaSearch,
    setWeeklyWaGroupId,
    setWeeklyWaPickerOpen,
    setWeeklyWaSearch,
    settings,
    waChats,
    waChatsLoading,
    weeklyWaChats,
    weeklyWaChatsLoading,
    weeklyWaGroupId,
    weeklyWaPickerOpen,
    weeklyWaSearch,
  } = useFactorySettingsViewState(props);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12" data-testid="loading-spinner">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        <span className="ml-2 text-muted-foreground">Loading factory settings...</span>
      </div>
    );
  }

  const toggleItem = (label: string, key: keyof FactorySettingsData) => (
    <div className="flex items-center justify-between gap-4 py-3" key={key} data-testid={`toggle-row-${key}`}>
      <Label htmlFor={key} className="text-sm font-medium cursor-pointer">
        {label}
      </Label>
      <Switch
        id={key}
        checked={!!settings[key]}
        onCheckedChange={() => handleToggle(key)}
        data-testid={`switch-${key}`}
      />
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <PageHeader title="Factory Settings" subtitle="Toggle factory intelligence features on or off" />
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={handleEnableAll}
            disabled={mutation.isPending}
            data-testid="button-enable-all"
          >
            <ToggleRight className="h-4 w-4 mr-2" />
            Enable All
          </Button>
          <Button onClick={handleSave} disabled={mutation.isPending} data-testid="button-save-settings">
            {mutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Save className="h-4 w-4 mr-2" />}
            Save Settings
          </Button>
        </div>
      </div>

      <DeveloperChristmasModePanel />

      <AutomaticPriorityPrintingCard />

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle data-testid="text-section-production">Production Intelligence</CardTitle>
            <CardDescription>Core production monitoring and analytics</CardDescription>
          </CardHeader>
          <CardContent className="divide-y">
            {toggleItem("Dashboard", "dashboardEnabled")}
            {toggleItem("KPIs", "kpisEnabled")}
            {toggleItem("Waste Tracking", "wasteTrackingEnabled")}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle data-testid="text-section-financial">Financial Intelligence</CardTitle>
            <CardDescription>Profitability and cash flow analysis</CardDescription>
          </CardHeader>
          <CardContent className="divide-y">
            {toggleItem("Profitability Engine", "profitabilityEnabled")}
            {toggleItem("Cash Flow", "cashflowEnabled")}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle data-testid="text-section-supply-chain">Supply Chain</CardTitle>
            <CardDescription>Supplier management, optimization, and traceability</CardDescription>
          </CardHeader>
          <CardContent className="divide-y">
            {toggleItem("Supplier Scoring", "supplierScoringEnabled")}
            {toggleItem("Mix Optimizer", "mixOptimizerEnabled")}
            {toggleItem("Traceability", "traceabilityEnabled")}
            {toggleItem("Bale Photos", "balePhotosEnabled")}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle data-testid="text-section-operations">Operations</CardTitle>
            <CardDescription>Alerts and access control</CardDescription>
          </CardHeader>
          <CardContent className="divide-y">
            {toggleItem("Alerts System", "alertsEnabled")}
            {toggleItem("Roles & Permissions", "rolesEnabled")}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle data-testid="text-section-reports">Reports</CardTitle>
            <CardDescription>Toggle report pages on or off for all users</CardDescription>
          </CardHeader>
          <CardContent className="divide-y">
            {toggleItem("Net Profit", "netProfitEnabled")}
            {toggleItem("Production Summary", "productionSummaryEnabled")}
            {toggleItem("Supplier Report", "supplierReportEnabled")}
            {toggleItem("Supplier Statement", "supplierStatementEnabled")}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle data-testid="text-section-pages">Page Visibility</CardTitle>
            <CardDescription>Show or hide entire pages for all users</CardDescription>
          </CardHeader>
          <CardContent className="divide-y">{toggleItem("Daybook", "daybookEnabled")}</CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle data-testid="text-section-tabs">Page Tabs</CardTitle>
            <CardDescription>Disable tabs you don't use — they will be hidden from all users</CardDescription>
          </CardHeader>
          <CardContent className="divide-y">
            <p className="text-xs text-muted-foreground pt-3 pb-1 font-medium uppercase tracking-wide">Workers Hub</p>
            {toggleItem("Payroll tab", "workersTabPayrollEnabled")}
            {toggleItem("Attendance tab", "workersTabAttendanceEnabled")}
            {toggleItem("Report tab", "workersTabReportEnabled")}
            {toggleItem("Advances tab", "workersTabAdvancesEnabled")}
            {toggleItem("Bonuses tab", "workersTabBonusesEnabled")}
            <p className="text-xs text-muted-foreground pt-3 pb-1 font-medium uppercase tracking-wide">Bales Hub</p>
            {toggleItem("Barcode Lookup tab", "balesTabBarcodeEnabled")}
            {toggleItem("Remove from Stock tab", "balesTabRemoveEnabled")}
            <p className="text-xs text-muted-foreground pt-3 pb-1 font-medium uppercase tracking-wide">Loadings Hub</p>
            {toggleItem("Pending Loadings tab", "loadingsTabPendingEnabled")}
            <p className="text-xs text-muted-foreground pt-3 pb-1 font-medium uppercase tracking-wide">Stock Entry</p>
            {toggleItem("Stock Entry tab", "stockEntryTabEntryEnabled")}
            {toggleItem("Stock Entry History tab", "stockEntryTabHistoryEnabled")}
            <p className="text-xs text-muted-foreground pt-3 pb-1 font-medium uppercase tracking-wide">Advances</p>
            {toggleItem("Repayments tab", "advancesTabRepaymentsEnabled")}
            <p className="text-xs text-muted-foreground pt-3 pb-1 font-medium uppercase tracking-wide">KPIs</p>
            {toggleItem("Worker Performance tab", "kpisTabWorkerPerformanceEnabled")}
            {toggleItem("Mix Efficiency tab", "kpisTabMixEfficiencyEnabled")}
            <p className="text-xs text-muted-foreground pt-3 pb-1 font-medium uppercase tracking-wide">Payroll</p>
            {toggleItem("Worker Master tab", "payrollTabWorkerMasterEnabled")}
            <p className="text-xs text-muted-foreground pt-3 pb-1 font-medium uppercase tracking-wide">Profitability</p>
            {toggleItem("Container Profitability tab", "profitabilityTabContainersEnabled")}
            <p className="text-xs text-muted-foreground pt-3 pb-1 font-medium uppercase tracking-wide">Workers List</p>
            {toggleItem("Categories tab", "workersTabCategoriesEnabled")}
            <p className="text-xs text-muted-foreground pt-3 pb-1 font-medium uppercase tracking-wide">
              Worker Profile
            </p>
            {toggleItem("Statement tab", "workerDetailTabStatementEnabled")}
            {toggleItem("Advances tab", "workerDetailTabAdvancesEnabled")}
            {toggleItem("Bales tab", "workerDetailTabBalesEnabled")}
            {toggleItem("Documents tab", "workerDetailTabDocumentsEnabled")}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle data-testid="text-section-display">Display Options</CardTitle>
            <CardDescription>Control what prices and values are visible to users</CardDescription>
          </CardHeader>
          <CardContent className="divide-y">
            {toggleItem("Hide Selling Price", "hideSellingPrice")}
            {toggleItem("Hide Avg Cost", "hideAvgCost")}
          </CardContent>
        </Card>

        <FactorySettingsViewCardSection handleNumberChange={handleNumberChange} settings={settings} />
      </div>

      <FactorySettingsAdminTools model={model} />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Images className="h-5 w-5 text-muted-foreground" />
            Label Banner Images
          </CardTitle>
          <CardDescription>
            Replace the colored HMD header banners printed on A4 bale labels. Upload your own image for each of the 5
            design colors (purple, green, gold, white, red).
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-0">
          <Button
            variant="outline"
            onClick={() => (window.location.href = "/factory/label-banners")}
            data-testid="button-open-label-banners"
          >
            <Images className="h-4 w-4 mr-2" />
            Manage Label Banners
            <ArrowRight className="h-4 w-4 ml-2" />
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Images className="h-5 w-5 text-muted-foreground" />
            Product Images
          </CardTitle>
          <CardDescription>
            Upload and manage product images for each article code. Images can be attached to any bale product and used
            for catalogues, labels, or reference.
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-0">
          <Button
            variant="outline"
            onClick={() => (window.location.href = "/factory/bale-product-images")}
            data-testid="button-open-product-images"
          >
            <Images className="h-4 w-4 mr-2" />
            Manage Product Images
            <ArrowRight className="h-4 w-4 ml-2" />
          </Button>
        </CardContent>
      </Card>

      <FactorySettingsViewCardSection4
        filteredWaChats={filteredWaChats}
        prodWaGroupId={prodWaGroupId}
        prodWaPickerOpen={prodWaPickerOpen}
        prodWaSearch={prodWaSearch}
        saveProdWaGroupMutation={saveProdWaGroupMutation}
        setProdWaGroupId={setProdWaGroupId}
        setProdWaPickerOpen={setProdWaPickerOpen}
        setProdWaSearch={setProdWaSearch}
        waChats={waChats}
        waChatsLoading={waChatsLoading}
      />

      <FactorySettingsViewCardSection2
        attendanceWaChats={attendanceWaChats}
        attendanceWaChatsLoading={attendanceWaChatsLoading}
        attendanceWaGroupId={attendanceWaGroupId}
        attendanceWaPickerOpen={attendanceWaPickerOpen}
        attendanceWaSearch={attendanceWaSearch}
        filteredAttendanceWaChats={filteredAttendanceWaChats}
        saveAttendanceWaGroupMutation={saveAttendanceWaGroupMutation}
        setAttendanceWaGroupId={setAttendanceWaGroupId}
        setAttendanceWaPickerOpen={setAttendanceWaPickerOpen}
        setAttendanceWaSearch={setAttendanceWaSearch}
      />

      <FactorySettingsViewCardSection3
        filteredWeeklyWaChats={filteredWeeklyWaChats}
        saveWeeklyWaGroupMutation={saveWeeklyWaGroupMutation}
        setWeeklyWaGroupId={setWeeklyWaGroupId}
        setWeeklyWaPickerOpen={setWeeklyWaPickerOpen}
        setWeeklyWaSearch={setWeeklyWaSearch}
        weeklyWaChats={weeklyWaChats}
        weeklyWaChatsLoading={weeklyWaChatsLoading}
        weeklyWaGroupId={weeklyWaGroupId}
        weeklyWaPickerOpen={weeklyWaPickerOpen}
        weeklyWaSearch={weeklyWaSearch}
      />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <WifiOff className="h-5 w-5 text-muted-foreground" />
            Offline Mode
          </CardTitle>
          <CardDescription>
            Prepare supported factory data for offline reads on this device. Only approved operations are available
            through a certified factory LAN server; returning to the cloud requires a supervised handover.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <OfflinePrepPanel />
          {OFFLINE_MODE_ENABLED && <OfflineModePanel />}
        </CardContent>
      </Card>

      <RecalculateBaleCostsCard />
    </div>
  );
}
