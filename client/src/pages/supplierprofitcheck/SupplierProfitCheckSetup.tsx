import {
  BarChart2,
  CheckCircle,
  Download,
  FileSpreadsheet,
  FileText,
  Loader2,
  MapPin,
  Plus,
  Save,
  X,
} from "lucide-react";
import { PeriodFilter } from "@/components/ui/period-filter";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageHeader } from "@/components/PageHeader";
import type { ProfitSourceType, SellPriceSource } from "./useSupplierProfitCheckModel";
import {
  LandingCharges,
  OtwContainerPicker,
  ProfitSummary,
  type ProfitModel,
} from "./SupplierProfitCheckSetupOtwContainerPicker";

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
        {model.supplierId && model.canCreate("POST", "/api/supplier-profit-check/add-stock-item") && (
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
        {model.loaded &&
          !model.savedProforma &&
          !(model.sourceType === "proforma" && model.proformaId) &&
          model.canCreate("POST", "/api/supplier-profit-check/save-proforma") && (
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
          {/* Phones: one full-width control per row. */}
          <div className="flex flex-wrap gap-4 items-end max-sm:flex-col max-sm:items-stretch max-sm:gap-3 max-sm:**:[[role=combobox]]:w-full max-sm:[&_button]:w-full">
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
