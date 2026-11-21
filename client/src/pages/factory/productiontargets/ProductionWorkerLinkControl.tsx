import { Link2, Loader2, Unlink2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { isValidBaleTarget } from "@shared/factoryProductionTargetSplit";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  useProductionWorkerLinkControlState,
  type ProductionWorkerLinkControlProps,
} from "./useProductionWorkerLinkControlState";

export function ProductionWorkerLinkControl({
  row,
  rows,
  effectiveFrom,
  disabled = false,
}: ProductionWorkerLinkControlProps) {
  const {
    tr,
    selectingPartners,
    setSelectingPartners,
    setSelectedPartnerIds,
    selectedPartnerIds,
    partnerSelectValue,
    setPartnerSelectValue,
    unlinkOpen,
    setUnlinkOpen,
    unlinkTarget,
    unlinkDraft,
    setUnlinkDraft,
    remainingSlots,
    unlinkMembers,
    allocatedTotal,
    validSplit,
    fillEvenSplit,
    openUnlinkDialog,
    partnerOptions,
    selectedPartners,
    resetSelection,
    linkMutation,
    unlinkMutation,
    busy,
    canAddPartners,
  } = useProductionWorkerLinkControlState({ row, rows, effectiveFrom });

  if (!selectingPartners) {
    return (
      <>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            disabled={disabled || busy || !canAddPartners}
            onClick={() => setSelectingPartners(true)}
            data-testid={`button-link-worker-${row.personId}`}
          >
            <Link2 className="mr-1 h-3 w-3" />
            {tr("linkWorker")}
          </Button>
          {row.linkGroupId != null && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              disabled={disabled || busy}
              onClick={openUnlinkDialog}
              data-testid={`button-unlink-worker-${row.personId}`}
            >
              {unlinkMutation.isPending ? (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              ) : (
                <Unlink2 className="mr-1 h-3 w-3" />
              )}
              {tr("unlink")}
            </Button>
          )}
        </div>
        <Dialog open={unlinkOpen} onOpenChange={(open) => !busy && setUnlinkOpen(open)}>
          <DialogContent className="max-w-md" data-testid={`dialog-unlink-target-${row.personId}`}>
            <DialogHeader>
              <DialogTitle>{tr("unlinkSplitTitle")}</DialogTitle>
              <DialogDescription>{tr("unlinkSplitDescription")}</DialogDescription>
            </DialogHeader>
            {unlinkTarget === null ? (
              <p className="text-sm text-muted-foreground">{tr("unlinkSplitNoTarget")}</p>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold tabular-nums">
                    {tr("totalTarget")}: {unlinkTarget}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy || !isValidBaleTarget(unlinkTarget)}
                    onClick={() => fillEvenSplit(unlinkTarget)}
                    data-testid={`button-even-split-${row.personId}`}
                  >
                    {tr("unlinkSplitAuto")}
                  </Button>
                </div>
                {unlinkMembers.map((member) => (
                  <div key={member.workerId} className="flex items-center gap-3">
                    <label
                      className="min-w-0 flex-1 truncate text-sm"
                      dir="auto"
                      htmlFor={`unlink-target-${row.personId}-${member.workerId}`}
                    >
                      {member.name}
                    </label>
                    <Input
                      id={`unlink-target-${row.personId}-${member.workerId}`}
                      type="number"
                      min="0"
                      step={Number.isInteger(unlinkTarget) ? "1" : "0.01"}
                      className="w-24 text-right tabular-nums"
                      disabled={busy}
                      value={unlinkDraft[member.workerId] ?? ""}
                      onChange={(event) =>
                        setUnlinkDraft((current) => ({
                          ...current,
                          [member.workerId]: event.target.value,
                        }))
                      }
                      data-testid={`input-unlink-target-${member.workerId}`}
                    />
                  </div>
                ))}
                <div className="text-sm font-medium tabular-nums">
                  {tr("unlinkSplitAllocated")}: {allocatedTotal / 100} / {unlinkTarget}
                </div>
                {!validSplit && (
                  <p className="text-xs text-destructive" role="alert">
                    {tr("unlinkSplitWholeBales")}
                  </p>
                )}
              </div>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={busy} onClick={() => setUnlinkOpen(false)}>
                {tr("cancel")}
              </Button>
              <Button
                type="button"
                disabled={busy || !validSplit}
                onClick={() => unlinkMutation.mutate()}
                data-testid={`button-confirm-unlink-${row.personId}`}
              >
                {unlinkMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {tr("unlinkSplitConfirm")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </>
    );
  }

  return (
    <div className="space-y-1.5">
      {selectedPartners.length > 0 && (
        <div className="flex flex-wrap gap-1" data-testid={`selected-link-partners-${row.personId}`}>
          {selectedPartners.map((partner) => (
            <Badge key={partner.personId} variant="secondary" className="gap-1 pr-1 text-[11px] font-normal">
              <span dir="auto">{partner.name}</span>
              <button
                type="button"
                className="rounded-xs p-0.5 hover:bg-muted"
                disabled={disabled || busy}
                onClick={() =>
                  setSelectedPartnerIds((current) => current.filter((workerId) => workerId !== partner.personId))
                }
                aria-label={`${tr("unlink")} ${partner.name}`}
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <Select
          value={partnerSelectValue}
          onValueChange={(value) => {
            const partnerId = Number(value);
            if (!Number.isInteger(partnerId) || selectedPartnerIds.includes(partnerId)) return;
            setSelectedPartnerIds((current) => [...current, partnerId].slice(0, remainingSlots));
            setPartnerSelectValue("");
          }}
        >
          <SelectTrigger
            className="h-7 min-w-[150px] text-xs"
            disabled={disabled || busy || selectedPartnerIds.length >= remainingSlots || partnerOptions.length === 0}
            data-testid={`select-link-partner-${row.personId}`}
          >
            <SelectValue placeholder={tr("chooseWorker")} />
          </SelectTrigger>
          <SelectContent>
            {partnerOptions.map((candidate) => (
              <SelectItem key={candidate.personId} value={String(candidate.personId)}>
                <span dir="auto">{candidate.name}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          size="sm"
          className="h-7 px-2 text-xs"
          disabled={disabled || busy || selectedPartnerIds.length === 0}
          onClick={() => linkMutation.mutate(selectedPartnerIds)}
          data-testid={`button-save-worker-links-${row.personId}`}
        >
          {linkMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : tr("link")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          disabled={disabled || busy}
          onClick={resetSelection}
        >
          {tr("cancel")}
        </Button>
      </div>
    </div>
  );
}
