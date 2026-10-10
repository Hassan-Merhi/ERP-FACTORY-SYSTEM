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
import { DEFAULT_PRIORITY_SCAN_COLOR, PRIORITY_SCAN_COLORS } from "@shared/priorityScanColors";

const PRIORITY_SCAN_CONFIGS_URL = "/api/factory/customer-orders/loading-list/priority-scan-configs";
const FACTORY_SETTINGS_URL = "/api/factory/settings";
const DEFAULT_COLOR_PRESETS = PRIORITY_SCAN_COLORS;
const DEFAULT_COLOR = DEFAULT_PRIORITY_SCAN_COLOR;
const PRIORITY_SCAN_PALETTE_SIZE = PRIORITY_SCAN_COLORS.length;

interface PriorityScanConfig {
  id: number;
  orderId: number;
  color: string;
  priority: number;
  enabled: boolean;
}

interface FactorySettingsResponse {
  priorityScanColorPresets?: unknown;
  [key: string]: unknown;
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

function resolveColorPresets(raw: unknown): string[] {
  const saved = Array.isArray(raw) ? raw.filter((value): value is string => isHexColor(value)) : [];
  const colors = saved.slice(0, PRIORITY_SCAN_PALETTE_SIZE);

  for (const fallback of DEFAULT_COLOR_PRESETS) {
    if (colors.length >= PRIORITY_SCAN_PALETTE_SIZE) break;
    if (!colors.some((color) => normalizeColorKey(color) === normalizeColorKey(fallback))) {
      colors.push(fallback);
    }
  }

  return colors.slice(0, PRIORITY_SCAN_PALETTE_SIZE);
}

function samePalette(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((color, index) => normalizeColorKey(color) === normalizeColorKey(right[index] ?? ""))
  );
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
  const [selectedColor, setSelectedColor] = useState<string>(DEFAULT_COLOR);
  const [selectedPriority, setSelectedPriority] = useState(1);
  const [selectedPresetIndex, setSelectedPresetIndex] = useState<number | null>(0);
  const [draftColorPresets, setDraftColorPresets] = useState<string[]>([...DEFAULT_COLOR_PRESETS]);

  const { data: configs = [] } = useQuery<PriorityScanConfig[]>({
    queryKey: [PRIORITY_SCAN_CONFIGS_URL],
    refetchInterval: visibleTabInterval(60_000),
  });

  const { data: factorySettings } = useQuery<FactorySettingsResponse>({
    queryKey: [FACTORY_SETTINGS_URL],
    refetchInterval: visibleTabInterval(60_000),
  });

  const { data: currentUser } = useQuery<{ role?: string; currentRole?: string }>({
    queryKey: ["/api/auth/me"],
  });
  const effectiveRole = currentUser?.currentRole ?? currentUser?.role ?? "";
  const canManagePriority = effectiveRole === "Admin" || effectiveRole === "Developer" || effectiveRole === "Owner";

  const colorPresets = useMemo(
    () => resolveColorPresets(factorySettings?.priorityScanColorPresets),
    [factorySettings?.priorityScanColorPresets]
  );

  const activeConfigs = useMemo(
    () => configs.filter((config) => config.enabled).sort((a, b) => a.priority - b.priority || a.orderId - b.orderId),
    [configs]
  );
  const config = configs.find((item) => item.orderId === load.id);
  const activeConfig = config?.enabled ? config : undefined;
  const maxSelectablePriority = Math.max(1, activeConfigs.filter((item) => item.orderId !== load.id).length + 1);
  const usedColorKeys = useMemo(
    () =>
      new Set(activeConfigs.filter((item) => item.orderId !== load.id).map((item) => normalizeColorKey(item.color))),
    [activeConfigs, load.id]
  );
  const selectedColorInUse = usedColorKeys.has(normalizeColorKey(selectedColor));

  const refreshQueue = async () => {
    await queryClient.invalidateQueries({ queryKey: [PRIORITY_SCAN_CONFIGS_URL] });
  };

