// Extracted from ./BonusDialog.tsx
import type { usePayrollModel } from "./usePayrollModel";
import { TabsContent } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { AlertCircle, Loader2, RefreshCw } from "lucide-react";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { formatNumber } from "@/lib/formatNumber";
import { getThisMonthRange } from "./payrollSchemas";
import { encodeLocationOption } from "./payrollUtils";

type PayrollModel = ReturnType<typeof usePayrollModel>;

export interface BonusDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedEmployee: PayrollModel["selectedEmployee"];
  bonusTab: "sales" | "bales";
  setBonusTab: (v: "sales" | "bales") => void;
  bonusSalesPreview: PayrollModel["bonusSalesPreview"];
  setBonusSalesPreview: PayrollModel["setBonusSalesPreview"];
  bonusSalesCustomPct: string;
  setBonusSalesCustomPct: (v: string) => void;
  bonusSalesLocationId: string;
  setBonusSalesLocationId: (v: string) => void;
  bonusSalesPeriod: "thisMonth" | "custom";
  setBonusSalesPeriod: (v: "thisMonth" | "custom") => void;
  bonusSalesStart: string;
  setBonusSalesStart: (v: string) => void;
  bonusSalesEnd: string;
  setBonusSalesEnd: (v: string) => void;
  bonusSalesLoading: boolean;
  fetchSalesPreview: () => void;
  balesRows: PayrollModel["balesRows"];
  setBalesRows: PayrollModel["setBalesRows"];
  balesPeriod: "thisMonth" | "custom";
  setBalesPeriod: (v: "thisMonth" | "custom") => void;
  balesStart: string;
  setBalesStart: (v: string) => void;
  balesEnd: string;
  setBalesEnd: (v: string) => void;
  fetchBalesQty: (idx: number) => void;
  bonusDate: string;
  setBonusDate: (v: string) => void;
  bonusNotes: string;
  setBonusNotes: (v: string) => void;
  saveBonusToPending: () => void;
  submitSmartBonus: () => void;
  locations: PayrollModel["locations"];
  allCompanyLocations: PayrollModel["allCompanyLocations"];
}

