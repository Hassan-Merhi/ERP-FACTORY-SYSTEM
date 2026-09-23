import {
  AlertTriangle,
  BarChart2,
  CheckCircle,
  CircleDollarSign,
  Container,
  Download,
  FileSpreadsheet,
  FileText,
  Hash,
  Loader2,
  MapPin,
  Plus,
  Save,
  ShoppingCart,
  TrendingUp,
  Truck,
  X,
} from "lucide-react";
import { PeriodFilter } from "@/components/ui/period-filter";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageHeader } from "@/components/PageHeader";
import { StatCard } from "./components/StatCard";
import { fmt } from "./utils";
import type { ProfitSourceType, SellPriceSource, useSupplierProfitCheckModel } from "./useSupplierProfitCheckModel";

type ProfitModel = ReturnType<typeof useSupplierProfitCheckModel>;

export function SupplierProfitCheckSetup({ model }: { model: ProfitModel }) {
  return (
    <>
      <PageHeader
        title="Supplier Profit Check"
        subtitle="Analyze item profitability before ordering"
        icon={<BarChart2 className="h-5 w-5 text-amber-500" />}
        meta={
          model.autosaveStatus !== "idle" && (
            <span
              className={`flex items-center gap-1.5 text-xs shrink-0 ${model.autosaveStatus === "saving" ? "text-muted-foreground" : model.autosaveStatus === "saved" ? "text-emerald-500" : "text-destructive"}`}
            >
              {model.autosaveStatus === "saving" && <Loader2 className="w-3 h-3 animate-spin" />}
              {model.autosaveStatus === "saved" && <CheckCircle className="w-3 h-3" />}
              {model.autosaveStatus === "saving"
                ? "Saving…"
                : model.autosaveStatus === "saved"
                  ? "Saved"
                  : "Save failed"}
            </span>
          )
        }
      >
        {model.supplierId && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => model.setShowAddItemDialog(true)}
            className="shrink-0"
            data-testid="button-add-item"
          >
            <Plus className="w-4 h-4 mr-1.5" /> Add Item
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={() => model.importFileRef.current?.click()}
          className="shrink-0"
          data-testid="button-import-excel"
          title="Import item codes from Excel to check profit"
        >
          <FileSpreadsheet className="w-4 h-4 mr-1.5" /> Import Excel
        </Button>
        {model.importedRows.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => model.setImportedRows([])}
            className="shrink-0 text-muted-foreground"
            data-testid="button-clear-import"
            title="Clear imported items"
          >
            <X className="w-4 h-4 mr-1.5" /> Clear Import ({model.importedRows.length})
          </Button>
        )}
        {model.loaded && !model.savedProforma && !(model.sourceType === "proforma" && model.proformaId) && (
          <Button
            onClick={() => {
              if (model.itemsWithQty.length === 0) {
                model.toast({ title: "Enter qty for at least one item", variant: "destructive" });
                return;
              }
              model.setShowConfirmModal(true);
            }}
            disabled={model.itemsWithQty.length === 0}
            className="bg-amber-500 text-white shrink-0"
            data-testid="button-create-proforma"
          >
            <Save className="w-4 h-4 mr-2" /> Create Proforma ({model.itemsWithQty.length})
          </Button>
        )}
        {model.loaded && model.savedProforma && (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={model.handleExportSupplier}
              data-testid="button-export-supplier-bar"
            >
              <Download className="w-4 h-4 mr-1.5" /> Supplier Excel
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={model.handleExportInternal}
              data-testid="button-export-internal-bar"
            >
              <FileText className="w-4 h-4 mr-1.5" /> Analysis Excel
            </Button>
          </>
        )}
      </PageHeader>
      <input
        ref={model.importFileRef}
        type="file"
        accept=".xlsx,.xls,.csv"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) {
            model.handleExcelFile(file);
            event.target.value = "";
          }
        }}
      />

      <div className="rounded-xl border bg-card overflow-hidden">
        <div className="px-5 py-4 space-y-4">
          <div className="flex flex-wrap gap-4 items-end">
            <div className="space-y-1.5 min-w-[180px] flex-1">
              <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                Supplier
              </label>
              <Select
                value={model.supplierId}
                onValueChange={(value) => {
                  model.setSupplierId(value);
                  model.setOtwContainerIds([]);
                }}
              >
                <SelectTrigger data-testid="select-supplier">
                  <SelectValue placeholder="Select supplier…" />
                </SelectTrigger>
                <SelectContent>
                  {model.suppliers.map((supplier) => (
                    <SelectItem key={supplier.id} value={String(supplier.id)}>
                      {supplier.legalName || supplier.legal_name || supplier.code}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5 shrink-0">
              <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                Sales Date Range
              </label>
              <PeriodFilter
                value={model.periodFilter}
                onChange={model.setPeriodFilter}
                hideCustomInputs
                data-testid="period-filter-sales"
              />
            </div>

            <div className="space-y-1.5 min-w-[160px] shrink-0">
              <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                Item Source
              </label>
              <Select
                value={model.sourceType}
                onValueChange={(value) => {
                  model.setSourceType(value as ProfitSourceType);
                  model.setProformaId("");
                  model.setOtwContainerIds([]);
                }}
              >
                <SelectTrigger data-testid="select-source-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Supplier Items</SelectItem>
                  <SelectItem value="proforma">Existing Proforma</SelectItem>
                  <SelectItem value="otw_containers">Containers OTW</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {model.sourceType === "proforma" && (
              <div className="space-y-1.5 min-w-[160px] shrink-0">
                <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                  Select Proforma
                </label>
                <Select value={model.proformaId} onValueChange={model.setProformaId}>
                  <SelectTrigger data-testid="select-proforma">
                    <SelectValue placeholder="Select proforma…" />
                  </SelectTrigger>
                  <SelectContent>
                    {model.proformas.map((proforma) => (
                      <SelectItem key={proforma.id} value={String(proforma.id)}>
                        {proforma.reference}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="space-y-1.5 min-w-[180px] shrink-0">
              <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1">
                <MapPin className="w-3 h-3" /> Sell Price Source
              </label>
              <Select
                value={model.sellPriceSource}
                onValueChange={(value) => {
                  model.setSellPriceSource(value as SellPriceSource);
                  if (value === "location_group" && model.locationGroups.length > 0)
                    model.setSelectedLocationId(String(model.locationGroups[0].id));
                  else model.setSelectedLocationId("");
                }}
              >
                <SelectTrigger data-testid="select-sell-price-source">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="avg">Average Sell Price</SelectItem>
                  <SelectItem value="location_group">Location Group Price</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {model.sellPriceSource === "location_group" && (
              <div className="space-y-1.5 min-w-[180px] shrink-0">
                <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                  Location Group
                </label>
                {model.locationGroups.length === 0 ? (
                  <div className="h-9 flex items-center px-3 rounded-md border text-xs text-muted-foreground">
                    No groups configured
                  </div>
                ) : (
                  <Select value={model.selectedLocationId} onValueChange={model.setSelectedLocationId}>
                    <SelectTrigger data-testid="select-location-group">
                      <SelectValue placeholder="Select group…" />
                    </SelectTrigger>
                    <SelectContent>
                      {model.locationGroups.map((group) => (
                        <SelectItem key={group.id} value={String(group.id)}>
                          {group.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            )}
          </div>

          {model.sourceType === "otw_containers" && <OtwContainerPicker model={model} />}
        </div>
      </div>

      {model.loaded && <LandingCharges model={model} />}
      {model.loaded && <ProfitSummary model={model} />}
      {model.savedProforma && <SavedProformaBanner model={model} />}
    </>
  );
}

function OtwContainerPicker({ model }: { model: ProfitModel }) {
  return (
    <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <Container className="w-3.5 h-3.5 text-blue-500" />
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">OTW Containers</span>
        {model.otwContainerIds.length > 0 && (
          <Badge className="bg-blue-500 text-white text-[10px] px-1.5 py-0 h-4">
            {model.otwContainerIds.length} selected
          </Badge>
        )}
        {model.otwContainerIds.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-xs px-2 ml-auto"
            onClick={() => model.setOtwContainerIds([])}
          >
            Clear
          </Button>
        )}
      </div>
      {!model.supplierId ? (
        <p className="text-xs text-muted-foreground italic">Select a supplier first to see OTW containers.</p>
      ) : model.isLoadingOtw ? (
        <div className="flex items-center gap-2 py-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />
          <span className="text-xs text-muted-foreground">Loading containers…</span>
        </div>
      ) : model.otwContainers.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">No OTW containers found for this supplier.</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {model.otwContainers.map((container) => {
            const selected = model.otwContainerIds.includes(container.id);
            const itemCount = Number(container.loaded_items_count) || 0;
            return (
              <label
                key={container.id}
                className={`flex items-center gap-2 rounded-md border px-3 py-2 cursor-pointer text-xs hover-elevate transition-colors ${selected ? "border-blue-500/60 bg-blue-500/10" : "bg-background"}`}
                data-testid={`container-checkbox-${container.id}`}
              >
                <Checkbox
                  checked={selected}
                  onCheckedChange={(checked) =>
                    model.setOtwContainerIds((previous) =>
                      checked ? [...previous, container.id] : previous.filter((id) => id !== container.id)
                    )
                  }
                />
                <div>
                  <div className="font-mono font-semibold">{container.container_number}</div>
                  <div className="text-muted-foreground text-[10px]">
                    {itemCount > 0 ? `${itemCount} items` : "No items loaded"}
                    {container.eta ? ` · ETA ${container.eta}` : ""}
                  </div>
                </div>
              </label>
            );
          })}
        </div>
      )}
      {model.otwContainerIds.length === 0 && model.otwContainers.length > 0 && (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          <AlertTriangle className="w-3 h-3 inline mr-1" />
          Select at least one container to load items.
        </p>
      )}
    </div>
  );
}

function LandingCharges({ model }: { model: ProfitModel }) {
  const inputs = [
    { label: "Freight", value: model.freight, set: model.setFreight, id: "input-freight" },
    { label: "Duties", value: model.duties, set: model.setDuties, id: "input-duties" },
    { label: "Transportation", value: model.otherCharges, set: model.setOtherCharges, id: "input-other-charges" },
    { label: "Surcharge", value: model.surcharge, set: model.setSurcharge, id: "input-surcharge" },
  ];
  return (
    <div className="rounded-xl border bg-muted/40 p-4">
      <div className="flex flex-wrap items-center gap-5">
        <div className="flex items-center gap-2 shrink-0">
          <div className="p-1.5 rounded-lg bg-amber-500/15">
            <Truck className="w-3.5 h-3.5 text-amber-500" />
          </div>
          <span className="text-xs font-bold text-muted-foreground uppercase tracking-widest">Landing Charges</span>
        </div>
        <div className="flex flex-wrap gap-3 flex-1">
          {inputs.map((input) => (
            <div key={input.id} className="space-y-1 w-32">
              <label className="text-[11px] text-muted-foreground font-medium">{input.label}</label>
              <div className="relative">
                <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground text-xs font-medium">
                  $
                </span>
                <Input
                  type="number"
                  min="0"
                  placeholder="0"
                  value={input.value}
                  onChange={(event) => input.set(event.target.value)}
                  className="h-8 pl-6 text-right font-mono"
                  data-testid={input.id}
                />
              </div>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {[
            { label: "Total Extra", value: `$${fmt(model.totalExtraCharges)}`, highlight: false },
            { label: "Total Bales", value: model.totalBales.toLocaleString(), highlight: false },
            { label: "Extra / Bale", value: `$${fmt(model.extraCostPerBale)}`, highlight: true },
          ].map((metric) => (
            <div
              key={metric.label}
              className={`rounded-lg px-3 py-1.5 text-center ${metric.highlight ? "bg-amber-500/15 border border-amber-500/30" : "bg-background border"}`}
            >
              <div className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">
                {metric.label}
              </div>
              <div className={`text-sm font-bold tabular-nums ${metric.highlight ? "text-amber-500" : ""}`}>
                {metric.value}
              </div>
            </div>
          ))}
          {model.totalBales === 0 && (
            <Badge className="bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30 gap-1">
              <AlertTriangle className="w-3 h-3" /> Enter qty to see Extra/Bale
            </Badge>
          )}
        </div>
      </div>
    </div>
  );
}

function ProfitSummary({ model }: { model: ProfitModel }) {
  const summary = model.summary;
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
      <StatCard
        icon={Hash}
        iconBg="bg-blue-500/10 text-blue-500"
        label="Items"
        value={String(summary.selectedCount)}
        sub={`of ${summary.totalItems}`}
      />
      <StatCard
        icon={ShoppingCart}
        iconBg="bg-indigo-500/10 text-indigo-500"
        label="Total Qty"
        value={summary.totalQty.toLocaleString()}
      />
      <StatCard
        icon={CircleDollarSign}
        iconBg="bg-amber-500/10 text-amber-500"
        label="Total Landing Cost"
        value={`$${fmt(summary.totalLandingCost)}`}
      />
      <StatCard
        icon={TrendingUp}
        iconBg={summary.totalCostProfit >= 0 ? "bg-emerald-500/10 text-emerald-500" : "bg-red-500/10 text-red-500"}
        label="Cost Profit"
        value={`${summary.totalCostProfit < 0 ? "-" : ""}$${fmt(Math.abs(summary.totalCostProfit))}`}
        sub={summary.costProfitPct != null ? `${fmt(Math.abs(summary.costProfitPct), 1)}%` : undefined}
        valueColor={summary.totalCostProfit >= 0 ? "text-emerald-500" : "text-red-500"}
      />
      <div className="rounded-xl border bg-card px-4 py-3">
        <div className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide mb-1.5">Issues</div>
        <div className="space-y-1">
          {summary.losingCount > 0 && <Issue dot="bg-red-500" count={summary.losingCount} label="cost losing" />}
          {summary.noDataCount > 0 && <Issue dot="bg-amber-500" count={summary.noDataCount} label="no data" />}
          {summary.missingPoCount > 0 && (
            <Issue dot="bg-orange-500" count={summary.missingPoCount} label="no PO price" />
          )}
          {summary.noGroupPriceCount > 0 && (
            <Issue dot="bg-amber-400" count={summary.noGroupPriceCount} label="no group price" />
          )}
          {summary.losingCount === 0 &&
            summary.noDataCount === 0 &&
            summary.missingPoCount === 0 &&
            summary.noGroupPriceCount === 0 && (
              <div className="flex items-center gap-1.5">
                <CheckCircle className="w-3.5 h-3.5 text-emerald-500" />
                <span className="text-xs text-emerald-500 font-medium">All good</span>
              </div>
            )}
        </div>
      </div>
    </div>
  );
}

function Issue({ dot, count, label }: { dot: string; count: number; label: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={`w-1.5 h-1.5 rounded-full ${dot} shrink-0`} />
      <span className="text-xs">
        <span className="font-bold">{count}</span> <span className="text-muted-foreground">{label}</span>
      </span>
    </div>
  );
}

function SavedProformaBanner({ model }: { model: ProfitModel }) {
  if (!model.savedProforma) return null;
  return (
    <div className="flex flex-wrap items-center gap-3 justify-between rounded-xl border border-emerald-500/30 bg-emerald-500/5 px-4 py-2.5">
      <div className="flex items-center gap-2">
        <CheckCircle className="w-4 h-4 text-emerald-500 shrink-0" />
        <span className="text-sm font-medium">Proforma saved:</span>
        <span className="font-mono text-sm text-emerald-600 dark:text-emerald-400">
          {model.savedProforma.reference}
        </span>
      </div>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={model.handleExportSupplier} data-testid="button-export-supplier">
          <Download className="w-3.5 h-3.5 mr-1.5" /> Supplier Excel
        </Button>
        <Button size="sm" variant="outline" onClick={model.handleExportInternal} data-testid="button-export-internal">
          <FileText className="w-3.5 h-3.5 mr-1.5" /> Analysis Excel
        </Button>
      </div>
    </div>
  );
}
