import { ArrowDown, ArrowUp, Palette, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  PRIORITY_SCAN_COLORS,
  getPriorityScanLetter,
  getPriorityScanLetterInk,
  isApprovedPriorityScanColor,
} from "@shared/priorityScanColors";
import { PriorityScanColorLetter } from "./PriorityScanColorLetter";
import { confirmAction } from "@/components/ConfirmHost";
import {
  usePriorityScanLoadingControlState,
  normalizeColorKey,
  type PriorityScanLoadingControlProps,
} from "./usePriorityScanLoadingControlState";

export function PriorityScanLoadingControl({ load }: PriorityScanLoadingControlProps) {
  const {
    tr,
    recordChanges,
    dialogOpen,
    setDialogOpen,
    selectedColor,
    selectedPriority,
    setSelectedPriority,
    canManagePriority,
    activeConfigs,
    config,
    activeConfig,
    maxSelectablePriority,
    usedColorKeys,
    selectedColorInUse,
    keepsLegacyColor,
    canSaveColor,
    saveMutation,
    moveMutation,
    removeMutation,
    openEditor,
    selectPreset,
    busy,
  } = usePriorityScanLoadingControlState({ load });

  // Read-only roles see the saved priority but get no controls that change it.
  if (!recordChanges.allowed) {
    if (!activeConfig) return null;
    return (
      <div className="flex items-center gap-2 text-sm" data-testid={`priority-config-readonly-${load.id}`}>
        <PriorityScanColorLetter color={activeConfig.color} size="sm" />
        {tr("priorityNumber", { priority: activeConfig.priority })}
      </div>
    );
  }

  return (
    <>
      <div className="flex items-center gap-1">
        {activeConfig ? (
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={openEditor}
              disabled={busy}
              data-testid={`button-priority-config-${load.id}`}
              title={canManagePriority ? tr("editPriorityTitle") : tr("editColorTitle")}
            >
              <PriorityScanColorLetter color={activeConfig.color} size="sm" />
              {canManagePriority ? tr("priorityNumber", { priority: activeConfig.priority }) : tr("editColor")}
            </Button>
            {canManagePriority && (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => moveMutation.mutate(activeConfig.priority - 1)}
                  disabled={busy || activeConfig.priority <= 1}
                  data-testid={`button-priority-up-${load.id}`}
                  title={tr("moveUp")}
                >
                  <ArrowUp className="h-3.5 w-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => moveMutation.mutate(activeConfig.priority + 1)}
                  disabled={busy || activeConfig.priority >= activeConfigs.length}
                  data-testid={`button-priority-down-${load.id}`}
                  title={tr("moveDown")}
                >
                  <ArrowDown className="h-3.5 w-3.5" />
                </Button>
              </>
            )}
          </>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={openEditor}
            disabled={busy || !load.proformaIdUsed}
            data-testid={`button-set-priority-${load.id}`}
            title={load.proformaIdUsed ? tr("addToQueue") : tr("linkProformaFirst")}
          >
            <Palette className="h-4 w-4 mr-1.5" />
            {canManagePriority ? tr("setPriority") : tr("setColor")}
          </Button>
        )}
      </div>

      <Dialog open={dialogOpen} onOpenChange={(open) => !busy && setDialogOpen(open)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{tr("dialogTitle", { orderId: load.id })}</DialogTitle>
            <DialogDescription>
              {tr(canManagePriority ? "dialogDescription" : "colorOnlyDialogDescription", {
                customer: load.customerName,
              })}
            </DialogDescription>
          </DialogHeader>

          {!load.proformaIdUsed && (
            <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100">
              {tr("linkProformaWarning")}
            </div>
          )}

          <div className="space-y-5 py-2">
            <div className="space-y-2">
              <Label>{tr("priorityColorLabel")}</Label>
              <div className="flex flex-wrap items-center gap-2">
                {PRIORITY_SCAN_COLORS.map((color) => {
                  const unavailable = usedColorKeys.has(normalizeColorKey(color));
                  const selected = normalizeColorKey(selectedColor) === normalizeColorKey(color);
                  return (
                    <button
                      key={color}
                      type="button"
                      className={`h-8 w-8 inline-flex items-center justify-center rounded-full border-2 font-bold text-sm transition-transform ${selected ? "border-foreground scale-110" : "border-border"} ${unavailable ? "opacity-30 cursor-not-allowed" : "hover:scale-105"}`}
                      style={{ backgroundColor: color, color: getPriorityScanLetterInk(color) }}
                      onClick={() => selectPreset(color)}
                      disabled={unavailable}
                      aria-label={tr("useColor", { color })}
                      title={unavailable ? tr("colorUsed") : `${getPriorityScanLetter(color)} · ${color}`}
                    >
                      <span aria-hidden="true">{getPriorityScanLetter(color)}</span>
                    </button>
                  );
                })}
                <Badge variant="outline" className="font-mono text-xs" aria-live="polite">
                  {getPriorityScanLetter(selectedColor) ? `${getPriorityScanLetter(selectedColor)} · ` : ""}
                  {selectedColor.toUpperCase()}
                </Badge>
              </div>
              {config?.color && !isApprovedPriorityScanColor(config.color) && (
                <p className="text-xs text-muted-foreground" data-testid={`legacy-priority-color-${load.id}`}>
                  {tr("legacyPriorityColorNotice", { color: config.color })}
                </p>
              )}
              {selectedColorInUse && <p className="text-xs text-destructive">{tr("colorAlreadyAssigned")}</p>}
            </div>

            {canManagePriority && (
              <div className="space-y-2">
                <Label htmlFor={`priority-position-${load.id}`}>{tr("queuePosition")}</Label>
                <Select value={String(selectedPriority)} onValueChange={(value) => setSelectedPriority(Number(value))}>
                  <SelectTrigger id={`priority-position-${load.id}`} data-testid={`select-priority-${load.id}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Array.from({ length: maxSelectablePriority }, (_, index) => index + 1).map((position) => (
                      <SelectItem key={position} value={String(position)}>
                        {tr("priorityNumber", { priority: position })}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">{tr("autoAdvanceHint")}</p>
              </div>
            )}
          </div>

          <DialogFooter className="sm:justify-between gap-2">
            <div>
              {config && canManagePriority && (
                <Button
                  type="button"
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  onClick={async () => {
                    const confirmed = await confirmAction({
                      title: tr("removePriority") + "?",
                      confirmText: tr("removePriority"),
                      tone: "destructive",
                    });
                    if (confirmed) removeMutation.mutate();
                  }}
                  disabled={busy}
                  data-testid={`button-remove-priority-${load.id}`}
                >
                  <Trash2 className="h-4 w-4 mr-1.5" />
                  {tr("removePriority")}
                </Button>
              )}
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={() => setDialogOpen(false)} disabled={busy}>
                {tr("cancel")}
              </Button>
              <Button
                type="button"
                onClick={() =>
                  saveMutation.mutate({
                    color: keepsLegacyColor ? undefined : selectedColor,
                    priority: canManagePriority ? selectedPriority : undefined,
                  })
                }
                disabled={busy || !load.proformaIdUsed || selectedColorInUse || !canSaveColor}
                data-testid={`button-save-priority-${load.id}`}
              >
                {saveMutation.isPending
                  ? tr("saving")
                  : canManagePriority
                    ? config
                      ? tr("savePriority")
                      : tr("addToQueue")
                    : tr("saveColor")}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