export function BonusDialogTabsContent({
  allCompanyLocations,
  bonusSalesCustomPct,
  bonusSalesEnd,
  bonusSalesLoading,
  bonusSalesLocationId,
  bonusSalesPeriod,
  bonusSalesPreview,
  bonusSalesStart,
  fetchSalesPreview,
  formatAmount,
  locations,
  selectedEmployee,
  setBonusSalesCustomPct,
  setBonusSalesEnd,
  setBonusSalesLocationId,
  setBonusSalesPeriod,
  setBonusSalesPreview,
  setBonusSalesStart,
}: Pick<
  BonusDialogProps,
  | "allCompanyLocations"
  | "bonusSalesCustomPct"
  | "bonusSalesEnd"
  | "bonusSalesLoading"
  | "bonusSalesLocationId"
  | "bonusSalesPeriod"
  | "bonusSalesPreview"
  | "bonusSalesStart"
  | "fetchSalesPreview"
  | "locations"
  | "selectedEmployee"
  | "setBonusSalesCustomPct"
  | "setBonusSalesEnd"
  | "setBonusSalesLocationId"
  | "setBonusSalesPeriod"
  | "setBonusSalesPreview"
  | "setBonusSalesStart"
> &
  Pick<ReturnType<typeof useCurrencyContext>, "formatAmount">) {
  return (
    <TabsContent value="sales" className="space-y-4 mt-4">
      {selectedEmployee?.salesBonusPct == null || parseFloat(selectedEmployee.salesBonusPct) === 0 ? (
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            No sales bonus % configured for this employee. Edit the employee to set a percentage.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="space-y-1">
        <Label>Bonus Rate (%)</Label>
        <Input
          type="number"
          step="0.0001"
          placeholder="e.g. 0.2"
          value={bonusSalesCustomPct}
          onChange={(e) => {
            setBonusSalesCustomPct(e.target.value);
            setBonusSalesPreview(null);
          }}
          data-testid="input-sales-bonus-pct"
        />
        <p className="text-xs text-muted-foreground">Total sales × this % = bonus</p>
      </div>

      <div className="space-y-1">
        <Label>Location</Label>
        <Select
          value={bonusSalesLocationId}
          onValueChange={(v) => {
            setBonusSalesLocationId(v);
            setBonusSalesPreview(null);
          }}
        >
          <SelectTrigger data-testid="select-sales-location">
            <SelectValue placeholder="Select location" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectLabel>This Company</SelectLabel>
              {locations.map((loc) => (
                <SelectItem key={loc.id} value={encodeLocationOption(loc.id, loc.companyId)}>
                  {loc.name}
                </SelectItem>
              ))}
            </SelectGroup>
            {allCompanyLocations.length > 0 && (
              <SelectGroup>
                <SelectLabel>Other Companies</SelectLabel>
                {allCompanyLocations.map((loc) => (
                  <SelectItem key={`oc-${loc.companyId}-${loc.id}`} value={encodeLocationOption(loc.id, loc.companyId)}>
                    {loc.name} ({loc.companyName})
                  </SelectItem>
                ))}
              </SelectGroup>
            )}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1">
        <Label>Period</Label>
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            variant={bonusSalesPeriod === "thisMonth" ? "default" : "outline"}
            onClick={() => {
              setBonusSalesPeriod("thisMonth");
              setBonusSalesPreview(null);
            }}
            data-testid="button-sales-this-month"
          >
            This Month
          </Button>
          <Button
            type="button"
            size="sm"
            variant={bonusSalesPeriod === "custom" ? "default" : "outline"}
            onClick={() => {
              setBonusSalesPeriod("custom");
              setBonusSalesPreview(null);
            }}
            data-testid="button-sales-custom-period"
          >
            Custom
          </Button>
        </div>
        {bonusSalesPeriod === "custom" && (
          <div className="flex gap-2 mt-2">
            <Input
              type="date"
              value={bonusSalesStart}
              onChange={(e) => {
                setBonusSalesStart(e.target.value);
                setBonusSalesPreview(null);
              }}
              data-testid="input-sales-start"
            />
            <Input
              type="date"
              value={bonusSalesEnd}
              onChange={(e) => {
                setBonusSalesEnd(e.target.value);
                setBonusSalesPreview(null);
              }}
              data-testid="input-sales-end"
            />
          </div>
        )}
      </div>

      <Button
        type="button"
        variant="outline"
        className="w-full"
        onClick={fetchSalesPreview}
        disabled={!bonusSalesLocationId || bonusSalesLoading}
        data-testid="button-calculate-sales"
      >
        {bonusSalesLoading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-2" />}
        Calculate Bonus
      </Button>

      {bonusSalesPreview && (
        <div className="rounded-md border bg-muted/30 p-4 space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Period</span>
            <span className="font-medium font-mono text-xs">
              {(() => {
                const r =
                  bonusSalesPeriod === "thisMonth"
                    ? getThisMonthRange()
                    : { start: bonusSalesStart, end: bonusSalesEnd };
                return `${r.start} – ${r.end}`;
              })()}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Location</span>
            <span className="font-medium">{bonusSalesPreview.locationName}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Bales Sold</span>
            <span className="font-medium font-mono">
              {formatNumber(parseFloat(bonusSalesPreview.totalQuantity || "0"))}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Total Sales</span>
            <span className="font-medium font-mono">
              {formatAmount(parseFloat(bonusSalesPreview.totalSalesAmount || "0"))}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Rate</span>
            <span className="font-medium">{bonusSalesCustomPct}%</span>
          </div>
          <Separator />
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>Formula</span>
            <span className="font-mono">
              {formatAmount(parseFloat(bonusSalesPreview.totalSalesAmount || "0"))} × {bonusSalesCustomPct}% ={" "}
              {formatAmount(
                (parseFloat(bonusSalesPreview.totalSalesAmount || "0") * parseFloat(bonusSalesCustomPct || "0")) / 100
              )}
            </span>
          </div>
          <div className="flex justify-between text-base font-semibold">
            <span>Bonus Amount</span>
            <span className="text-green-600 dark:text-green-400 font-mono">
              {formatAmount(
                (parseFloat(bonusSalesPreview.totalSalesAmount || "0") * parseFloat(bonusSalesCustomPct || "0")) / 100
              )}
            </span>
          </div>
        </div>
      )}
    </TabsContent>
  );
}
