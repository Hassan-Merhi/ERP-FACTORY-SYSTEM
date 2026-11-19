import { AlertTriangle } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { FactorySupplier } from "@shared/schema";
import type { ApiListRow } from "@shared/apiTypes";
import { ContainerFormCharges } from "./ContainerFormCharges";
import { ContainerFormPricing } from "./ContainerFormPricing";

type FormData = {
  containerNumber: string;
  supplierId: string;
  origin: string;
  totalKg: string;
  ratePerKg: string;
  arrivalDate: string;
  notes: string;
  status: string;
  commissionAmount: string;
  commissionCurrencyCode: string;
  commissionAccountId: string;
  commissionSupplierId: string;
  commissionNotes: string;
  freight: string;
  freightCurrencyCode: string;
  freightAccountId: string;
  freightPaidBy: "supplier" | "own";
  freightSupplierId: string;
  freightOwnAccountId: string;
  otherCharges: string;
  otherChargesAccountId: string;
};

export type OtherChargeLine = { amount: string; currencyCode: string; ledgerAccountId: string; narration: string };

export interface ContainerFormBodyProps {
  formData: FormData;
  setFormData: React.Dispatch<React.SetStateAction<FormData>>;
  currency: string;
  setCurrency: (v: string) => void;
  fxRate: string;
  setFxRate: (v: string) => void;
  fxRateSource: "auto" | "manual";
  setFxRateSource: (v: "auto" | "manual") => void;
  fxEffectiveDate: string;
  fxIsSuggestion: boolean;
  otherChargeLines: OtherChargeLine[];
  setOtherChargeLines: React.Dispatch<React.SetStateAction<OtherChargeLine[]>>;
  activeSuppliers: FactorySupplier[];
  filteredSupplierList: FactorySupplier[];
  selectedSupplier: FactorySupplier | null;
  brokerMismatch: boolean | null | undefined;
  ledgerAccounts: ApiListRow[];
}

export function ContainerFormBody({
  formData,
  setFormData,
  currency,
  setCurrency,
  fxRate,
  setFxRate,
  fxRateSource,
  setFxRateSource,
  fxEffectiveDate,
  fxIsSuggestion,
  otherChargeLines,
  setOtherChargeLines,
  activeSuppliers,
  filteredSupplierList,
  selectedSupplier,
  brokerMismatch,
  ledgerAccounts,
}: ContainerFormBodyProps) {
  const updateOtherChargeLine = (idx: number, field: keyof OtherChargeLine, value: string) =>
    setOtherChargeLines((prev) => prev.map((l, i) => (i === idx ? { ...l, [field]: value } : l)));

  return (
    <div className="max-h-[62vh] overflow-y-auto space-y-6 pr-1">
      {/* ── Section 1: Basic ───────────────────────────────────────────── */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <p className="text-sm font-semibold">Basic</p>
          <Separator className="flex-1" />
        </div>
        <div>
          <Label>Container Number *</Label>
          <Input
            value={formData.containerNumber}
            onChange={(e) => setFormData((f) => ({ ...f, containerNumber: e.target.value }))}
            placeholder="e.g., CNTR-2024-001"
            data-testid="input-container-number"
          />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <Label>Arrival Date</Label>
            <Input
              type="date"
              value={formData.arrivalDate}
              onChange={(e) => setFormData((f) => ({ ...f, arrivalDate: e.target.value }))}
              data-testid="input-container-arrival"
            />
          </div>
          <div>
            <Label>Status</Label>
            <Select value={formData.status} onValueChange={(val) => setFormData((f) => ({ ...f, status: val }))}>
              <SelectTrigger data-testid="select-container-status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="PENDING">Pending</SelectItem>
                <SelectItem value="IN_TRANSIT">In Transit</SelectItem>
                <SelectItem value="AVAILABLE">Available</SelectItem>
                <SelectItem value="OFFLOADED">Offloaded</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      {/* ── Section 2: Supplier & Broker ───────────────────────────────── */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <p className="text-sm font-semibold">Supplier &amp; Broker</p>
          <Separator className="flex-1" />
        </div>
        <div>
          <Label>
            Broker / Commission To <span className="text-muted-foreground text-xs font-normal">(optional)</span>
          </Label>
          <Select
            value={formData.commissionSupplierId || "__none__"}
            onValueChange={(val) => {
              const newBroker = val === "__none__" ? "" : val;
              setFormData((f) => ({
                ...f,
                commissionSupplierId: newBroker,
                supplierId: (() => {
                  if (!newBroker || !f.supplierId) return f.supplierId;
                  const sup = activeSuppliers.find((s) => s.id === parseInt(f.supplierId));
                  if (sup?.parentId && sup.parentId !== parseInt(newBroker)) return "";
                  return f.supplierId;
                })(),
              }));
            }}
          >
            <SelectTrigger data-testid="select-container-broker">
              <SelectValue placeholder="Select broker..." />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">None</SelectItem>
              {activeSuppliers.map((s) => (
                <SelectItem key={s.id} value={s.id.toString()}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label>Purchase Supplier</Label>
          <Select
            value={formData.supplierId || "__none__"}
            onValueChange={(val) => setFormData((f) => ({ ...f, supplierId: val === "__none__" ? "" : val }))}
          >
            <SelectTrigger data-testid="select-container-supplier">
              <SelectValue placeholder="Select supplier..." />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">None</SelectItem>
              {filteredSupplierList.map((s) => (
                <SelectItem key={s.id} value={s.id.toString()}>
                  {s.name}
                  {s.parentId ? " (linked)" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {formData.commissionSupplierId && (
            <p className="text-xs text-muted-foreground mt-1">
              Showing suppliers linked to broker + standalone suppliers
            </p>
          )}
        </div>
        {selectedSupplier?.parentId && !brokerMismatch && formData.commissionSupplierId && (
          <div className="rounded-md bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
            Linked to Broker:{" "}
            <span className="font-medium text-foreground">
              {activeSuppliers.find((s) => s.id === selectedSupplier.parentId)?.name ?? `#${selectedSupplier.parentId}`}
            </span>
          </div>
        )}
        {brokerMismatch && (
          <div className="rounded-md border border-yellow-400/60 bg-yellow-50 dark:bg-yellow-950/30 px-3 py-2 text-sm text-yellow-800 dark:text-yellow-300 flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>
              This supplier belongs to{" "}
              <strong>
                {activeSuppliers.find((s) => s.id === selectedSupplier?.parentId)?.name ??
                  `Broker #${selectedSupplier?.parentId}`}
              </strong>
              , not the selected broker.
            </span>
          </div>
        )}
      </div>

      {/* ── Section 3: Money & Commission ──────────────────────────────── */}
      <ContainerFormPricing
        formData={formData}
        setFormData={setFormData}
        fxRate={fxRate}
        currency={currency}
        setCurrency={setCurrency}
        fxRateSource={fxRateSource}
        fxEffectiveDate={fxEffectiveDate}
        setFxRateSource={setFxRateSource}
        setFxRate={setFxRate}
        fxIsSuggestion={fxIsSuggestion}
        ledgerAccounts={ledgerAccounts}
      />

      {/* ── Section 4: Freight & Other Charges ─────────────────────────── */}
      <ContainerFormCharges
        updateOtherChargeLine={updateOtherChargeLine}
        formData={formData}
        setFormData={setFormData}
        ledgerAccounts={ledgerAccounts}
        activeSuppliers={activeSuppliers}
        setOtherChargeLines={setOtherChargeLines}
        currency={currency}
        otherChargeLines={otherChargeLines}
      />
    </div>
  );
}