  const saveMutation = useMutation({
    mutationFn: async ({ color, priority, palette }: { color: string; priority?: number; palette: string[] }) => {
      if (canManagePriority && !samePalette(palette, colorPresets)) {
        const paletteRes = await apiRequest("PUT", FACTORY_SETTINGS_URL, {
          priorityScanColorPresets: palette,
        });
        const savedSettings = (await paletteRes.json()) as FactorySettingsResponse;
        queryClient.setQueryData([FACTORY_SETTINGS_URL], savedSettings);
      }

      const payload: { color: string; enabled: boolean; priority?: number } = {
        color,
        enabled: true,
      };
      if (canManagePriority && priority !== undefined) payload.priority = priority;

      const res = await apiRequest(
        "PUT",
        `/api/factory/customer-orders/${load.id}/loading-list/priority-scan-config`,
        payload
      );
      return res.json() as Promise<PriorityScanConfig>;
    },
    onSuccess: async (saved) => {
      await Promise.all([refreshQueue(), queryClient.invalidateQueries({ queryKey: [FACTORY_SETTINGS_URL] })]);
      setDialogOpen(false);
      toast({
        title: canManagePriority ? tr("prioritySaved", { priority: saved.priority }) : tr("colorSaved"),
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
      const res = await apiRequest("PUT", `/api/factory/customer-orders/${load.id}/loading-list/priority-scan-config`, {
        color: activeConfig.color,
        priority,
        enabled: true,
      });
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
    const currentPalette = [...colorPresets];
    const configuredColor = isHexColor(config?.color) ? config.color : null;
    const availableDefault =
      currentPalette.find((color) => !usedColorKeys.has(normalizeColorKey(color))) ??
      currentPalette[0] ??
      DEFAULT_COLOR;
    const initialColor = configuredColor ?? availableDefault;
    const initialPresetIndex = currentPalette.findIndex(
      (color) => normalizeColorKey(color) === normalizeColorKey(initialColor)
    );

    setDraftColorPresets(currentPalette);
    setSelectedColor(initialColor);
    setSelectedPresetIndex(initialPresetIndex >= 0 ? initialPresetIndex : null);
    setSelectedPriority(Math.min(config?.priority ?? maxSelectablePriority, maxSelectablePriority));
    setDialogOpen(true);
  };

  const selectPreset = (color: string, index: number) => {
    if (usedColorKeys.has(normalizeColorKey(color))) return;
    setSelectedPresetIndex(index);
    setSelectedColor(color);
  };

  const updateSelectedPresetColor = (color: string) => {
    setSelectedColor(color);

    if (selectedPresetIndex === null) return;
    setDraftColorPresets((current) => {
      const next = [...current];
      next[selectedPresetIndex] = color;
      return next;
    });
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
              title={canManagePriority ? tr("editPriorityTitle") : tr("editColorTitle")}
            >
              <span
                className="h-3.5 w-3.5 rounded-full border border-black/15 shadow-sm"
                style={{ backgroundColor: activeConfig.color }}
                aria-hidden="true"
              />
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
                {draftColorPresets.map((color, index) => {
                  const unavailable = usedColorKeys.has(normalizeColorKey(color));
                  const selected =
                    selectedPresetIndex === index && normalizeColorKey(selectedColor) === normalizeColorKey(color);
                  return (
                    <button
                      key={index}
                      type="button"
                      className={`h-8 w-8 rounded-full border-2 transition-transform ${selected ? "border-foreground scale-110" : "border-border"} ${unavailable ? "opacity-30 cursor-not-allowed" : "hover:scale-105"}`}
                      style={{ backgroundColor: color }}
                      onClick={() => selectPreset(color, index)}
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
                    onChange={(event) => updateSelectedPresetColor(event.target.value)}
                    className="h-9 w-12 cursor-pointer rounded border border-border bg-transparent p-0.5"
                    data-testid={`input-priority-color-${load.id}`}
                    aria-label={tr("chooseCustomColor")}
                  />
                  <Badge variant="outline" className="font-mono text-xs">
                    {selectedColor.toUpperCase()}
                  </Badge>
                </div>
              </div>
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
                onClick={() =>
                  saveMutation.mutate({
                    color: selectedColor,
                    priority: canManagePriority ? selectedPriority : undefined,
                    palette: draftColorPresets,
                  })
                }
                disabled={busy || !load.proformaIdUsed || selectedColorInUse}
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
