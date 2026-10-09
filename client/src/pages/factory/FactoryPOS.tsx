/**
 * Factory POS page shell.
 *
 * Keeps its route and default export. The cart, product search, edit-mode
 * hydration, print snapshot and mutations live in
 * ./factorypos/useFactoryPosModel; the toolbar, mobile cart, desktop cart,
 * product browser, mobile sheets, history table, print receipt and dialogs are
 * separate views under ./factorypos.
 */
import { Check, History, Pencil, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/PageHeader";
import { useFactoryPosModel } from "./factorypos/useFactoryPosModel";
import { FactoryPosToolbar } from "./factorypos/FactoryPosToolbar";
import { FactoryPosMobileCart } from "./factorypos/FactoryPosMobileCart";
import { FactoryPosCartTable } from "./factorypos/FactoryPosCartTable";
import { FactoryPosProductBrowser } from "./factorypos/FactoryPosProductBrowser";
import { FactoryPosMobileSheets } from "./factorypos/FactoryPosMobileSheets";
import { FactoryPosDialogs, FactoryPosHistory } from "./factorypos/FactoryPosHistoryAndDialogs";

export default function FactoryPOS() {
  const model = useFactoryPosModel();
  const { editSaleId, saleMutation, editMutation } = model;
  const isSaving = saleMutation.isPending || editMutation.isPending;

  return (
    <div className="space-y-4">
      <PageHeader title={editSaleId ? `Editing ${model.editSaleData?.saleNumber || "Sale"}` : "Factory POS"}>
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
            className="gap-1 sm:gap-2"
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

      {/* ── Toolbar ── */}
      <FactoryPosToolbar model={model} />

      {/* ── MOBILE card list (hidden on md+) ── */}
      <FactoryPosMobileCart model={model} />

      {/* ── DESKTOP: table + right product panel (hidden on mobile) ── */}
      <div className="hidden md:flex flex-col lg:flex-row gap-4">
        {/* Main Table */}
        <Card className="flex-1 overflow-hidden min-w-0">
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
