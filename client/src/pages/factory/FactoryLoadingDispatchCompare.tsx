import { Loader2 } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";

import { printNumber } from "./FactoryLoadingDispatchCompareParts";
import { useFactoryLoadingDispatchCompareState2 } from "./FactoryLoadingDispatchCompareCardSection";
import { FactoryLoadingDispatchCompareContent } from "./FactoryLoadingDispatchCompareContent";

export default function FactoryLoadingDispatchCompare() {
  const {
    allTripsEnded,
    canReconcile,
    companyId,
    comparison,
    filter,
    financialReconciliation,
    isSupervisor,
    missingFromLoading,
    navigate,
    orderId,
    refreshAllReconciliation,
    removalReason,
    removeConfirmed,
    removeOpen,
    removeSelected,
    removing,
    result,
    rows,
    s,
    search,
    selectAllMissing,
    selectedCurrent,
    selectedId,
    selectedKg,
    setFilter,
    setRemovalReason,
    setRemoveConfirmed,
    setRemoveOpen,
    setSearch,
    setSelectedMissing,
    setVisibleCount,
    valid,
    visibleCount,
  } = useFactoryLoadingDispatchCompareState2();

  if (!valid) {
    return <div className="p-6 text-sm text-destructive">Invalid loading or dispatch number.</div>;
  }

  return (
    <div
      className="h-full min-w-0 overflow-y-auto bg-slate-50/80 p-3 pb-10 dark:bg-[hsl(var(--factory-hue)_56%_7%)] sm:p-5 lg:p-7"
      data-testid="factory-dispatch-comparison-page"
    >
      <FactoryLoadingDispatchCompareContent
        allTripsEnded={allTripsEnded}
        canReconcile={canReconcile}
        companyId={companyId}
        comparison={comparison}
        filter={filter}
        financialReconciliation={financialReconciliation}
        isSupervisor={isSupervisor}
        missingFromLoading={missingFromLoading}
        navigate={navigate}
        orderId={orderId}
        refreshAllReconciliation={refreshAllReconciliation}
        removing={removing}
        result={result}
        rows={rows}
        s={s}
        search={search}
        selectAllMissing={selectAllMissing}
        selectedCurrent={selectedCurrent}
        selectedId={selectedId}
        setFilter={setFilter}
        setRemoveOpen={setRemoveOpen}
        setSearch={setSearch}
        setSelectedMissing={setSelectedMissing}
        setVisibleCount={setVisibleCount}
        visibleCount={visibleCount}
      />
      <Dialog
        open={removeOpen}
        onOpenChange={(open) => {
          if (!removing) setRemoveOpen(open);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Confirm missing-bale removal</DialogTitle>
            <DialogDescription>
              Remove {selectedCurrent.length} unscanned bale(s), totalling {printNumber(selectedKg, 3)} kg, from Pending
              Loading? They will return to stock using the existing loading correction process. Dispatch scan history
              remains unchanged.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="dispatch-shortfall-reason">Reason for removing the unshipped bales</Label>
            <Textarea
              id="dispatch-shortfall-reason"
              rows={3}
              maxLength={1000}
              value={removalReason}
              onChange={(e) => setRemovalReason(e.target.value)}
              placeholder="All trucks are closed; these bales were never physically loaded…"
            />
            <label className="flex items-start gap-2 rounded-md border p-3 text-xs">
              <Checkbox checked={removeConfirmed} onCheckedChange={(v) => setRemoveConfirmed(v === true)} />
              <span>
                I reviewed the selected exact bale references and authorize returning only unshipped bales to stock as
                one atomic correction.
              </span>
            </label>
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" disabled={removing} onClick={() => setRemoveOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={
                !canReconcile ||
                removing ||
                selectedCurrent.length === 0 ||
                removalReason.trim().length < 10 ||
                removalReason.trim().length > 1000 ||
                !removeConfirmed
              }
              onClick={() => void removeSelected()}
              data-testid="button-confirm-remove-missing-bales"
            >
              {removing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Confirm removal
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
