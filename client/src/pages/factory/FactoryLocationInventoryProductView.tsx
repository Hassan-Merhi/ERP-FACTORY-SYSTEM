import "./FactoryLocationInventoryRedesign.css";
import { useFactoryMhdView } from "@/hooks/use-factory-mhd-view";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  MapPin,
  Layers,
  Package,
  Printer,
  FileText,
  ClipboardList,
  X,
  FileSpreadsheet,
  Check,
  Pencil,
  Zap,
  AlertTriangle,
  TrendingUp,
  Weight,
  DollarSign,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { StatCard } from "./factorylocationinventory/components/StatCard";
import type { useFactoryLocationInventory } from "./FactoryLocationInventoryModel";
import { createFactoryLocationProductRenderers } from "./FactoryLocationInventoryProductRenderers";
import { createFactoryLocationProductMetrics } from "./factorylocationinventory/productMetrics";
import { FactoryLocationInventoryProductFooterDialogs } from "./factorylocationinventory/ProductFooterDialogs";
import { FactoryLocationInventoryProductTable } from "./FactoryLocationInventoryProductTable";

export type FactoryLocationInventoryModel = ReturnType<typeof useFactoryLocationInventory>;

type BreakdownStatCardProps = {
  icon: ReactNode;
  label: string;
  total: string;
  regular: string;
  special: string;
  unit: string;
  accent: string;
};

