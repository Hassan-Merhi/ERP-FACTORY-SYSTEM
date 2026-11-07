import type { ClientErrorLike } from "@/lib/clientError";
/**
 * StartContractForm — extracted sub-component.
 *
 * Extracted from PropertyRentalPage.tsx during the Phase 4 god-file split.
 */
import { useRef, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CURRENCIES, billingDayLabel } from "../utils";
import { useApiBase } from "../shared";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";

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
  // Create Only cannot create internal or company-linked leases (refused by the server).
  const { isCreateOnly } = useExistingRecordChangeAccess();
  const [isInternal, setIsInternal] = useState(false);
  const [linkedCompanyId, setLinkedCompanyId] = useState<number | null>(null);
  // Keep a single request identity for an exact retry, but never reuse that
  // identity if the operator changes the contract details after a failure.
  const pendingCreate = useRef<{ payload: string; requestId: string } | null>(null);

  const { data: allCompanies = [] } = useQuery<{ id: number; name: string }[]>({
    queryKey: ["/api/companies"],
    queryFn: async () => {
      const res = await fetch("/api/companies", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load companies");
      return res.json();
    },
    enabled: unitType === "SHOP" && apiBase === "/api/factory/rental" && !isCreateOnly,
  });

  const start = useMutation({
    mutationFn: () => {
      const payload = {
        ...form,
        guaranteeAmount: form.guaranteeAmount.trim() || "0",
        unitId,
        isInternal,
        ...(unitType === "SHOP" && apiBase === "/api/factory/rental" && isInternal ? { linkedCompanyId } : {}),
      };
      const fingerprint = JSON.stringify(payload);
      if (pendingCreate.current?.payload !== fingerprint) {
        pendingCreate.current = {
          payload: fingerprint,
          requestId:
            globalThis.crypto?.randomUUID?.() ?? `rental-contract-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        };
      }
      return apiRequest("POST", apiBase + "/contracts", {
        ...payload,
        clientRequestId: pendingCreate.current.requestId,
      });
    },
    onSuccess: () => {
      pendingCreate.current = null;
      toast({ title: "Contract started" });
      queryClient.invalidateQueries({ queryKey: [apiBase + "/units"] });
      onClose();
    },
    onError: (e: ClientErrorLike) => {
      // A contract insert may have committed before a later ledger-row error.
      // Refetch the unit so the operator cannot keep working from stale "Vacant" state.
      queryClient.invalidateQueries({ queryKey: [apiBase + "/units"] });
      toast({ title: "Error", description: e.message, variant: "destructive" });
    },
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
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-xs focus:outline-hidden focus:ring-1 focus:ring-ring"
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
        {!isCreateOnly && (unitType === "WAREHOUSE" || (unitType === "SHOP" && apiBase === "/api/factory/rental")) && (
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
                {unitType === "SHOP"
                  ? "Show this Factory shop in Properties Rentals as a read-only internal lease; Factory remains the accounting source."
                  : "This warehouse is occupied by your own company. It will also appear in Shops Rented for tracking."}
              </p>
            </div>
          </div>
        )}
        {!isCreateOnly && unitType === "SHOP" && apiBase === "/api/factory/rental" && isInternal && (
          <div className="sm:col-span-2 space-y-2 rounded-md border p-3">
            <Label>Properties company (optional)</Label>
            <p className="text-xs text-muted-foreground">
              Leave empty to show this lease in Properties for the same company. Choose a destination company only if
              Properties is managed under a different company.
            </p>
            <Select
              value={linkedCompanyId === null ? "none" : String(linkedCompanyId)}
              onValueChange={(value) => setLinkedCompanyId(value === "none" ? null : Number(value))}
            >
              <SelectTrigger data-testid={`select-${testIdPrefix}-internal-target`}>
                <SelectValue placeholder="Same company" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Same company</SelectItem>
                {allCompanies.map((company) => (
                  <SelectItem key={company.id} value={String(company.id)}>
                    {company.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
