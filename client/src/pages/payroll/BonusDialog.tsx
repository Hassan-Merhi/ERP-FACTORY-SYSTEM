import type { usePayrollModel } from "./usePayrollModel";

type PayrollModel = ReturnType<typeof usePayrollModel>;
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { AlertCircle, Loader2, Package, Percent, Plus, RefreshCw, Save, X } from "lucide-react";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { formatNumber } from "@/lib/formatNumber";
import { getThisMonthRange } from "./payrollSchemas";
import { decodeLocationOption, encodeLocationOption } from "./payrollUtils";

interface BonusDialogProps {
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
          <TabsList variant="underline" className="w-full">
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
                        <SelectItem
                          key={`oc-${loc.companyId}-${loc.id}`}
                          value={encodeLocationOption(loc.id, loc.companyId)}
                        >
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
              {bonusSalesLoading ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4 mr-2" />
              )}
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
                      (parseFloat(bonusSalesPreview.totalSalesAmount || "0") * parseFloat(bonusSalesCustomPct || "0")) /
                        100
                    )}
                  </span>
                </div>
                <div className="flex justify-between text-base font-semibold">
                  <span>Bonus Amount</span>
                  <span className="text-green-600 dark:text-green-400 font-mono">
                    {formatAmount(
                      (parseFloat(bonusSalesPreview.totalSalesAmount || "0") * parseFloat(bonusSalesCustomPct || "0")) /
                        100
                    )}
                  </span>
                </div>
              </div>
            )}
          </TabsContent>

          {/* ── Bales / Units Tab ── */}
          <TabsContent value="bales" className="space-y-4 mt-4">
            <div className="space-y-1">
              <Label>Period</Label>
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant={balesPeriod === "thisMonth" ? "default" : "outline"}
                  onClick={() => setBalesPeriod("thisMonth")}
                  data-testid="button-bales-this-month"
                >
                  This Month
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={balesPeriod === "custom" ? "default" : "outline"}
                  onClick={() => setBalesPeriod("custom")}
                  data-testid="button-bales-custom-period"
                >
                  Custom
                </Button>
              </div>
              {balesPeriod === "custom" && (
                <div className="flex gap-2 mt-2">
                  <Input
                    type="date"
                    value={balesStart}
                    onChange={(e) => setBalesStart(e.target.value)}
                    data-testid="input-bales-start"
                  />
                  <Input
                    type="date"
                    value={balesEnd}
                    onChange={(e) => setBalesEnd(e.target.value)}
                    data-testid="input-bales-end"
                  />
                </div>
              )}
            </div>

            <div className="space-y-2">
              <div className="grid grid-cols-[1fr_72px_32px_72px_32px] gap-2 text-xs text-muted-foreground px-1">
                <span>Location</span>
                <span>Qty</span>
                <span></span>
                <span>Rate ($)</span>
                <span></span>
              </div>
              {balesRows.map((row, idx) => (
                <div key={idx} className="grid grid-cols-[1fr_72px_32px_72px_32px] gap-2 items-center">
                  <Select
                    value={row.locationId ? encodeLocationOption(row.locationId, row.sourceCompanyId) : ""}
                    onValueChange={(v) => {
                      const { locationId, sourceCompanyId } = decodeLocationOption(v);
                      setBalesRows((prev) =>
                        prev.map((r, i) => (i === idx ? { ...r, locationId, sourceCompanyId, qty: "" } : r))
                      );
                    }}
                  >
                    <SelectTrigger data-testid={`select-bales-location-${idx}`} className="h-9">
                      <SelectValue placeholder="Shop" />
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
                            <SelectItem
                              key={`oc-${loc.companyId}-${loc.id}`}
                              value={encodeLocationOption(loc.id, loc.companyId)}
                            >
                              {loc.name} ({loc.companyName})
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      )}
                    </SelectContent>
                  </Select>
                  <Input
                    type="number"
                    placeholder="0"
                    value={row.qty}
                    className="h-9"
                    onChange={(e) =>
                      setBalesRows((prev) => prev.map((r, i) => (i === idx ? { ...r, qty: e.target.value } : r)))
                    }
                    data-testid={`input-bales-qty-${idx}`}
                  />
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    title="Fetch qty from sales data"
                    disabled={!row.locationId || row.loading}
                    onClick={() => fetchBalesQty(idx)}
                    data-testid={`button-fetch-qty-${idx}`}
                  >
                    {row.loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                  </Button>
                  <Input
                    type="number"
                    step="0.01"
                    placeholder="0.00"
                    value={row.rate}
                    className="h-9"
                    onChange={(e) =>
                      setBalesRows((prev) => prev.map((r, i) => (i === idx ? { ...r, rate: e.target.value } : r)))
                    }
                    data-testid={`input-bales-rate-${idx}`}
                  />
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="text-muted-foreground"
                    onClick={() =>
                      setBalesRows((prev) => (prev.length === 1 ? prev : prev.filter((_, i) => i !== idx)))
                    }
                    data-testid={`button-remove-bales-row-${idx}`}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>

            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                setBalesRows((prev) => [
                  ...prev,
                  {
                    locationId: "",
                    sourceCompanyId: "",
                    qty: "",
                    rate: selectedEmployee?.balesBonusRate != null ? String(selectedEmployee.balesBonusRate) : "",
                    preview: null,
                    loading: false,
                  },
                ])
              }
              data-testid="button-add-bales-row"
            >
              <Plus className="h-4 w-4 mr-1" />
              Add Shop
            </Button>

            {(() => {
              const validRows = balesRows.filter((r) => parseFloat(r.qty || "0") > 0 && parseFloat(r.rate || "0") > 0);
              if (validRows.length === 0) return null;
              const grandTotal = validRows.reduce(
                (sum, r) => sum + parseFloat(r.qty || "0") * parseFloat(r.rate || "0"),
                0
              );
              const range = balesPeriod === "thisMonth" ? getThisMonthRange() : { start: balesStart, end: balesEnd };
              return (
                <div className="rounded-md border bg-muted/30 p-4 space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Period</span>
                    <span className="font-medium font-mono text-xs">
                      {range.start} – {range.end}
                    </span>
                  </div>
                  <Separator />
                  {validRows.map((row, i) => {
                    const q = parseFloat(row.qty || "0");
                    const r = parseFloat(row.rate || "0");
                    const rowTotal = q * r;
                    const loc =
                      locations.find((l) => l.id === parseInt(row.locationId)) ??
                      allCompanyLocations.find((l) => l.id === parseInt(row.locationId));
                    return (
                      <div key={i} className="space-y-1">
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Location</span>
                          <span className="font-medium">{loc?.name ?? "–"}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Bales Sold</span>
                          <span className="font-medium font-mono">{formatNumber(q)}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Rate</span>
                          <span className="font-medium font-mono">{formatAmount(r)} / bale</span>
                        </div>
                        <div className="flex justify-between text-xs text-muted-foreground">
                          <span>Formula</span>
                          <span className="font-mono">
                            {formatNumber(q)} × {formatAmount(r)} = {formatAmount(rowTotal)}
                          </span>
                        </div>
                        {validRows.length > 1 && (
                          <div className="flex justify-between font-medium">
                            <span>Subtotal</span>
                            <span className="font-mono">{formatAmount(rowTotal)}</span>
                          </div>
                        )}
                        {i < validRows.length - 1 && <Separator className="mt-1" />}
                      </div>
                    );
                  })}
                  <Separator />
                  <div className="flex justify-between text-base font-semibold">
                    <span>{validRows.length === 1 ? "Bonus Amount" : "Total Bonus"}</span>
                    <span className="text-green-600 dark:text-green-400 font-mono">{formatAmount(grandTotal)}</span>
                  </div>
                </div>
              );
            })()}
          </TabsContent>
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
