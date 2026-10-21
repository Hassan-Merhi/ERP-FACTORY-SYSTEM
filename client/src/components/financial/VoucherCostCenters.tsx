import { useEffect, useMemo, useState } from "react";
import Decimal from "decimal.js";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useCompany } from "@/contexts/CompanyContext";
import { useAppMode } from "@/contexts/AppModeContext";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Plus, Trash2, Layers3 } from "lucide-react";
import type {
  CostCenterCatalog,
  SourceCostCenterAllocation,
  VoucherExpenseEntry,
  VoucherExpenseEntries,
} from "@/api/costCentersApi";
import { readCostCenterApi, writeCostCenterApi } from "@/api/costCentersApi";

type DraftSplit = { costCenterId: string; amountNative: string };
function d(v: string | number | null | undefined): Decimal {
  try {
    return new Decimal(v || "0");
  } catch {
    return new Decimal(0);
  }
}
function money(v: string | number, currency: string) {
  return currency + " " + d(v).toDecimalPlaces(2).toFixed(2);
}
function apiError(e: unknown): string {
  return e instanceof Error ? e.message : "Unable to save cost-center allocation";
}
/** Before the reviewed cost-center migrations are applied the API answers 503. */
function notInstalled(e: unknown): boolean {
  return (e as { code?: unknown } | null)?.code === "COST_CENTERS_NOT_INSTALLED";
}
function emptySplit(): DraftSplit {
  return { costCenterId: "", amountNative: "" };
}

