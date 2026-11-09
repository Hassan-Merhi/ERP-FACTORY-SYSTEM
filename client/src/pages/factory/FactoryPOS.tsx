/**
 * Factory POS page shell.
 *
 * Keeps its route and default export. The cart, product search, edit-mode
 * hydration, print snapshot and mutations live in
 * ./factorypos/useFactoryPosModel; the toolbar, mobile cart, desktop cart,
 * product browser, mobile sheets, history table, print receipt and dialogs are
 * separate views under ./factorypos.
 */
import { Check, History, Layers3, Package, Pencil, Plus, ShoppingCart, Wallet } from "lucide-react";
import { useSearch } from "wouter";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/PageHeader";
import { FactorySalesDispatchSwitcher } from "./FactorySalesDispatchSwitcher";
import { useFactoryPosModel } from "./factorypos/useFactoryPosModel";
import { FactoryPosToolbar } from "./factorypos/FactoryPosToolbar";
import { FactoryPosMobileCart } from "./factorypos/FactoryPosMobileCart";
import { FactoryPosCartTable } from "./factorypos/FactoryPosCartTable";
import { FactoryPosProductBrowser } from "./factorypos/FactoryPosProductBrowser";
import { FactoryPosMobileSheets } from "./factorypos/FactoryPosMobileSheets";
import { FactoryPosDialogs, FactoryPosHistory } from "./factorypos/FactoryPosHistoryAndDialogs";
import { formatNum } from "./factorypos/utils";

/**
 * Keyed on the sale being edited, so leaving edit mode ("New sale") or opening
 * another sale starts from a fresh cart instead of the previous sale's state.
 */
export default function FactoryPOS() {
  const editKey = new URLSearchParams(useSearch()).get("edit") ?? "new";
  return <FactoryPOSScreen key={editKey} />;
}

function FactoryPOSScreen() {
  const model = useFactoryPosModel();
  const { editSaleId, saleMutation, editMutation } = model;
  const isSaving = saleMutation.isPending || editMutation.isPending;

  return (
    <div className="space-y-4 pb-6" data-testid="factory-pos-page">
      <FactorySalesDispatchSwitcher />
      <section className="relative overflow-hidden rounded-2xl border border-orange-500/20 bg-gradient-to-br from-card via-card to-orange-500/10 px-4 pt-4 shadow-sm sm:px-5 sm:pt-5">
        <div className="pointer-events-none absolute -right-12 -top-32 h-60 w-80 rounded-full bg-orange-500/10 blur-3xl" aria-hidden="true" />
        <div className="relative">
          <PageHeader
            title={editSaleId ? `Editing ${model.editSaleData?.saleNumber || "Sale"}` : "Factory POS"}
            subtitle="Quick sales for factory operations"
            icon={<ShoppingCart className="h-5 w-5 text-orange-500" />}
          >
            <div className="flex flex-wrap gap-1 sm:gap-2">
              {editSaleId ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => model.navigate("/factory/pos")}
                  data-testid="button-new-sale"
                >
                  <Plus className="h-4 w-4 sm:mr-1" />
                  <span className="hidden sm:inline">New Sale</span>
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => model.setShowHistory((h) => !h)}
                  data-testid="button-toggle-history"
                >
                  <History className="h-4 w-4 sm:mr-1" />
                  <span className="hidden sm:inline">History</span>
                </Button>
              )}
              <Button
                size="sm"
                onClick={model.handleSubmit}
                disabled={model.validRows.length === 0 || isSaving}
                className="gap-1 bg-orange-600 text-white hover:bg-orange-700 dark:bg-orange-500 dark:hover:bg-orange-600 sm:gap-2"
                data-testid="button-complete-sale"
              >
                {isSaving ? (
                  "..."
                ) : editSaleId ? (
                  <>
                    <span className="hidden sm:inline">Update</span>
                    <Pencil className="h-4 w-4" />
                  </>
                ) : (
                  <>
                    <span className="hidden sm:inline">Save</span>
                    <Check className="h-4 w-4" />
                  </>
                )}
              </Button>
            </div>
          </PageHeader>
        </div>
      </section>

      {/* Display-only KPIs reuse the existing cart totals, without recalculating them. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3" aria-label="Current sale overview">
        <div className="flex items-center justify-between rounded-2xl border border-blue-500/25 bg-gradient-to-r from-blue-600/15 to-blue-500/5 p-4 shadow-sm" data-testid="pos-kpi-items">
          <div>
            <p className="text-xs font-medium text-muted-foreground">Items</p>
            <p className="mt-1 text-2xl font-bold tabular-nums">{model.validRows.length}</p>
          </div>
          <span className="rounded-xl bg-blue-500/15 p-3 text-blue-600 dark:text-blue-400"><Package className="h-6 w-6" /></span>
        </div>
        <div className="flex items-center justify-between rounded-2xl border border-violet-500/25 bg-gradient-to-r from-violet-600/15 to-violet-500/5 p-4 shadow-sm" data-testid="pos-kpi-qty">
          <div>
            <p className="text-xs font-medium text-muted-foreground">Qty</p>
            <p className="mt-1 text-2xl font-bold tabular-nums">{model.totalQty}</p>
          </div>
          <span className="rounded-xl bg-violet-500/15 p-3 text-violet-600 dark:text-violet-400"><Layers3 className="h-6 w-6" /></span>
        </div>
        <div className="col-span-2 flex items-center justify-between rounded-2xl border border-emerald-500/25 sm:col-span-1 bg-gradient-to-r from-emerald-600/15 to-emerald-500/5 p-4 shadow-sm" data-testid="pos-kpi-total">
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted-foreground">Total</p>
            <p className="mt-1 truncate text-2xl font-bold tabular-nums">{model.ccPrefix}{formatNum(model.total)}</p>
          </div>
          <span className="rounded-xl bg-emerald-500/15 p-3 text-emerald-600 dark:text-emerald-400"><Wallet className="h-6 w-6" /></span>
        </div>
      </div>

      {/* ── Toolbar ── */}
      <FactoryPosToolbar model={model} />

      {/* ── MOBILE card list (hidden on md+) ── */}
      <FactoryPosMobileCart model={model} />

      {/* ── DESKTOP: table + right product panel (hidden on mobile) ── */}
      <div className="hidden flex-col gap-4 md:flex lg:flex-row lg:items-start">
        {/* Main Table */}
        <Card className="flex-1 overflow-hidden min-w-0 rounded-2xl border-border/70 shadow-sm">
          <FactoryPosCartTable model={model} />
        </Card>

        {/* Right: Product Browser */}
        <FactoryPosProductBrowser model={model} />
      </div>

      {/* ── History ── */}
      <FactoryPosHistory model={model} />

      {/* ── Mobile sheets, FAB and sticky save bar ── */}
      <FactoryPosMobileSheets model={model} />

      {/* ── Print + void dialogs ── */}
      <FactoryPosDialogs model={model} />
    </div>
  );
}
