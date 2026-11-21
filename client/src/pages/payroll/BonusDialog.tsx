import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Package, Percent, Save } from "lucide-react";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { BonusDialogBalesTab } from "./BonusDialogBalesTab";
import { BonusDialogTabsContent, type BonusDialogProps } from "./BonusDialogTabsContent";
export type { BonusDialogProps } from "./BonusDialogTabsContent";

export function BonusDialog({
  open,
  onOpenChange,
  selectedEmployee,
  bonusTab,
  setBonusTab,
  bonusSalesPreview,
  setBonusSalesPreview,
  bonusSalesCustomPct,
  setBonusSalesCustomPct,
  bonusSalesLocationId,
  setBonusSalesLocationId,
  bonusSalesPeriod,
  setBonusSalesPeriod,
  bonusSalesStart,
  setBonusSalesStart,
  bonusSalesEnd,
  setBonusSalesEnd,
  bonusSalesLoading,
  fetchSalesPreview,
  balesRows,
  setBalesRows,
  balesPeriod,
  setBalesPeriod,
  balesStart,
  setBalesStart,
  balesEnd,
  setBalesEnd,
  fetchBalesQty,
  bonusDate,
  setBonusDate,
  bonusNotes,
  setBonusNotes,
  saveBonusToPending,
  submitSmartBonus,
  locations,
  allCompanyLocations,
}: BonusDialogProps) {
  const { formatAmount } = useCurrencyContext();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="dialog-bonus" className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Calculate Bonus</DialogTitle>
          <DialogDescription>
            {selectedEmployee?.firstName} {selectedEmployee?.lastName}
          </DialogDescription>
        </DialogHeader>

        <Tabs
          value={bonusTab}
          onValueChange={(v) => {
            setBonusTab(v as "sales" | "bales");
            setBonusSalesPreview(null);
          }}
        >
          <TabsList className="w-full" aria-label="Bonus calculation method">
            <TabsTrigger value="sales" className="flex-1" data-testid="tab-sales-bonus">
              <Percent className="h-4 w-4 mr-1" />
              Sales %
            </TabsTrigger>
            <TabsTrigger value="bales" className="flex-1" data-testid="tab-bales-bonus">
              <Package className="h-4 w-4 mr-1" />
              Bales / Units
            </TabsTrigger>
          </TabsList>

          {/* ── Sales % Tab ── */}
          <BonusDialogTabsContent
            allCompanyLocations={allCompanyLocations}
            bonusSalesCustomPct={bonusSalesCustomPct}
            bonusSalesEnd={bonusSalesEnd}
            bonusSalesLoading={bonusSalesLoading}
            bonusSalesLocationId={bonusSalesLocationId}
            bonusSalesPeriod={bonusSalesPeriod}
            bonusSalesPreview={bonusSalesPreview}
            bonusSalesStart={bonusSalesStart}
            fetchSalesPreview={fetchSalesPreview}
            formatAmount={formatAmount}
            locations={locations}
            selectedEmployee={selectedEmployee}
            setBonusSalesCustomPct={setBonusSalesCustomPct}
            setBonusSalesEnd={setBonusSalesEnd}
            setBonusSalesLocationId={setBonusSalesLocationId}
            setBonusSalesPeriod={setBonusSalesPeriod}
            setBonusSalesPreview={setBonusSalesPreview}
            setBonusSalesStart={setBonusSalesStart}
          />

          {/* ── Bales / Units Tab ── */}
          <BonusDialogBalesTab
            formatAmount={formatAmount}
            balesPeriod={balesPeriod}
            setBalesPeriod={setBalesPeriod}
            balesStart={balesStart}
            setBalesStart={setBalesStart}
            balesEnd={balesEnd}
            setBalesEnd={setBalesEnd}
            balesRows={balesRows}
            setBalesRows={setBalesRows}
            locations={locations}
            allCompanyLocations={allCompanyLocations}
            fetchBalesQty={fetchBalesQty}
            selectedEmployee={selectedEmployee}
          />
        </Tabs>

        <Separator />

        <div className="space-y-3">
          <div className="space-y-1">
            <Label>Date</Label>
            <Input
              type="date"
              value={bonusDate}
              onChange={(e) => setBonusDate(e.target.value)}
              data-testid="input-bonus-date"
            />
          </div>
          <div className="space-y-1">
            <Label>Notes (Optional)</Label>
            <Textarea
              placeholder="Reason for bonus..."
              value={bonusNotes}
              onChange={(e) => setBonusNotes(e.target.value)}
              data-testid="input-bonus-notes"
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 flex-wrap">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} data-testid="button-cancel-bonus">
            Cancel
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={saveBonusToPending}
            disabled={
              bonusTab === "sales"
                ? !bonusSalesPreview || parseFloat(bonusSalesCustomPct || "0") <= 0
                : balesRows.reduce((s, r) => s + parseFloat(r.qty || "0") * parseFloat(r.rate || "0"), 0) <= 0
            }
            data-testid="button-save-bonus-to-bulk"
          >
            <Save className="h-4 w-4 mr-2" />
            Save to Bulk
          </Button>
          <Button
            type="button"
            onClick={submitSmartBonus}
            disabled={
              bonusTab === "sales"
                ? !bonusSalesPreview || parseFloat(bonusSalesCustomPct || "0") <= 0
                : balesRows.reduce((s, r) => s + parseFloat(r.qty || "0") * parseFloat(r.rate || "0"), 0) <= 0
            }
            data-testid="button-submit-bonus"
          >
            {bonusTab === "sales" && bonusSalesPreview
              ? `Give Now ${formatAmount((parseFloat(bonusSalesPreview.totalSalesAmount || "0") * parseFloat(bonusSalesCustomPct || "0")) / 100)}`
              : bonusTab === "bales"
                ? `Give Now ${formatAmount(balesRows.reduce((s, r) => s + parseFloat(r.qty || "0") * parseFloat(r.rate || "0"), 0))}`
                : "Give Now"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
