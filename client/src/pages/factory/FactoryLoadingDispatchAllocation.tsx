import { AlertTriangle, ClipboardList, Info, Loader2, RefreshCw, Save, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { failMessage, type Props } from "./FactoryLoadingDispatchAllocationTypes";
import { useFactoryLoadingDispatchAllocationState } from "./useFactoryLoadingDispatchAllocationState";
import { FactoryLoadingDispatchAllocationSection } from "./FactoryLoadingDispatchAllocationSection";
function fmt(n: number): string {
  return Number(n || 0).toLocaleString();
}

export default function FactoryLoadingDispatchAllocation(props: Props) {
  const {
    allocation,
    articles,
    autoPick,
    baleArticle,
    baleQuery,
    candidates,
    changed,
    dirty,
    editable,
    filteredBales,
    loaded,
    planned,
    preview,
    resync,
    save,
    selected,
    setAutoPick,
    setBaleArticle,
    setBaleIds,
    setBaleQuery,
    setDirty,
    setShowBales,
    setVisibleBales,
    showBales,
    taken,
    targets,
    toggle,
    visibleBales,
  } = useFactoryLoadingDispatchAllocationState(props);

  return (
    <Card
      className="min-w-0 border-blue-200 bg-white dark:border-blue-500/30 dark:bg-[hsl(var(--factory-hue)_53%_13%)]"
      data-testid="dispatch-allocation-planner"
    >
      <CardContent className="space-y-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <ClipboardList className="h-5 w-5 text-blue-600" />
              <h3 className="text-base font-bold">Expected Truck Load</h3>
              <Badge variant="outline">Phase 5</Badge>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Assign article quantities and optional exact bale references to this truck. These plans do not move stock
              or change main loading.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {dirty && <Badge variant="secondary">Unsaved changes</Badge>}
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={resync}
              disabled={save.isPending}
              data-testid="button-refresh-dispatch-allocation"
            >
              <RefreshCw className="mr-1.5 h-4 w-4" /> {dirty ? "Discard edits" : "Refresh"}
            </Button>
          </div>
        </div>

        {allocation.isError && (
          <div className="rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/20">
            {failMessage(allocation.error)}
          </div>
        )}
        {allocation.isLoading && (
          <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Reading loading quantities and other truck reservations…
          </div>
        )}
        {allocation.data && (
          <>
            {allocation.data.priority ? (
              <div className="flex flex-wrap items-center gap-2 rounded-xl border border-blue-200 bg-blue-50/60 p-3 text-xs dark:border-blue-500/30 dark:bg-blue-500/10">
                <span
                  className="inline-block h-3.5 w-3.5 rounded-full border"
                  style={{ backgroundColor: allocation.data.priority.color }}
                />
                <span className="font-semibold">Loading queue priority #{allocation.data.priority.orderPriority}</span>
                <Badge variant="outline">
                  {allocation.data.priority.enabled ? "Priority Scan enabled" : "Last saved priority"}
                </Badge>
                <span className="text-muted-foreground">
                  Article rows follow the linked proforma / loading order, not separate color priorities.
                </span>
              </div>
            ) : (
              <div className="flex items-start gap-2 rounded-xl border p-3 text-xs text-muted-foreground">
                <Info className="mt-0.5 h-4 w-4 shrink-0" />
                No active Priority Scan queue entry for this loading. The article order still follows the linked
                proforma or loading lines.
              </div>
            )}

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {(
                [
                  ["Loaded", loaded],
                  ["Reserved other trucks", taken],
                  ["Saved target", planned],
                  ["Selected exact bales", selected.size],
                ] as const
              ).map(([label, value]) => (
                <div key={label} className="rounded-xl bg-slate-50 p-3 dark:bg-[hsl(var(--factory-hue)_63%_11%)]">
                  <p className="text-[11px] text-muted-foreground">{label}</p>
                  <p className="mt-1 font-mono text-lg font-bold">{fmt(value)}</p>
                </div>
              ))}
            </div>

            <div className="overflow-x-auto rounded-xl border dark:border-slate-700">
              <table className="w-full min-w-[640px] text-left text-xs">
                <thead className="bg-slate-100 dark:bg-[hsl(var(--factory-hue)_61%_11%)]">
                  <tr>
                    <th className="px-3 py-2">Article (proforma order)</th>
                    <th className="px-3 py-2 text-right">Loaded</th>
                    <th className="px-3 py-2 text-right">Others reserved</th>
                    <th className="px-3 py-2 text-right">Available</th>
                    <th className="px-3 py-2 text-right">Verified here</th>
                    <th className="px-3 py-2 text-right">Expected on this truck</th>
                  </tr>
                </thead>
                <tbody>
                  {articles.map((a) => (
                    <tr key={a.articleCode} className="border-t dark:border-slate-700">
                      <td className="px-3 py-2">
                        <p className="font-mono font-semibold">{a.articleCode}</p>
                        <p className="max-w-56 truncate text-muted-foreground">{a.productName || "—"}</p>
                      </td>
                      <td className="px-3 py-2 text-right font-mono">{fmt(a.loadedQty)}</td>
                      <td className="px-3 py-2 text-right font-mono">{fmt(a.reservedOtherQty)}</td>
                      <td className="px-3 py-2 text-right font-mono">{fmt(a.availableQty)}</td>
                      <td className="px-3 py-2 text-right font-mono">{fmt(a.scannedHereQty)}</td>
                      <td className="px-3 py-2 text-right">
                        <Input
                          type="number"
                          min={0}
                          max={a.availableQty}
                          step={1}
                          className="ml-auto h-9 w-24 text-right font-mono"
                          aria-label={"Expected " + a.articleCode}
                          value={targets[a.articleCode] ?? "0"}
                          disabled={!editable || save.isPending}
                          onChange={(e) => changed(a.articleCode, e.target.value)}
                          data-testid={"input-dispatch-target-" + a.articleCode}
                        />
                      </td>
                    </tr>
                  ))}
                  {articles.length === 0 && (
                    <tr>
                      <td colSpan={6} className="p-5 text-center text-muted-foreground">
                        No bales have been added to the main loading yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-3 dark:border-slate-700">
              <div className="min-w-0">
                <p className="text-sm font-semibold">Auto-pick exact bale references</p>
                <p className="text-xs text-muted-foreground">
                  Keep already scanned bales here, then reserve available references in article/proforma order to fill
                  the quantities.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                {editable && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={save.isPending}
                    onClick={() => {
                      setBaleIds(candidates.filter((bale) => bale.scannedHere).map((bale) => bale.baleId));
                      setAutoPick(true);
                      setDirty(true);
                    }}
                    title="Clear unscanned exact reservations and rebuild using current targets when saved"
                    data-testid="button-rebalance-dispatch-plan"
                  >
                    <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Rebalance refs
                  </Button>
                )}
                <label className="flex items-center gap-2 text-sm font-medium">
                  <Checkbox
                    checked={autoPick}
                    onCheckedChange={(checked) => {
                      setAutoPick(checked === true);
                      setDirty(true);
                    }}
                    disabled={!editable || save.isPending}
                    data-testid="checkbox-dispatch-autopick"
                  />
                  Auto-pick
                </label>
              </div>
            </div>

            <FactoryLoadingDispatchAllocationSection
              articles={articles}
              baleArticle={baleArticle}
              baleQuery={baleQuery}
              editable={editable}
              filteredBales={filteredBales}
              save={save}
              selected={selected}
              setBaleArticle={setBaleArticle}
              setBaleQuery={setBaleQuery}
              setShowBales={setShowBales}
              setVisibleBales={setVisibleBales}
              showBales={showBales}
              toggle={toggle}
              visibleBales={visibleBales}
            />

            {!preview.valid && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:bg-amber-950/20 dark:text-amber-200"
              >
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {preview.warning}
              </div>
            )}
            {editable ? (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-muted-foreground">
                  Draft target: <strong>{fmt(preview.expected)}</strong> bales ·{" "}
                  {autoPick ? "exact refs auto-picked" : "exact refs manual only"}
                </p>
                <Button
                  disabled={!dirty || save.isPending || !preview.valid}
                  onClick={() => void save.mutate()}
                  data-testid="button-save-dispatch-allocation"
                >
                  {save.isPending ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Save className="mr-2 h-4 w-4" />
                  )}
                  Save expected truck load
                </Button>
              </div>
            ) : (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <ShieldCheck className="h-4 w-4" /> Only Admin, Owner or Developer can change expected loads on open
                dispatches.
              </p>
            )}
            {dirty && (
              <p className="flex items-center gap-2 text-xs text-blue-600 dark:text-sky-300">
                <Info className="h-3.5 w-3.5" /> Unsaved targets do not affect the scanner or comparison until saved.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
