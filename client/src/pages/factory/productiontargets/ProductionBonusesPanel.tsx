import { Coins, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { money } from "./ProductionBonusesPanelTypes";
import { useProductionBonusesPanelState } from "./useProductionBonusesPanelState";
import { ProductionBonusesPanelCardContent } from "./ProductionBonusesPanelCardContent";

/**
 * Production Targets bonus review — NOT a payout surface.
 * The server is the sole calculation/authorization authority.
 */
export function ProductionBonusesPanel(props: { initialDate: string }) {
  const {
    allVisibleSelected,
    canApproveSelected,
    confirmDecision,
    data,
    eligible,
    end,
    error,
    filter,
    isLoading,
    rangeValid,
    rateDate,
    rateInput,
    rateMutation,
    rateWorker,
    reviewMutation,
    search,
    selected,
    selectedAmount,
    selectedRows,
    setConfirmDecision,
    setEnd,
    setFilter,
    setRateDate,
    setRateInput,
    setRateWorker,
    setSearch,
    setSelected,
    setStart,
    start,
    visible,
    workerBreakdown,
  } = useProductionBonusesPanelState(props);

  // Keep worker compensation information entirely out of non-admin UI.
  if (data && !data.canDecide) return null;

  return (
    <Card className="overflow-hidden shadow-none" data-testid="production-bonuses-panel">
      <CardHeader className="space-y-1 border-b bg-muted/20 pb-4">
        <div className="flex items-center gap-2">
          <Coins className="h-5 w-5 text-primary" />
          <CardTitle className="text-lg">Production Bonuses</CardTitle>
        </div>
        <p className="text-sm text-muted-foreground">
          Review today's live production or finalized dates. A daily per-bale bonus can be approved before End
          Production; approval locks the current target, credited bales and USD amount. Weekly-flat bonuses still
          require completed, reconciled weeks. Approval does not pay.
        </p>
      </CardHeader>
      <ProductionBonusesPanelCardContent
        allVisibleSelected={allVisibleSelected}
        canApproveSelected={canApproveSelected}
        data={data}
        eligible={eligible}
        end={end}
        error={error}
        filter={filter}
        isLoading={isLoading}
        rangeValid={rangeValid}
        reviewMutation={reviewMutation}
        search={search}
        selected={selected}
        selectedAmount={selectedAmount}
        selectedRows={selectedRows}
        setConfirmDecision={setConfirmDecision}
        setEnd={setEnd}
        setFilter={setFilter}
        setRateDate={setRateDate}
        setRateInput={setRateInput}
        setRateWorker={setRateWorker}
        setSearch={setSearch}
        setSelected={setSelected}
        setStart={setStart}
        start={start}
        visible={visible}
        workerBreakdown={workerBreakdown}
      />

      <Dialog
        open={rateWorker != null}
        onOpenChange={(open) => {
          if (!open) setRateWorker(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Worker rate per extra bale</DialogTitle>
            <DialogDescription>
              This rate applies from the selected date onward. Reviewed bonus records cannot be recalculated.
            </DialogDescription>
          </DialogHeader>
          <p className="font-medium">{rateWorker?.workerName}</p>
          <label className="space-y-1 text-sm">
            Effective from
            <Input
              aria-label="Bonus rate effective date"
              type="date"
              value={rateDate}
              onChange={(event) => setRateDate(event.target.value)}
            />
          </label>
          <label className="space-y-1 text-sm">
            Rate per extra bale ($)
            <Input
              aria-label="Bonus rate per bale"
              type="number"
              inputMode="decimal"
              min="0.0001"
              step="0.0001"
              value={rateInput}
              onChange={(event) => setRateInput(event.target.value)}
            />
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRateWorker(null)}>
              Cancel
            </Button>
            <Button
              disabled={rateMutation.isPending || !rateInput || Number(rateInput) <= 0}
              onClick={() => rateMutation.mutate()}
            >
              {rateMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Save rate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={confirmDecision != null}
        onOpenChange={(open) => {
          if (!open) setConfirmDecision(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmDecision === "approved"
                ? "Confirm production bonus approval"
                : "Confirm production bonus rejection"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              You are about to {confirmDecision === "approved" ? "approve" : "reject"} {selectedRows.length}
              {selectedRows.length === 1 ? " worker bonus" : " worker bonuses"} totaling {money(selectedAmount)}. This
              saves an immutable historical decision. No money is paid or posted now.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={reviewMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={reviewMutation.isPending || selectedRows.length === 0}
              onClick={(event) => {
                event.preventDefault();
                if (confirmDecision) reviewMutation.mutate(confirmDecision);
              }}
            >
              {reviewMutation.isPending ? "Saving..." : "Confirm decision"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
