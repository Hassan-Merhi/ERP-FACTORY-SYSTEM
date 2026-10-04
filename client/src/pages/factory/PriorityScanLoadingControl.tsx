import { useCallback, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { visibleTabInterval } from "@/lib/queryPolicies";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { translatePriorityScanText, type PriorityScanTranslationKey } from "@/i18n/priorityScanTranslations";

const PRIORITY_SCAN_CONFIGS_URL = "/api/factory/customer-orders/loading-list/priority-scan-configs";
const DEFAULT_COLOR = "#2563eb";
const COLOR_PRESETS = [
  "#2563eb",
  "#16a34a",
  "#dc2626",
  "#f59e0b",
  "#7c3aed",
  "#0891b2",
  "#db2777",
  "#111827",
];

interface PriorityScanConfig {
  id: number;
  orderId: number;
  color: string;
  priority: number;
  enabled: boolean;
}

interface PriorityScanLoadingControlProps {
  load: {
    id: number;
    customerName: string;
    proformaIdUsed: number | null;
  };
}

function isHexColor(value: string | null | undefined): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

function normalizeColorKey(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

export function PriorityScanLoadingControl({ load }: PriorityScanLoadingControlProps) {
  const { language } = useApplicationLanguage();
  const tr = useCallback(
    (key: PriorityScanTranslationKey, params?: Record<string, string | number>) =>
      translatePriorityScanText(key, language, params),
    [language]
  );
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedColor, setSelectedColor] = useState(DEFAULT_COLOR);
  const [selectedPriority, setSelectedPriority] = useState(1);

  const { data: configs = [] } = useQuery<PriorityScanConfig[]>({
    queryKey: [PRIORITY_SCAN_CONFIGS_URL],
    refetchInterval: visibleTabInterval(60_000),
  });

  const activeConfigs = useMemo(
    () => configs.filter((config) => config.enabled).sort((a, b) => a.priority - b.priority || a.orderId - b.orderId),
    [configs]
  );
  const config = configs.find((item) => item.orderId === load.id);
  const activeConfig = config?.enabled ? config : undefined;
  const maxSelectablePriority = Math.max(
    1,
    activeConfigs.filter((item) => item.orderId !== load.id).length + 1
  );
  const usedColorKeys = useMemo(
    () =>
      new Set(
        activeConfigs
          .filter((item) => item.orderId !== load.id)
          .map((item) => normalizeColorKey(item.color))
      ),
    [activeConfigs, load.id]
  );
  const selectedColorInUse = usedColorKeys.has(normalizeColorKey(selectedColor));

  const refreshQueue = async () => {
    await queryClient.invalidateQueries({ queryKey: [PRIORITY_SCAN_CONFIGS_URL] });
  };

  const saveMutation = useMutation({
    mutationFn: async ({ color, priority }: { color: string; priority: number }) => {
      const res = await apiRequest(
        "PUT",
        `/api/factory/customer-orders/${load.id}/loading-list/priority-scan-config`,
        { color, priority, enabled: true }
      );
      return res.json() as Promise<PriorityScanConfig>;
    },
    onSuccess: async (saved) => {
      await refreshQueue();
      setDialogOpen(false);
      toast({
        title: tr("prioritySaved", { priority: saved.priority }),
        description: tr("loadingNowQueued", { orderId: load.id }),
      });
    },
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })._handledGlobally) return;
      toast({ title: tr("priorityUpdateFailed"), description: error.message, variant: "destructive" });
    },
  });

  const moveMutation = useMutation({
    mutationFn: async (priority: number) => {
      if (!activeConfig) throw new Error(tr("priorityNotActive"));
      const res = await apiRequest(
        "PUT",
        `/api/factory/customer-orders/${load.id}/loading-list/priority-scan-config`,
        { color: activeConfig.color, priority, enabled: true }
      );
      return res.json() as Promise<PriorityScanConfig>;
    },
    onSuccess: refreshQueue,
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })._handledGlobally) return;
      toast({ title: tr("couldNotMove"), description: error.message, variant: "destructive" });
    },
  });

  const removeMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("DELETE", `/api/factory/customer-orders/${load.id}/loading-list/priority-scan-config`);
    },
    onSuccess: async () => {
      await refreshQueue();
      setDialogOpen(false);
      toast({ title: tr("priorityRemoved"), description: tr("loadingRemovedFromQueue", { orderId: load.id }) });
    },
    onError: (error: Error) => {
      if ((error as { _handledGlobally?: boolean })._handledGlobally) return;
      toast({ title: tr("couldNotRemove"), description: error.message, variant: "destructive" });
    },
  });

  const openEditor = () => {
    setSelectedColor(isHexColor(config?.color) ? config.color : DEFAULT_COLOR);
    setSelectedPriority(Math.min(config?.priority ?? maxSelectablePriority, maxSelectablePriority));
    setDialogOpen(true);
  };

  const busy = saveMutation.isPending || moveMutation.isPending || removeMutation.isPending;

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
              title={tr("editPriorityTitle")}
            >
              <span
                className="h-3.5 w-3.5 rounded-full border border-black/15 shadow-sm"
                style={{ backgroundColor: activeConfig.color }}
                aria-hidden="true"
              />
              {tr("priorityNumber", { priority: activeConfig.priority })}
            </Button>
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
            {tr("setPriority")}
          </Button>
        )}
      </div>

      <Dialog open={dialogOpen} onOpenChange={(open) => !busy && setDialogOpen(open)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{tr("dialogTitle", { orderId: load.id })}</DialogTitle>
            <DialogDescription>
              {tr("dialogDescription", { customer: load.customerName })}
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
                {COLOR_PRESETS.map((color) => {
                  const unavailable = usedColorKeys.has(normalizeColorKey(color));
                  const selected = normalizeColorKey(selectedColor) === normalizeColorKey(color);
                  return (
                    <button
                      key={color}
                      type="button"
                      className={`h-8 w-8 rounded-full border-2 transition-transform ${selected ? "border-foreground scale-110" : "border-border"} ${unavailable ? "opacity-30 cursor-not-allowed" : "hover:scale-105"}`}
                      style={{ backgroundColor: color }}
                      onClick={() => !unavailable && setSelectedColor(color)}
                      disabled={unavailable}
                      aria-label={tr("useColor", { color })}
                      title={unavailable ? tr("colorUsed") : color}
                    />
                  );
                })}
                <div className="ml-1 flex items-center gap-2">
                  <input
                    type="color"
                    value={isHexColor(selectedColor) ? selectedColor : DEFAULT_COLOR}
                    onChange={(event) => setSelectedColor(event.target.value)}
                    className="h-9 w-12 cursor-pointer rounded border border-border bg-transparent p-0.5"
                    data-testid={`input-priority-color-${load.id}`}
                    aria-label={tr("chooseCustomColor")}
                  />
                  <Badge variant="outline" className="font-mono text-xs">
                    {selectedColor.toUpperCase()}
                  </Badge>
                </div>
              </div>
              {selectedColorInUse && (
                <p className="text-xs text-destructive">{tr("colorAlreadyAssigned")}</p>
              )}
            </div>

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
              <p className="text-xs text-muted-foreground">
                {tr("autoAdvanceHint")}
              </p>
            </div>
          </div>

          <DialogFooter className="sm:justify-between gap-2">
            <div>
              {config && (
                <Button
                  type="button"
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  onClick={() => removeMutation.mutate()}
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
                onClick={() => saveMutation.mutate({ color: selectedColor, priority: selectedPriority })}
                disabled={busy || !load.proformaIdUsed || selectedColorInUse}
                data-testid={`button-save-priority-${load.id}`}
              >
                {saveMutation.isPending ? tr("saving") : config ? tr("savePriority") : tr("addToQueue")}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
