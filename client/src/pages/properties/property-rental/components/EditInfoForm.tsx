import type { ClientErrorLike } from "@/lib/clientError";
/**
 * EditInfoForm — extracted sub-component.
 *
 * Extracted from PropertyRentalPage.tsx during the Phase 4 god-file split.
 */
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { CalendarDays } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import type { Contract, Unit } from "../types";
import { billingDayLabel } from "../utils";
import { useApiBase } from "../shared";

export // ──────────────────────────────────────────────────────────
// TAB: EDIT CONTRACT INFO
// ──────────────────────────────────────────────────────────
function EditInfoForm({
  contract,
  testIdPrefix,
  unitId,
  unit,
  unitType,
}: {
  contract: Contract;
  testIdPrefix: string;
  unitId: number;
  unit: Unit;
  unitType: "WAREHOUSE" | "SHOP";
}) {
  const apiBase = useApiBase();
  const { toast } = useToast();
  const [tenantName, setTenantName] = useState(contract.tenantName);
  const [startDate, setStartDate] = useState(
    contract.startDate ? new Date(contract.startDate).toISOString().slice(0, 10) : ""
  );
  const [guaranteeAmount, setGuaranteeAmount] = useState(contract.guaranteeAmount ?? "");
  const [guaranteePeriod, setGuaranteePeriod] = useState(contract.guaranteePeriod ?? "");
  const [unitNumber, setUnitNumber] = useState(unit.unitNumber);
  const [dimensions, setDimensions] = useState(unit.dimensions ?? "");
  const [isInternal, setIsInternal] = useState(contract.isInternal ?? false);
  const [linkedCompanyId, setLinkedCompanyId] = useState<number | null>(contract.linkedCompanyId ?? null);

  const { data: allCompanies = [] } = useQuery<{ id: number; name: string }[]>({
    queryKey: ["/api/companies"],
    queryFn: async () => {
      const res = await fetch("/api/companies", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load companies");
      return res.json();
    },
  });

  const saveContract = useMutation({
    mutationFn: () =>
      apiRequest("PATCH", `${apiBase}/contracts/${contract.id}/info`, {
        tenantName,
        startDate,
        guaranteeAmount,
        guaranteePeriod,
        isInternal,
        linkedCompanyId,
      }),
    onSuccess: () => {
      toast({ title: "Contract info updated" });
      queryClient.invalidateQueries({ queryKey: [apiBase + "/units"] });
      queryClient.invalidateQueries({ queryKey: [apiBase + "/units", unitId, "detail"] });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const saveUnit = useMutation({
    mutationFn: () => apiRequest("PATCH", `${apiBase}/units/${unitId}`, { unitNumber, dimensions: dimensions || null }),
    onSuccess: () => {
      toast({ title: "Unit name updated" });
      queryClient.invalidateQueries({ queryKey: [apiBase + "/units"] });
    },
    onError: (e: ClientErrorLike) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const contractChanged =
    tenantName !== contract.tenantName ||
    startDate !== (contract.startDate ? new Date(contract.startDate).toISOString().slice(0, 10) : "") ||
    guaranteeAmount !== (contract.guaranteeAmount ?? "") ||
    guaranteePeriod !== (contract.guaranteePeriod ?? "") ||
    isInternal !== (contract.isInternal ?? false) ||
    linkedCompanyId !== (contract.linkedCompanyId ?? null);
  const unitChanged = unitNumber !== unit.unitNumber || dimensions !== (unit.dimensions ?? "");

  return (
    <div className="space-y-5 pt-3">
      <div className="space-y-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Unit</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <Label>Unit Name</Label>
            <Input
              value={unitNumber}
              onChange={(e) => setUnitNumber(e.target.value.toUpperCase())}
              data-testid={`input-${testIdPrefix}-edit-unit-number`}
            />
          </div>
          <div>
            <Label>Dimensions</Label>
            <Input
              value={dimensions}
              onChange={(e) => setDimensions(e.target.value)}
              placeholder="e.g. 35 X 12"
              data-testid={`input-${testIdPrefix}-edit-dimensions`}
            />
          </div>
        </div>
        <div className="flex justify-end">
          <Button
            onClick={() => saveUnit.mutate()}
            disabled={!unitChanged || !unitNumber || saveUnit.isPending}
            data-testid={`button-${testIdPrefix}-save-unit`}
          >
            {saveUnit.isPending ? "Saving…" : "Save Unit Info"}
          </Button>
        </div>
      </div>

      <div className="border-t pt-4 space-y-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Contract</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <Label>Tenant Name *</Label>
            <Input
              value={tenantName}
              onChange={(e) => setTenantName(e.target.value)}
              data-testid={`input-${testIdPrefix}-edit-tenant`}
            />
          </div>
          <div>
            <Label>Start Date *</Label>
            <Input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              data-testid={`input-${testIdPrefix}-edit-start-date`}
            />
            {startDate && (
              <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
                <CalendarDays className="h-3 w-3 shrink-0" />
                Charges on the {billingDayLabel(startDate)}
              </p>
            )}
          </div>
          <div>
            <Label>Guarantee Amount</Label>
            <Input
              type="number"
              step="0.01"
              value={guaranteeAmount}
              onChange={(e) => setGuaranteeAmount(e.target.value)}
              data-testid={`input-${testIdPrefix}-edit-guarantee`}
            />
          </div>
          <div>
            <Label>Guarantee Period</Label>
            <Input
              value={guaranteePeriod}
              onChange={(e) => setGuaranteePeriod(e.target.value)}
              placeholder="e.g. 3 MONTHS"
              data-testid={`input-${testIdPrefix}-edit-guarantee-period`}
            />
          </div>
        </div>
        {(unitType === "WAREHOUSE" || (unitType === "SHOP" && apiBase === "/api/factory/rental")) && (
          <div className="flex items-center gap-3 rounded-md border p-3 bg-violet-50 dark:bg-violet-950/20 mt-2">
            <Switch
              id={`switch-edit-${testIdPrefix}-internal`}
              checked={isInternal}
              onCheckedChange={setIsInternal}
              data-testid={`switch-edit-${testIdPrefix}-internal`}
            />
            <div>
              <Label htmlFor={`switch-edit-${testIdPrefix}-internal`} className="font-semibold cursor-pointer">
                Internal Lease
              </Label>
              <p className="text-xs text-muted-foreground mt-0.5">
                {unitType === "SHOP"
                  ? "Show this Factory shop as a read-only internal lease in Properties → Rentals → Shops. If Properties uses another company, choose it under Share with Company."
                  : "Toggle on to make this warehouse also appear in Shops Rented as a self-occupied property."}
              </p>
            </div>
          </div>
        )}
        <div className="rounded-md border p-3 bg-sky-50 dark:bg-sky-950/20 space-y-2 mt-2">
          <div>
            <Label className="font-semibold">Share with Company</Label>
            <p className="text-xs text-muted-foreground mt-0.5">
              The selected company will see this contract as a read-only entry in their rental view.
            </p>
          </div>
          <Select
            value={linkedCompanyId !== null ? String(linkedCompanyId) : "none"}
            onValueChange={(v) => setLinkedCompanyId(v === "none" ? null : Number(v))}
            data-testid={`select-${testIdPrefix}-linked-company`}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="No sharing" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No sharing</SelectItem>
              {allCompanies.map((c) => (
                <SelectItem key={c.id} value={String(c.id)}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button
            onClick={() => saveContract.mutate()}
            disabled={!contractChanged || !tenantName || !startDate || saveContract.isPending}
            data-testid={`button-${testIdPrefix}-save-info`}
          >
            {saveContract.isPending ? "Saving…" : "Save Contract Info"}
          </Button>
        </DialogFooter>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────
// LEDGER VIEW / STATEMENT
// ──────────────────────────────────────────────────────────
