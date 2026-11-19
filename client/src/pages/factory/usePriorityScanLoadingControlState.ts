// Extracted from ./PriorityScanLoadingControl.tsx
import { useCallback, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { apiRequest } from "@/lib/queryClient";
import { visibleTabInterval } from "@/lib/queryPolicies";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { translatePriorityScanText, type PriorityScanTranslationKey } from "@/i18n/priorityScanTranslations";
import {
  DEFAULT_PRIORITY_SCAN_COLOR,
  PRIORITY_SCAN_COLORS,
  isApprovedPriorityScanColor,
} from "@shared/priorityScanColors";

const PRIORITY_SCAN_CONFIGS_URL = "/api/factory/customer-orders/loading-list/priority-scan-configs";

const DEFAULT_COLOR = DEFAULT_PRIORITY_SCAN_COLOR;

interface PriorityScanConfig {
  id: number;
  orderId: number;
  color: string;
  priority: number;
  enabled: boolean;
}

export interface PriorityScanLoadingControlProps {
  load: {
    id: number;
    customerName: string;
    proformaIdUsed: number | null;
  };
}

export function normalizeColorKey(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

export function usePriorityScanLoadingControlState({ load }: Pick<PriorityScanLoadingControlProps, "load">) {
  const { language } = useApplicationLanguage();
  const tr = useCallback(
    (key: PriorityScanTranslationKey, params?: Record<string, string | number>) =>
      translatePriorityScanText(key, language, params),
    [language]
  );
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const recordChanges = useExistingRecordChangeAccess();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedColor, setSelectedColor] = useState<string>(DEFAULT_COLOR);
  const [selectedPriority, setSelectedPriority] = useState(1);

  const { data: configs = [] } = useQuery<PriorityScanConfig[]>({
    queryKey: [PRIORITY_SCAN_CONFIGS_URL],
    refetchInterval: visibleTabInterval(60_000),
  });

  const { data: currentUser } = useQuery<{ role?: string; currentRole?: string }>({
    queryKey: ["/api/auth/me"],
  });
  const effectiveRole = currentUser?.currentRole ?? currentUser?.role ?? "";
  const canManagePriority = effectiveRole === "Admin" || effectiveRole === "Developer" || effectiveRole === "Owner";

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
  const selectedColorApproved = isApprovedPriorityScanColor(selectedColor);
  // An active legacy priority keeps its saved color until a swatch is explicitly
  // chosen; saving it unchanged is a position-only update, never a recolor.
  const keepsLegacyColor =
    Boolean(activeConfig) &&
    !selectedColorApproved &&
    normalizeColorKey(selectedColor) === normalizeColorKey(activeConfig?.color ?? "");
  const canSaveColor = selectedColorApproved || (keepsLegacyColor && canManagePriority);

  const refreshQueue = async () => {
    await queryClient.invalidateQueries({ queryKey: [PRIORITY_SCAN_CONFIGS_URL] });
  };

  const saveMutation = useMutation({
    mutationFn: async ({ color, priority }: { color?: string; priority?: number }) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      if (color !== undefined && !isApprovedPriorityScanColor(color)) {
        throw new Error("Select one of the eleven approved Priority Scan colors.");
      }

      // Omitting color asks the server to keep the saved (legacy) color.
      const payload: { color?: string; enabled: boolean; priority?: number } = { enabled: true };
      if (color !== undefined) payload.color = color;
      if (canManagePriority && priority !== undefined) payload.priority = priority;

      const res = await apiRequest(
        "PUT",
        `/api/factory/customer-orders/${load.id}/loading-list/priority-scan-config`,
        payload
      );
      return res.json() as Promise<PriorityScanConfig>;
    },
    onSuccess: async (saved) => {
      await refreshQueue();
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
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      if (!activeConfig) throw new Error(tr("priorityNotActive"));
      // Position-only updates must not recolor active legacy priorities.
      const res = await apiRequest("PUT", `/api/factory/customer-orders/${load.id}/loading-list/priority-scan-config`, {
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
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
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
    const availableDefault =
      PRIORITY_SCAN_COLORS.find((color) => !usedColorKeys.has(normalizeColorKey(color))) ?? DEFAULT_COLOR;
    // Existing unsupported colors are retained in records, but may not be resaved.
    // Start from the saved legacy color with no swatch selected, so a new color
    // is only ever applied when the operator explicitly picks one.
    const initialColor = config?.color
      ? isApprovedPriorityScanColor(config.color)
        ? (PRIORITY_SCAN_COLORS.find((color) => normalizeColorKey(color) === normalizeColorKey(config.color)) ??
          availableDefault)
        : config.color
      : availableDefault;
    setSelectedColor(initialColor);
    setSelectedPriority(Math.min(config?.priority ?? maxSelectablePriority, maxSelectablePriority));
    setDialogOpen(true);
  };

  const selectPreset = (color: string) => {
    if (!isApprovedPriorityScanColor(color) || usedColorKeys.has(normalizeColorKey(color))) return;
    setSelectedColor(color);
  };

  const busy = saveMutation.isPending || moveMutation.isPending || removeMutation.isPending;
  return {
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
  };
}