function BreakdownStatCard({ icon, label, total, regular, special, unit, accent }: BreakdownStatCardProps) {
  return (
    <div
      className="inventory-kpi-card min-w-0 rounded-xl border bg-card/40 shadow-xs"
      data-testid={`stat-${label.replace(/\s+/g, "-").toLowerCase()}`}
    >
      <div className="flex items-start gap-3 px-3.5 py-3">
        <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${accent}`}>{icon}</div>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
          <div className="text-xl font-bold leading-tight tracking-tight tabular-nums">{total}</div>
          <div className="mt-2 grid grid-cols-2 gap-2 border-t pt-2">
            <div className="min-w-0">
              <div className="text-[11px] leading-tight text-muted-foreground">Regular {unit}</div>
              <div className="mt-0.5 text-sm font-semibold tabular-nums">{regular}</div>
            </div>
            <div className="min-w-0 border-l pl-2">
              <div className="text-[11px] leading-tight text-muted-foreground">Wipers &amp; Garbage {unit}</div>
              <div className="mt-0.5 text-sm font-semibold tabular-nums">{special}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function FactoryLocationInventoryProductView({ inventory }: { inventory: FactoryLocationInventoryModel }) {
  const mhd = useFactoryMhdView();
  const [categorySearch, setCategorySearch] = useState("");
  if (!inventory.selectedLocation) return null;

  // ─── View 2: Product table ────────────────────────────────────────────────
  const metrics = createFactoryLocationProductMetrics(inventory);

  const renderers = createFactoryLocationProductRenderers(inventory, mhd.nameFor);
  const matchingCategoryNames = metrics.allCategoryNames.filter((name) =>
    name.toLocaleLowerCase().includes(categorySearch.trim().toLocaleLowerCase())
  );

  return (
    <div
      className={`factory-location-inventory inventory-product-view p-4 md:p-6 w-full space-y-5 ${inventory.proformaMode && inventory.selections.size > 0 ? "pb-24" : ""}`}
    >
      {/* Header */}
      <PageHeader
        title={inventory.selectedLocation.name}
        onBack={inventory.handleBackToLocations}
        backButtonTestId="breadcrumb-locations"
        meta={
          <>
            <Badge variant="outline" className="text-xs font-medium no-default-active-elevate">
              <MapPin className="h-3 w-3 mr-1" />
              Location Inventory
            </Badge>
            <span className="text-xs text-muted-foreground" data-testid="text-subtitle">
              Physical bales · IN_STOCK
            </span>
          </>
        }
      >
        {inventory.canChangeExistingRecords && (
          <Button
            variant="ghost"
            size="icon"
            onClick={(e) => inventory.openRenameDialog(inventory.selectedLocation, e)}
            data-testid="button-rename-selected-location"
            title="Rename location"
          >
            <Pencil className="h-4 w-4" />
          </Button>
        )}
        {(inventory.proformaMode || inventory.canCreateProforma) && (
          <Button
            variant={inventory.proformaMode ? "destructive" : "outline"}
            size="sm"
            onClick={inventory.toggleProformaMode}
            data-testid="button-toggle-proforma-mode"
          >
            <ClipboardList className="h-4 w-4 mr-1.5" />
            {inventory.proformaMode ? "Exit Proforma" : "Proforma Mode"}
          </Button>
        )}
        <Button
          variant="outline"
          size="icon"
          onClick={() => inventory.handlePrint()}
          data-testid="button-print"
          title="Print"
        >
          <Printer className="h-4 w-4" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          onClick={() => {
            const p = new URLSearchParams();
            if (inventory.hideAvgCost) p.set("includeCost", "0");
            if (inventory.hideSellingPrice) p.set("includeSellPrice", "0");
            const qs = p.toString();
            window.open(
              `/api/factory/location-inventory/${inventory.selectedLocation.id}/export/excel${qs ? "?" + qs : ""}`,
              "_blank"
            );
          }}
          data-testid="button-export-location-excel"
          title="Export Excel"
        >
          <FileSpreadsheet className="h-4 w-4" />
        </Button>
      </PageHeader>

      {/* KPI cards: each stock quantity shows the combined total and both categories. */}
      {!inventory.inventoryLoading && (
        <div className="inventory-kpi-grid grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <BreakdownStatCard
            icon={<Package className="h-4 w-4 text-blue-400" />}
            label="Total Bales"
            total={(metrics.regularBales + metrics.specialBales).toLocaleString()}
            regular={metrics.regularBales.toLocaleString()}
            special={metrics.specialBales.toLocaleString()}
            unit="Bales"
            accent="bg-blue-500/10"
          />
          <BreakdownStatCard
            icon={<Weight className="h-4 w-4 text-emerald-400" />}
            label="Total KG"
            total={inventory.fmt(metrics.regularKg + metrics.specialKg)}
            regular={inventory.fmt(metrics.regularKg)}
            special={inventory.fmt(metrics.specialKg)}
            unit="KG"
            accent="bg-emerald-500/10"
          />
          <StatCard
            className="inventory-stat-card inventory-kpi-categories"
            icon={<Layers className="h-4 w-4 text-purple-400" />}
            label="Categories"
            value={String(inventory.categoryGroups.length)}
            sub={`${inventory.activeInventoryData.length} products total`}
            accent="bg-purple-500/10"
          />
          {!inventory.hideAvgCost && (
            <StatCard
              className="inventory-stat-card inventory-kpi-cost"
              icon={<DollarSign className="h-4 w-4 text-amber-400" />}
              label="Cost Value"
              value={inventory.formatAmount(metrics.statsCostValue)}
              sub="production price basis"
              accent="bg-amber-500/10"
            />
          )}
          {!inventory.hideSellingPrice && (
            <StatCard
              className="inventory-stat-card inventory-kpi-selling"
              icon={<TrendingUp className="h-4 w-4 text-green-400" />}
              label="Sell Value"
              value={inventory.formatAmount(metrics.statsSellValue)}
              sub="at current selling price"
              accent="bg-green-500/10"
            />
          )}
        </div>
      )}

      {/* Proforma advisory — only visible inside proforma mode */}
      {inventory.proformaMode && (
        <div
          className="mb-3 flex items-start gap-2 px-3 py-2.5 rounded-md bg-amber-500/10 border border-amber-500/25 text-sm text-amber-800 dark:text-amber-300"
          data-testid="note-proforma-advisory"
        >
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
          <span>
            Available quantities shown do not subtract V5 reserved allocations. Check the{" "}
            <span className="font-medium">Stock Allocation V5</span> page for net availability before committing.
          </span>
        </div>
      )}

      {/* Proforma controls */}
      {inventory.proformaMode && (
        <div className="mb-4 flex items-center gap-2 flex-wrap">
          {inventory.editingProformaId && (
            <div className="w-full flex items-center gap-2 mb-1 p-2 rounded-md bg-primary/10 border border-primary/20">
              <FileText className="h-4 w-4 text-primary shrink-0" />
              <span className="text-sm font-medium text-primary">
                Editing proforma: <span className="font-bold">{inventory.proformaName}</span>
              </span>
              <span className="text-xs text-muted-foreground ml-1 flex-1">
                {inventory.proformaAutoSave
                  ? "— Changes auto-save 2 s after you stop editing"
                  : "— Select items and click Update Proforma to save changes"}
              </span>
              <button
                onClick={inventory.toggleProformaAutoSave}
                className={`flex items-center gap-1.5 px-2.5 h-7 rounded border text-xs font-medium transition-colors shrink-0 ${
                  inventory.proformaAutoSave
                    ? "bg-green-500/10 border-green-500/50 text-green-600 dark:text-green-400"
                    : "bg-background border-border text-muted-foreground"
                }`}
                data-testid="button-proforma-autosave-toggle"
              >
                <Zap className={`h-3.5 w-3.5 ${inventory.proformaAutoSave ? "fill-green-500 text-green-500" : ""}`} />
                Autosave
                <span
                  className={`w-7 h-3.5 rounded-full relative transition-colors ${inventory.proformaAutoSave ? "bg-green-500" : "bg-muted-foreground/30"}`}
                >
                  <span
                    className={`absolute top-0.5 w-2.5 h-2.5 rounded-full bg-white shadow-sm transition-transform ${inventory.proformaAutoSave ? "translate-x-3.5" : "translate-x-0.5"}`}
                  />
                </span>
              </button>
            </div>
          )}
          <Button variant="outline" size="sm" onClick={inventory.selectAllVisible} data-testid="button-select-all">
            <Check className="h-4 w-4 mr-1" /> Select All
          </Button>
          <Button variant="outline" size="sm" onClick={inventory.deselectAllVisible} data-testid="button-deselect-all">
            <X className="h-4 w-4 mr-1" /> Deselect All
          </Button>
          {inventory.selections.size > 0 && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={inventory.applySellingPrices}
                data-testid="button-apply-selling-price"
              >
                Apply Sell Price
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={inventory.applyProductionPrices}
                data-testid="button-apply-production-price"
              >
                Apply Prod Price
              </Button>
            </>
          )}
          <div className="flex items-center gap-1.5 ml-2">
            <Checkbox
              checked={inventory.showSelectedOnly}
              onCheckedChange={(v) => inventory.setShowSelectedOnly(!!v)}
              id="show-selected-only"
              data-testid="checkbox-show-selected-only"
            />
            <label htmlFor="show-selected-only" className="text-sm cursor-pointer select-none">
              Selected only
            </label>
          </div>
          <Button
            variant={inventory.hideZeroAvailable ? "outline" : "secondary"}
            size="sm"
            onClick={() => inventory.setHideZeroAvailable((v) => !v)}
            data-testid="button-toggle-zero-available"
          >
            {inventory.hideZeroAvailable ? "Show 0" : "Hide 0"}
          </Button>
          {inventory.selections.size > 0 && (
            <Badge variant="secondary" className="text-sm ml-auto">
              {inventory.selections.size} items,{" "}
              {Array.from(inventory.selections.values()).reduce((s, v) => s + v.selectedQty, 0)} bales
            </Badge>
          )}
        </div>
      )}

      {/* Main card — toolbar + table */}
      <FactoryLocationInventoryProductTable
        inventory={inventory}
        metrics={metrics}
        renderers={renderers}
        mhd={mhd}
        categorySearch={categorySearch}
        setCategorySearch={setCategorySearch}
        matchingCategoryNames={matchingCategoryNames}
      />

      <FactoryLocationInventoryProductFooterDialogs inventory={inventory} />
    </div>
  );
}
