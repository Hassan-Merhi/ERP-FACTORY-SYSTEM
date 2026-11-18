// Extracted from ./CostCenterHistorical.tsx to keep that module under the source-size cap.
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ClipboardCheck, Plus, RefreshCw, Trash2 } from "lucide-react";
import { err, fmt } from "./CostCenterHistoricalTypes";
import { useCostCenterHistoricalState } from "./useCostCenterHistoricalState";

export function CostCenterHistoricalSection({
  reconError,
  reconErrorText,
  reconLoading,
  reconciliation,
  refreshRecon,
}: Pick<
  ReturnType<typeof useCostCenterHistoricalState>,
  "reconError" | "reconErrorText" | "reconLoading" | "reconciliation" | "refreshRecon"
>) {
  return (
    <div className="rounded-md border p-3 space-y-2">
      <div className="flex gap-2 items-center justify-between">
        <h3 className="text-sm font-semibold">Historical Expense Reconciliation</h3>
        <Button variant="ghost" size="sm" onClick={() => void refreshRecon()}>
          <RefreshCw className="h-3 w-3 mr-1" /> Refresh
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Control totals cover eligible posted expense debit sources only, not your complete general ledger or P&L.
        Existing allocations stay linked to their original historical USD values.
      </p>
      {reconLoading && <p className="text-sm text-muted-foreground">Reading source control totals…</p>}
      {reconError && (
        <p role="alert" className="text-sm text-destructive">
          {err(reconErrorText)}
        </p>
      )}
      {reconciliation && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
          <div>
            <p className="text-xs text-muted-foreground">Eligible sources</p>
            <p className="font-semibold">{reconciliation.sourceCount}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Source book value USD</p>
            <p className="font-mono font-semibold">{fmt(reconciliation.postedUsd)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Allocated USD</p>
            <p className="font-mono font-semibold">{fmt(reconciliation.allocatedUsd)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Unallocated USD</p>
            <p className="font-mono font-semibold">{fmt(reconciliation.unallocatedUsd)}</p>
          </div>
          {reconciliation.overallocatedSources > 0 && (
            <p role="alert" className="text-sm text-destructive col-span-full">
              {reconciliation.overallocatedSources} source allocations exceed their USD book value; resolve before
              approving a new batch.
            </p>
          )}
        </div>
      )}
      {reconciliation && reconciliation.nativeCurrencies.length > 0 && (
        <div className="overflow-x-auto border rounded-md">
          <p className="px-2 pt-2 text-xs font-semibold">Original-currency control totals (no FX revaluation)</p>
          <table className="text-xs w-full min-w-[480px]">
            <thead>
              <tr className="text-left">
                <th className="p-2">Currency</th>
                <th className="p-2 text-right">Source</th>
                <th className="p-2 text-right">Assigned</th>
                <th className="p-2 text-right">Unallocated</th>
              </tr>
            </thead>
            <tbody>
              {reconciliation.nativeCurrencies.map((row) => (
                <tr key={row.currency} className="border-t">
                  <td className="p-2">{row.currency}</td>
                  <td className="p-2 text-right font-mono">{fmt(row.sourceNative)}</td>
                  <td className="p-2 text-right font-mono">{fmt(row.allocatedNative)}</td>
                  <td className="p-2 text-right font-mono">
                    {fmt(row.unallocatedNative)}
                    {row.overallocatedSources > 0 && (
                      <span className="block text-destructive">Overallocated: {row.overallocatedSources}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function CostCenterHistoricalSection2({
  applyWrite,
  centers,
  changeSplit,
  invalidatePreview,
  pctTotal,
  previewWrite,
  reason,
  setReason,
  setSplits,
  splits,
  valid,
}: Pick<
  ReturnType<typeof useCostCenterHistoricalState>,
  | "applyWrite"
  | "centers"
  | "changeSplit"
  | "invalidatePreview"
  | "pctTotal"
  | "previewWrite"
  | "reason"
  | "setReason"
  | "setSplits"
  | "splits"
  | "valid"
>) {
  return (
    <div className="rounded-md border p-3 space-y-3">
      <h3 className="text-sm font-semibold">Manual Bulk Allocation</h3>
      <p className="text-xs text-muted-foreground">
        Applies only to fully unallocated, active, unreversed eligible expense debit entries. Payments, intercompany
        records, migrated/protected vouchers, pending loadings and inventory asset movements are excluded.
      </p>
      {splits.map((split, index) => (
        <div key={index} className="flex flex-wrap gap-2 items-end">
          <div className="space-y-1 flex-1 min-w-[160px]">
            <Label>Cost Center</Label>
            <Select value={split.costCenterId} onValueChange={(v) => changeSplit(index, { costCenterId: v })}>
              <SelectTrigger>
                <SelectValue placeholder="Choose active center" />
              </SelectTrigger>
              <SelectContent>
                {centers
                  .filter((c) => c.active)
                  .map((c) => (
                    <SelectItem key={c.id} value={String(c.id)}>
                      {c.code} — {c.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1 w-28">
            <Label>Percent</Label>
            <Input
              inputMode="decimal"
              value={split.percent}
              onChange={(e) => changeSplit(index, { percent: e.target.value })}
            />
          </div>
          <Button
            title="Remove split"
            size="icon"
            variant="ghost"
            onClick={() => {
              invalidatePreview();
              setSplits((s) => s.filter((_, i) => i !== index));
            }}
          >
            <Trash2 className="w-4 h-4" />
          </Button>
        </div>
      ))}
      <div className="flex flex-wrap justify-between items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={splits.length >= 10}
          onClick={() => {
            invalidatePreview();
            setSplits((s) => [...s, { costCenterId: "", percent: "" }]);
          }}
        >
          <Plus className="h-3 w-3 mr-1" /> Add split
        </Button>
        <span className={"text-xs " + (pctTotal.gt(100) ? "text-destructive" : "text-muted-foreground")}>
          {pctTotal.toFixed(4)}% assigned; remaining balance stays Unallocated
        </span>
      </div>
      <div className="space-y-1">
        <Label htmlFor="historical-cc-reason">Required Audit Reason</Label>
        <Input
          id="historical-cc-reason"
          maxLength={500}
          value={reason}
          onChange={(e) => {
            invalidatePreview();
            setReason(e.target.value);
          }}
        />
      </div>
      <Button disabled={!valid || previewWrite.isPending || applyWrite.isPending} onClick={() => previewWrite.mutate()}>
        <ClipboardCheck className="h-4 w-4 mr-2" />
        {previewWrite.isPending ? "Preparing…" : "Preview Historical Allocation (Dry Run)"}
      </Button>
    </div>
  );
}
