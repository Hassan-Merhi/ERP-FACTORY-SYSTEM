// Extracted from ./FactoryLoadingDispatchAllocation.tsx to keep that module under the source-size cap.
import { Package, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { PAGE_SIZE } from "./FactoryLoadingDispatchAllocationTypes";
import { useFactoryLoadingDispatchAllocationState } from "./useFactoryLoadingDispatchAllocationState";

export function FactoryLoadingDispatchAllocationSection({
  articles,
  baleArticle,
  baleQuery,
  editable,
  filteredBales,
  save,
  selected,
  setBaleArticle,
  setBaleQuery,
  setShowBales,
  setVisibleBales,
  showBales,
  toggle,
  visibleBales,
}: Pick<
  ReturnType<typeof useFactoryLoadingDispatchAllocationState>,
  | "articles"
  | "baleArticle"
  | "baleQuery"
  | "editable"
  | "filteredBales"
  | "save"
  | "selected"
  | "setBaleArticle"
  | "setBaleQuery"
  | "setShowBales"
  | "setVisibleBales"
  | "showBales"
  | "toggle"
  | "visibleBales"
>) {
  return (
    <div className="overflow-hidden rounded-xl border dark:border-slate-700">
      <button
        type="button"
        onClick={() => setShowBales((v) => !v)}
        className="flex w-full flex-wrap items-center justify-between gap-2 px-3 py-3 text-left text-sm font-semibold hover:bg-muted/30"
        data-testid="button-dispatch-manual-bales"
      >
        <span className="flex items-center gap-2">
          <Package className="h-4 w-4 text-blue-500" />
          Choose specific bale references
          <Badge variant="secondary">{selected.size} chosen</Badge>
        </span>
        <span className="text-xs text-muted-foreground">{showBales ? "Collapse" : "Expand"}</span>
      </button>
      {showBales && (
        <div className="space-y-3 border-t p-3 dark:border-slate-700">
          <div className="flex flex-wrap gap-2">
            <div className="relative min-w-[200px] flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="h-9 pl-9"
                placeholder="Search reference or article"
                value={baleQuery}
                onChange={(e) => {
                  setBaleQuery(e.target.value);
                  setVisibleBales(PAGE_SIZE);
                }}
              />
            </div>
            <select
              className="h-9 max-w-48 rounded-lg border bg-background px-3 text-xs"
              value={baleArticle}
              onChange={(e) => {
                setBaleArticle(e.target.value);
                setVisibleBales(PAGE_SIZE);
              }}
              aria-label="Filter bale article"
            >
              <option value="all">All articles</option>
              {articles.map((a) => (
                <option key={a.articleCode} value={a.articleCode}>
                  {a.articleCode}
                </option>
              ))}
            </select>
          </div>
          <p className="text-xs text-muted-foreground">
            Manual picks are reserved in addition to any auto-filled references. Bales already assigned or verified on
            other trucks cannot be selected.
          </p>
          <div className="max-h-[380px] overflow-y-auto rounded-lg border dark:border-slate-700">
            {filteredBales.slice(0, visibleBales).map((b) => {
              const blocked = Boolean(b.assignedElsewhere && !b.assignedHere);
              return (
                <label
                  key={b.baleId}
                  className={
                    "flex flex-wrap items-center gap-3 border-b p-2.5 text-xs last:border-b-0 dark:border-slate-700 " +
                    (blocked ? "opacity-60" : "hover:bg-blue-50/50 dark:hover:bg-blue-500/10")
                  }
                >
                  <Checkbox
                    checked={selected.has(b.baleId)}
                    disabled={!editable || save.isPending || blocked || b.scannedHere}
                    onCheckedChange={(checked) => toggle(b.baleId, checked === true)}
                    aria-label={"Assign " + b.baleReference}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block font-mono font-semibold">{b.baleReference || "Bale #" + b.baleId}</span>
                    <span className="text-muted-foreground">
                      {b.articleCode} · {b.productName || "Bale"} · {b.weightKg} kg
                    </span>
                  </span>
                  {b.scannedHere ? (
                    <Badge variant="outline" className="border-emerald-400 text-emerald-600">
                      Scanned here
                    </Badge>
                  ) : blocked ? (
                    <Badge variant="outline">Dispatch #{b.assignedElsewhere?.dispatchNumber}</Badge>
                  ) : b.assignedHere ? (
                    <Badge variant="secondary">Reserved here</Badge>
                  ) : null}
                </label>
              );
            })}
            {filteredBales.length === 0 && (
              <p className="p-4 text-center text-xs text-muted-foreground">No loaded bales match the filter.</p>
            )}
          </div>
          {filteredBales.length > visibleBales && (
            <Button size="sm" variant="outline" onClick={() => setVisibleBales((v) => v + PAGE_SIZE)}>
              Show next {Math.min(PAGE_SIZE, filteredBales.length - visibleBales)}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