export function CostCenterEntryEditor({
  entry,
  onClose,
  onSaved,
  apiBase,
  sourceType = "voucher_entry",
}: {
  entry: VoucherExpenseEntry;
  onClose: () => void;
  onSaved: () => Promise<void>;
  apiBase: string;
  sourceType?: "voucher_entry" | "factory_daybook";
}) {
  const { selectedCompany } = useCompany();
  const { toast } = useToast();
  const companyId = selectedCompany?.id;
  const role = selectedCompany?.role || "";
  const canEdit = ["Admin", "Owner", "Developer"].includes(role);
  const [draft, setDraft] = useState<DraftSplit[]>([]);
  const [reason, setReason] = useState("Allocate cost center");
  const [dirty, setDirty] = useState(false);
  const key = [apiBase, companyId, sourceType, entry.entryId];
  const {
    data: source,
    isLoading: loadingSource,
    error: sourceError,
  } = useQuery<SourceCostCenterAllocation>({
    queryKey: key,
    queryFn: () =>
      readCostCenterApi<SourceCostCenterAllocation>(apiBase + "/allocations/" + sourceType + "/" + entry.entryId),
    enabled: !!companyId,
  });
  const { data: catalog, isLoading: loadingCatalog } = useQuery<CostCenterCatalog>({
    queryKey: [apiBase, companyId, true],
    queryFn: () => readCostCenterApi<CostCenterCatalog>(apiBase + "?includeArchived=true"),
    enabled: !!companyId,
    staleTime: 30000,
  });
  useEffect(() => {
    if (!source || dirty) return;
    setDraft(
      source.splits.map((s) => ({
        costCenterId: String(s.costCenterId),
        amountNative: s.amountNative,
      }))
    );
  }, [source, dirty]);
  const hasAutoSplits = source?.splits.some((s) => s.allocationOrigin === "AUTO") ?? false;
  const nativeTotal = d(source?.totalNative || entry.amountNative);
  const baseTotal = d(source?.totalBase || entry.amountBase);
  const usedNative = useMemo(
    () => draft.reduce((sum, split) => sum.plus(d(split.amountNative)), new Decimal(0)),
    [draft]
  );
  const remainder = nativeTotal.minus(usedNative);
  const duplicated =
    new Set(draft.map((s) => s.costCenterId).filter(Boolean)).size !== draft.filter((s) => s.costCenterId).length;
  const invalid = draft.some(
    (s) => !s.costCenterId || !/^(?:0|[1-9]\d{0,13})(?:\.\d{1,6})?$/.test(s.amountNative) || !d(s.amountNative).gt(0)
  );
  const archived = new Set((catalog?.costCenters || []).filter((c) => !c.active).map((c) => String(c.id)));
  const includesArchived = draft.some((s) => archived.has(s.costCenterId));
  const valid =
    !invalid &&
    !duplicated &&
    !includesArchived &&
    !remainder.lt(0) &&
    !baseTotal.lt(0) &&
    nativeTotal.gt(0) &&
    reason.trim().length >= 3 &&
    reason.trim().length <= 500;
  function change(index: number, update: Partial<DraftSplit>) {
    setDirty(true);
    setDraft((old) => old.map((item, i) => (i === index ? { ...item, ...update } : item)));
  }
  function toPayload() {
    let allocatedBase = new Decimal(0);
    const splits = draft.map((s, i) => {
      const native = d(s.amountNative);
      let base = native.times(baseTotal).div(nativeTotal).toDecimalPlaces(6);
      // Eliminate any final rounding remainder when the entire native amount is assigned.
      if (i === draft.length - 1 && remainder.eq(0)) base = baseTotal.minus(allocatedBase);
      allocatedBase = allocatedBase.plus(base);
      return {
        costCenterId: Number(s.costCenterId),
        amountNative: native.toFixed(6),
        amountBase: base.toFixed(6),
        costTreatment: entry.costTreatment,
      };
    });
    return { reason: reason.trim(), splits };
  }
  const save = useMutation({
    mutationFn: () =>
      writeCostCenterApi("PUT", apiBase + "/allocations/" + sourceType + "/" + entry.entryId, toPayload()),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: [apiBase, companyId] });
      await onSaved();
      toast({ title: "Cost centers saved", description: "The posted voucher and account balances were not changed." });
      onClose();
    },
    onError: (e) => toast({ title: "Cannot save allocation", description: apiError(e), variant: "destructive" }),
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !save.isPending) onClose();
      }}
    >
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto" data-testid="cost-center-split-dialog">
        <DialogHeader>
          <DialogTitle>Cost Center — {entry.accountName}</DialogTitle>
          <DialogDescription>
            Analytical allocation for{" "}
            {entry.costTreatment === "INVENTORY_COST" ? "capitalized inventory cost" : "recognized expense"} #
            {entry.entryId}. This does not post another expense or alter inventory valuation.
          </DialogDescription>
        </DialogHeader>
        {loadingSource || loadingCatalog ? (
          <p className="text-sm text-muted-foreground">Loading allocation data…</p>
        ) : sourceError ? (
          <p role="alert" className="text-sm text-destructive">
            {apiError(sourceError)}
          </p>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 text-sm rounded-md bg-muted/40 p-3">
              <div>
                <div className="text-muted-foreground">Original expense</div>
                <div className="font-semibold">{money(nativeTotal.toString(), entry.currency)}</div>
              </div>
              <div>
                <div className="text-muted-foreground">Historical USD amount</div>
                <div className="font-semibold">{money(baseTotal.toString(), "USD")}</div>
              </div>
            </div>
            {hasAutoSplits && (
              <p className="text-xs text-muted-foreground">
                These splits were assigned automatically. Saving any manual change overrides automation for this entry,
                including clearing all splits.
              </p>
            )}
            {draft.map((split, index) => (
              <div key={index} className="flex flex-col sm:flex-row gap-2 items-end rounded-md border p-3">
                <div className="space-y-1.5 flex-1 w-full min-w-0">
                  <Label htmlFor={"cc-entry-" + index}>Cost Center</Label>
                  <Select
                    value={split.costCenterId}
                    onValueChange={(value) => change(index, { costCenterId: value })}
                    disabled={!canEdit}
                  >
                    <SelectTrigger id={"cc-entry-" + index}>
                      <SelectValue placeholder="Choose cost center" />
                    </SelectTrigger>
                    <SelectContent>
                      {(catalog?.costCenters || [])
                        .filter((c) => c.active || String(c.id) === split.costCenterId)
                        .map((c) => (
                          <SelectItem key={c.id} value={String(c.id)} disabled={!c.active}>
                            {c.code} — {c.name}
                            {!c.active ? " (archived)" : ""}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5 w-full sm:w-36">
                  <Label htmlFor={"cc-amount-" + index}>Amount ({entry.currency})</Label>
                  <Input
                    id={"cc-amount-" + index}
                    inputMode="decimal"
                    value={split.amountNative}
                    onChange={(e) => change(index, { amountNative: e.target.value })}
                    disabled={!canEdit}
                    placeholder="0.00"
                  />
                </div>
                <div className="space-y-1.5 w-full sm:w-20">
                  <Label htmlFor={"cc-percent-" + index}>%</Label>
                  <Input
                    id={"cc-percent-" + index}
                    inputMode="decimal"
                    disabled={!canEdit}
                    value={
                      nativeTotal.gt(0)
                        ? d(split.amountNative).times(100).div(nativeTotal).toDecimalPlaces(2).toString()
                        : "0"
                    }
                    onChange={(e) =>
                      change(index, {
                        amountNative: d(e.target.value).times(nativeTotal).div(100).toDecimalPlaces(6).toString(),
                      })
                    }
                  />
                </div>
                {canEdit && (
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Remove allocation"
                    onClick={() => {
                      setDirty(true);
                      setDraft((s) => s.filter((_, i) => i !== index));
                    }}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                )}
              </div>
            ))}
            {canEdit && (
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setDirty(true);
                    setDraft((s) => [...s, emptySplit()]);
                  }}
                >
                  <Plus className="w-4 h-4 mr-1" /> Add split
                </Button>
                {draft.length === 1 && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => change(0, { amountNative: nativeTotal.toFixed(6) })}
                  >
                    Assign full amount
                  </Button>
                )}
              </div>
            )}
            <div className="rounded-md border p-3 text-sm flex flex-wrap gap-4 justify-between">
              <span>
                Allocated: <strong>{money(usedNative.toString(), entry.currency)}</strong>
              </span>
              <span>
                Unallocated:{" "}
                <strong className={remainder.lt(0) ? "text-destructive" : ""}>
                  {money(remainder.toString(), entry.currency)}
                </strong>
              </span>
            </div>
            {duplicated && (
              <p role="alert" className="text-sm text-destructive">
                Select each cost center once.
              </p>
            )}
            {includesArchived && (
              <p role="alert" className="text-sm text-destructive">
                Archived centers cannot receive new allocations. Remove or replace them first.
              </p>
            )}
            {remainder.lt(0) && (
              <p role="alert" className="text-sm text-destructive">
                Allocated amount exceeds the source expense.
              </p>
            )}
            {canEdit && (
              <div className="space-y-1.5">
                <Label htmlFor="cc-reason">Reason for change</Label>
                <Input
                  id="cc-reason"
                  value={reason}
                  maxLength={500}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Accounting allocation reason"
                />
              </div>
            )}
          </div>
        )}
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={save.isPending}>
            Close
          </Button>
          {canEdit && (
            <Button onClick={() => save.mutate()} disabled={!source || !valid || save.isPending || loadingCatalog}>
              {save.isPending ? "Saving…" : "Save Allocation"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Reuses the authoritative posted voucher lines in both ERP Voucher Detail and Daybook dialog. */
export function VoucherCostCenters({ voucherId }: { voucherId: number }) {
  const { selectedCompany } = useCompany();
  const isFactory = useAppMode() === "factory";
  const apiBase = isFactory ? "/api/factory/cost-centers" : "/api/cost-centers";
  const companyId = selectedCompany?.id;
  const role = selectedCompany?.role || "";
  const canEdit = ["Admin", "Owner", "Developer"].includes(role);
  const canRead = canEdit || role === "Manager";
  const [selected, setSelected] = useState<VoucherExpenseEntry | null>(null);
  const key = [apiBase, companyId, "voucher", voucherId, "entries"];
  const { data, isLoading, isError, error, refetch } = useQuery<VoucherExpenseEntries>({
    queryKey: key,
    queryFn: () => readCostCenterApi<VoucherExpenseEntries>(apiBase + "/voucher/" + voucherId + "/entries"),
    enabled: canRead && !!companyId && Number.isInteger(voucherId) && voucherId > 0,
    staleTime: 30000,
  });
  const entries = data?.entries || [];
  if (!canRead) return null;
  if (isLoading) return <p className="text-xs text-muted-foreground">Loading cost center allocations…</p>;
  if (isError && notInstalled(error)) return null;
  if (isError)
    return (
      <p role="alert" className="text-sm text-destructive">
        Cost center allocations unavailable: {apiError(error)}
      </p>
    );
  if (!entries.length) return null;
  return (
    <section className="rounded-md border p-3 space-y-3" aria-label="Voucher cost center allocations">
      <div className="flex flex-wrap justify-between items-center gap-2">
        <div>
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <Layers3 className="h-4 w-4" /> Cost Centers
          </h3>
          <p className="text-xs text-muted-foreground">
            Assigned to eligible posted expense entries{isFactory ? " or factory inventory-cost accounts" : ""}; never
            to payment accounts.
          </p>
        </div>
      </div>
      <div className="space-y-2">
        {entries.map((entry) => {
          const unallocated = d(entry.amountNative).minus(d(entry.allocatedNative));
          return (
            <div
              key={entry.entryId}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/30 p-2 text-sm"
            >
              <div className="min-w-0 flex-1">
                <div className="font-medium">
                  {entry.accountName} <span className="text-xs text-muted-foreground">#{entry.entryId}</span>
                </div>
                {entry.costTreatment === "INVENTORY_COST" && (
                  <p className="text-xs text-muted-foreground">Inventory cost (not an operating expense)</p>
                )}
                <div className="text-xs text-muted-foreground">
                  {money(entry.amountNative, entry.currency)} · Unallocated{" "}
                  {money(unallocated.toString(), entry.currency)}
                </div>
              </div>
              {entry.allocationCount > 0 && <Badge variant="secondary">{entry.allocationCount} assigned</Badge>}
              <Button size="sm" variant="outline" onClick={() => setSelected(entry)}>
                {canEdit ? "Assign / Split" : "View"}
              </Button>
            </div>
          );
        })}
      </div>
      {selected && (
        <CostCenterEntryEditor
          key={selected.entryId}
          entry={selected}
          apiBase={apiBase}
          onClose={() => setSelected(null)}
          onSaved={async () => {
            await refetch();
          }}
        />
      )}
    </section>
  );
}
