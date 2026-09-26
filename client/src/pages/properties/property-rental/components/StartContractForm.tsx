import type { ClientErrorLike } from "@/lib/clientError";
/**
 * StartContractForm — extracted sub-component.
 *
 * Extracted from PropertyRentalPage.tsx during the Phase 4 god-file split.
 */
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { DialogFooter } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { CalendarDays } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { CURRENCIES, billingDayLabel } from "../utils";
import { useApiBase } from "../shared";

export function StartContractForm({
  unitId,
  testIdPrefix,
  onClose,
  unitType,
}: {
  unitId: number;
  testIdPrefix: string;
  onClose: () => void;
  unitType: "WAREHOUSE" | "SHOP";
}) {
  const apiBase = useApiBase();
  const { toast } = useToast();
  const { baseCurrency } = useCurrencyContext();
  const defaultCurrency = baseCurrency === "CFA" || baseCurrency === "EUR" ? baseCurrency : "USD";
  const [form, setForm] = useState({
    tenantName: "",
    rentalAmount: "",
    guaranteeAmount: "",
    guaranteePeriod: "",
    startDate: new Date().toISOString().slice(0, 10),
    notes: "",
    currency: defaultCurrency,
  });
  const [isInternal, setIsInternal] = useState(false);

  const start = useMutation({
    mutationFn: () => apiRequest("POST", apiBase + "/contracts", { ...form, unitId, isInternal }),
    onSuccess: () => {
      toast({ title: "Contract started" });
      queryClient.invalidateQueries({ queryKey: [apiBase + "/units"] });
      onClose();
    },
    onError: (e: ClientErrorLike) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">This unit is vacant. Start a new lease:</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <Label>Tenant Name *</Label>
          <Input
            value={form.tenantName}
            onChange={(e) => setForm((f) => ({ ...f, tenantName: e.target.value }))}
            data-testid={`input-${testIdPrefix}-tenant-name`}
          />
        </div>
        <div>
          <Label>Start Date *</Label>
          <Input
            type="date"
            value={form.startDate}
            onChange={(e) => setForm((f) => ({ ...f, startDate: e.target.value }))}
            data-testid={`input-${testIdPrefix}-start-date`}
          />
          {form.startDate && (
            <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
              <CalendarDays className="h-3 w-3 shrink-0" />
              Charges on the {billingDayLabel(form.startDate)}
            </p>
          )}
        </div>
        <div>
          <Label>Currency</Label>
          <select
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
            value={form.currency}
            onChange={(e) => setForm((f) => ({ ...f, currency: e.target.value }))}
            data-testid={`select-${testIdPrefix}-contract-currency`}
          >
            {CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label>Monthly Rental Amount *</Label>
          <Input
            type="number"
            step="0.01"
            value={form.rentalAmount}
            onChange={(e) => setForm((f) => ({ ...f, rentalAmount: e.target.value }))}
            data-testid={`input-${testIdPrefix}-rental-amount`}
          />
        </div>
        <div>
          <Label>Guarantee Amount</Label>
          <Input
            type="number"
            step="0.01"
            value={form.guaranteeAmount}
            onChange={(e) => setForm((f) => ({ ...f, guaranteeAmount: e.target.value }))}
            data-testid={`input-${testIdPrefix}-guarantee-amount`}
          />
        </div>
        <div>
          <Label>Guarantee Period</Label>
          <Input
            value={form.guaranteePeriod}
            onChange={(e) => setForm((f) => ({ ...f, guaranteePeriod: e.target.value }))}
            placeholder="e.g. 3 MONTHS"
            data-testid={`input-${testIdPrefix}-guarantee-period`}
          />
        </div>
        <div className="sm:col-span-2">
          <Label>Notes</Label>
          <Textarea
            rows={2}
            value={form.notes}
            onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
            data-testid={`input-${testIdPrefix}-contract-notes`}
          />
        </div>
        {unitType === "WAREHOUSE" && (
          <div className="sm:col-span-2 flex items-center gap-3 rounded-md border p-3 bg-violet-50 dark:bg-violet-950/20">
            <Switch
              id={`switch-${testIdPrefix}-internal`}
              checked={isInternal}
              onCheckedChange={setIsInternal}
              data-testid={`switch-${testIdPrefix}-internal`}
            />
            <div>
              <Label htmlFor={`switch-${testIdPrefix}-internal`} className="font-semibold cursor-pointer">
                Internal Lease
              </Label>
              <p className="text-xs text-muted-foreground mt-0.5">
                This warehouse is occupied by your own company. It will also appear in Shops Rented for tracking.
              </p>
            </div>
          </div>
        )}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button
          onClick={() => start.mutate()}
          disabled={!form.tenantName || !form.rentalAmount || start.isPending}
          data-testid={`button-${testIdPrefix}-start-contract`}
        >
          {start.isPending ? "Starting…" : "Start Contract"}
        </Button>
      </DialogFooter>
    </div>
  );
}

// ──────────────────────────────────────────────────────────
// REUSABLE: ACCOUNT SEARCH SELECT
// ──────────────────────────────────────────────────────────
