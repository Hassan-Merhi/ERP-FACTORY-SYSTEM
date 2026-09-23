import { OfflinePrepPanel } from "@/components/OfflinePrepPanel";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ArrowRight, CheckCircle, Images, Loader2, MessageCircle, Save, ToggleRight, WifiOff } from "lucide-react";
import type { FactorySettingsData } from "./types";
import { FactorySettingsAdminTools } from "./FactorySettingsAdminTools";
import { MigrateVoucherDescriptionsCard } from "./components/MigrateVoucherDescriptionsCard";
import { RecalculateBaleCostsCard } from "./components/RecalculateBaleCostsCard";
import type { useFactorySettingsModel } from "./useFactorySettingsModel";

type Props = {
  model: ReturnType<typeof useFactorySettingsModel>;
};

export function FactorySettingsView({ model }: Props) {
  const {
    settings,
    isLoading,
    mutation,
    handleToggle,
    handleNumberChange,
    handleSave,
    handleEnableAll,
    prodWaGroupId,
    setProdWaGroupId,
    prodWaSearch,
    setProdWaSearch,
    prodWaPickerOpen,
    setProdWaPickerOpen,
    waChats,
    waChatsLoading,
    filteredWaChats,
    saveProdWaGroupMutation,
    weeklyWaGroupId,
    setWeeklyWaGroupId,
    weeklyWaSearch,
    setWeeklyWaSearch,
    weeklyWaPickerOpen,
    setWeeklyWaPickerOpen,
    weeklyWaChats,
    weeklyWaChatsLoading,
    filteredWeeklyWaChats,
    saveWeeklyWaGroupMutation,
    attendanceWaGroupId,
    setAttendanceWaGroupId,
    attendanceWaSearch,
    setAttendanceWaSearch,
    attendanceWaPickerOpen,
    setAttendanceWaPickerOpen,
    attendanceWaChats,
    attendanceWaChatsLoading,
    filteredAttendanceWaChats,
    saveAttendanceWaGroupMutation,
  } = model;

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

        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle data-testid="text-section-cost">Cost Configuration</CardTitle>
            <CardDescription>Default cost parameters for profitability calculations</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-6 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="laborCostPerKg">Labor Cost per KG</Label>
                <Input
                  id="laborCostPerKg"
                  type="number"
                  step="0.01"
                  min="0"
                  value={settings.laborCostPerKg}
                  onChange={(event) => handleNumberChange("laborCostPerKg", event.target.value)}
                  data-testid="input-laborCostPerKg"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="overheadPerKg">Overhead per KG</Label>
                <Input
                  id="overheadPerKg"
                  type="number"
                  step="0.01"
                  min="0"
                  value={settings.overheadPerKg}
                  onChange={(event) => handleNumberChange("overheadPerKg", event.target.value)}
                  data-testid="input-overheadPerKg"
                />
              </div>
            </div>
          </CardContent>
        </Card>
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

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MessageCircle className="h-5 w-5 text-muted-foreground" />
            Production WhatsApp Group
          </CardTitle>
          <CardDescription>
            Select the WhatsApp group that receives the Worker Matrix PDF when production is ended. This group is also
            used for manual sends from Stock Entry History.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {prodWaGroupId && !prodWaPickerOpen && (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-medium" data-testid="text-prod-wa-group">
                {waChats.find((chat) => chat.id === prodWaGroupId)?.name ?? prodWaGroupId}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setProdWaPickerOpen(true)}
                data-testid="button-change-prod-wa-group"
              >
                Change
              </Button>
            </div>
          )}
          {!prodWaGroupId && !prodWaPickerOpen && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setProdWaPickerOpen(true)}
              data-testid="button-select-prod-wa-group"
            >
              <MessageCircle className="h-4 w-4 mr-2" />
              Select WhatsApp Group
            </Button>
          )}
          {prodWaPickerOpen && (
            <div className="space-y-2">
              <Input
                placeholder="Search chats…"
                value={prodWaSearch}
                onChange={(event) => setProdWaSearch(event.target.value)}
                data-testid="input-prod-wa-search"
              />
              <div className="border rounded-md max-h-48 overflow-y-auto text-sm">
                {waChatsLoading && (
                  <p className="text-muted-foreground text-center py-4">
                    <Loader2 className="h-4 w-4 inline mr-1 animate-spin" />
                    Loading chats…
                  </p>
                )}
                {!waChatsLoading && filteredWaChats.length === 0 && (
                  <p className="text-muted-foreground text-center py-4">No chats found</p>
                )}
                {filteredWaChats.map((chat) => (
                  <button
                    key={chat.id}
                    type="button"
                    onClick={() => setProdWaGroupId(chat.id)}
                    className={`w-full text-left px-3 py-2 hover-elevate transition-colors ${
                      prodWaGroupId === chat.id ? "bg-primary/10 text-primary font-medium" : ""
                    }`}
                    data-testid={`option-prod-wa-chat-${chat.id}`}
                  >
                    <div className="font-medium">{chat.name}</div>
                    <div className="text-xs text-muted-foreground">{chat.type}</div>
                  </button>
                ))}
              </div>
              {prodWaGroupId && (
                <p className="text-xs text-muted-foreground">
                  Selected:{" "}
                  <span className="font-medium">
                    {waChats.find((chat) => chat.id === prodWaGroupId)?.name ?? prodWaGroupId}
                  </span>
                </p>
              )}
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={() => saveProdWaGroupMutation.mutate(prodWaGroupId)}
                  disabled={!prodWaGroupId || saveProdWaGroupMutation.isPending}
                  data-testid="button-save-prod-wa-group"
                >
                  {saveProdWaGroupMutation.isPending ? (
                    <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                  ) : (
                    <CheckCircle className="h-3 w-3 mr-1" />
                  )}
                  Save
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setProdWaPickerOpen(false);
                    setProdWaSearch("");
                  }}
                  data-testid="button-cancel-prod-wa-group"
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MessageCircle className="h-5 w-5 text-muted-foreground" />
            Attendance WhatsApp Group
          </CardTitle>
          <CardDescription>
            Select the WhatsApp group used by the Attendance page when you press "Send WhatsApp Image".
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {attendanceWaGroupId && !attendanceWaPickerOpen && (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-medium" data-testid="text-attendance-wa-group">
                {attendanceWaChats.find((chat) => chat.id === attendanceWaGroupId)?.name ?? attendanceWaGroupId}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setAttendanceWaPickerOpen(true)}
                data-testid="button-change-attendance-wa-group"
              >
                Change
              </Button>
            </div>
          )}
          {!attendanceWaGroupId && !attendanceWaPickerOpen && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setAttendanceWaPickerOpen(true)}
              data-testid="button-select-attendance-wa-group"
            >
              <MessageCircle className="h-4 w-4 mr-2" />
              Select WhatsApp Group
            </Button>
          )}
          {attendanceWaPickerOpen && (
            <div className="space-y-2">
              <Input
                placeholder="Search WhatsApp groups…"
                value={attendanceWaSearch}
                onChange={(event) => setAttendanceWaSearch(event.target.value)}
                data-testid="input-attendance-wa-search"
              />
              <div className="border rounded-md max-h-48 overflow-y-auto text-sm">
                {attendanceWaChatsLoading && (
                  <p className="text-muted-foreground text-center py-4">
                    <Loader2 className="h-4 w-4 inline mr-1 animate-spin" />
                    Loading WhatsApp groups…
                  </p>
                )}
                {!attendanceWaChatsLoading && filteredAttendanceWaChats.length === 0 && (
                  <p className="text-muted-foreground text-center py-4">No WhatsApp groups found</p>
                )}
                {filteredAttendanceWaChats.map((chat) => (
                  <button
                    key={chat.id}
                    type="button"
                    onClick={() => setAttendanceWaGroupId(chat.id)}
                    className={`w-full text-left px-3 py-2 hover-elevate transition-colors ${
                      attendanceWaGroupId === chat.id ? "bg-primary/10 text-primary font-medium" : ""
                    }`}
                    data-testid={`option-attendance-wa-chat-${chat.id}`}
                  >
                    <div className="font-medium">{chat.name || chat.id}</div>
                    <div className="text-xs text-muted-foreground">{chat.id}</div>
                  </button>
                ))}
              </div>
              {attendanceWaGroupId && (
                <p className="text-xs text-muted-foreground">
                  Selected:{" "}
                  <span className="font-medium">
                    {attendanceWaChats.find((chat) => chat.id === attendanceWaGroupId)?.name ?? attendanceWaGroupId}
                  </span>
                </p>
              )}
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={() => saveAttendanceWaGroupMutation.mutate(attendanceWaGroupId)}
                  disabled={!attendanceWaGroupId || saveAttendanceWaGroupMutation.isPending}
                  data-testid="button-save-attendance-wa-group"
                >
                  {saveAttendanceWaGroupMutation.isPending ? (
                    <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                  ) : (
                    <CheckCircle className="h-3 w-3 mr-1" />
                  )}
                  Save
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setAttendanceWaPickerOpen(false);
                    setAttendanceWaSearch("");
                  }}
                  data-testid="button-cancel-attendance-wa-group"
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MessageCircle className="h-5 w-5 text-muted-foreground" />
            Weekly Report WhatsApp Group
          </CardTitle>
          <CardDescription>
            Select the WhatsApp group that receives the Weekly Production Report Excel file when you press "Send" on the
            report panel.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {weeklyWaGroupId && !weeklyWaPickerOpen && (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-medium" data-testid="text-weekly-wa-group">
                {weeklyWaChats.find((chat) => chat.id === weeklyWaGroupId)?.name ?? weeklyWaGroupId}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setWeeklyWaPickerOpen(true)}
                data-testid="button-change-weekly-wa-group"
              >
                Change
              </Button>
            </div>
          )}
          {!weeklyWaGroupId && !weeklyWaPickerOpen && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setWeeklyWaPickerOpen(true)}
              data-testid="button-select-weekly-wa-group"
            >
              <MessageCircle className="h-4 w-4 mr-2" />
              Select WhatsApp Group
            </Button>
          )}
          {weeklyWaPickerOpen && (
            <div className="space-y-2">
              <Input
                placeholder="Search chats…"
                value={weeklyWaSearch}
                onChange={(event) => setWeeklyWaSearch(event.target.value)}
                data-testid="input-weekly-wa-search"
              />
              <div className="border rounded-md max-h-48 overflow-y-auto text-sm">
                {weeklyWaChatsLoading && (
                  <p className="text-muted-foreground text-center py-4">
                    <Loader2 className="h-4 w-4 inline mr-1 animate-spin" />
                    Loading chats…
                  </p>
                )}
                {!weeklyWaChatsLoading && filteredWeeklyWaChats.length === 0 && (
                  <p className="text-muted-foreground text-center py-4">No chats found</p>
                )}
                {filteredWeeklyWaChats.map((chat) => (
                  <button
                    key={chat.id}
                    type="button"
                    onClick={() => setWeeklyWaGroupId(chat.id)}
                    className={`w-full text-left px-3 py-2 hover-elevate transition-colors ${
                      weeklyWaGroupId === chat.id ? "bg-primary/10 text-primary font-medium" : ""
                    }`}
                    data-testid={`option-weekly-wa-chat-${chat.id}`}
                  >
                    <div className="font-medium">{chat.name}</div>
                    <div className="text-xs text-muted-foreground">{chat.type}</div>
                  </button>
                ))}
              </div>
              {weeklyWaGroupId && (
                <p className="text-xs text-muted-foreground">
                  Selected:{" "}
                  <span className="font-medium">
                    {weeklyWaChats.find((chat) => chat.id === weeklyWaGroupId)?.name ?? weeklyWaGroupId}
                  </span>
                </p>
              )}
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={() => saveWeeklyWaGroupMutation.mutate(weeklyWaGroupId)}
                  disabled={!weeklyWaGroupId || saveWeeklyWaGroupMutation.isPending}
                  data-testid="button-save-weekly-wa-group"
                >
                  {saveWeeklyWaGroupMutation.isPending ? (
                    <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                  ) : (
                    <CheckCircle className="h-3 w-3 mr-1" />
                  )}
                  Save
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setWeeklyWaPickerOpen(false);
                    setWeeklyWaSearch("");
                  }}
                  data-testid="button-cancel-weekly-wa-group"
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <WifiOff className="h-5 w-5 text-muted-foreground" />
            Offline Mode
          </CardTitle>
          <CardDescription>
            Download all factory data to this device so it works without internet. Mutations made while offline are
            queued and auto-synced when the connection returns.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <OfflinePrepPanel />
        </CardContent>
      </Card>

      <RecalculateBaleCostsCard />
      <MigrateVoucherDescriptionsCard />
    </div>
  );
}
