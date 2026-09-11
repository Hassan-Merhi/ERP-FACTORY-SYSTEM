import type { ClientErrorLike } from "@/lib/clientError";
import { useState, useCallback } from "react";
import { useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { Container } from "@shared/schema";
import type { TrackingEdit, TrackingFieldEdits } from "./types";

export const trackingFields = [
  "shopName",
  "eta",
  "transporter",
  "transportFee",
  "numberPlate",
  "trackingLocation",
  "borderDate",
  "offloadDate",
  "agent",
  "dutyFee",
  "docReceived",
  "trackingDescription",
  "docsSentDate",
  "trackingLink",
] as const;

export const autoSizeStyle = (value: unknown, placeholder = "", minCh = 10, maxCh = 32) => {
  const text = String(value ?? "") || placeholder || "";
  const ch = Math.max(minCh, Math.min(maxCh, text.length + 2));
  return {
    width: `${ch}ch`,
    minWidth: `${minCh}ch`,
    maxWidth: `${maxCh}ch`,
  } as const;
};

export function useContainerTracking(filteredOtwContainers: Container[]) {
  const { toast } = useToast();
  const [trackingEdits, setTrackingEdits] = useState<TrackingEdit>({});
  const [savingIds, setSavingIds] = useState<Set<number>>(new Set());
  const [savingAll, setSavingAll] = useState(false);

  const updateTrackingMutation = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: TrackingFieldEdits }) => {
      const res = await apiRequest("PATCH", `/api/containers/${id}/tracking`, data);
      return res.json() as Promise<Container>;
    },
    onSuccess: (updatedContainer, { id }) => {
      // Immediately patch every cache entry that holds this container so that
      // the input doesn't revert to the stale server value while the
      // background refetch is in flight.
      queryClient.setQueriesData({ queryKey: ["/api/containers/active"], exact: false }, (old: unknown) => {
        if (!Array.isArray(old)) return old;
        return (old as Container[]).map((c) => (c.id === id ? { ...c, ...updatedContainer } : c));
      });
      queryClient.invalidateQueries({ queryKey: ["/api/containers/active"] });
      setTrackingEdits((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setSavingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      toast({ title: "Saved", description: "Tracking info updated" });
    },
    onError: (error: ClientErrorLike, { id }) => {
      if (error?._handledGlobally) return;
      setSavingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const getEditValue = (container: Container, field: keyof Container) => {
    if (trackingEdits[container.id] && trackingEdits[container.id][field] !== undefined) {
      return trackingEdits[container.id][field];
    }
    return container[field];
  };

  const setEditValue = async (containerId: number, field: keyof Container, value: unknown) => {
    setTrackingEdits((prev) => ({
      ...prev,
      [containerId]: { ...prev[containerId], [field]: value },
    }));
  };

  const hasChanges = useCallback(
    (containerId: number) => {
      return trackingEdits[containerId] && Object.keys(trackingEdits[containerId]).length > 0;
    },
    [trackingEdits]
  );

  const saveTracking = useCallback(
    async (containerId: number) => {
      const data = trackingEdits[containerId];
      if (!data) return;
      setSavingIds((prev) => new Set(prev).add(containerId));
      updateTrackingMutation.mutate({ id: containerId, data });
    },
    [trackingEdits, updateTrackingMutation]
  );

  const hasAnyChanges = Object.keys(trackingEdits).length > 0;

  const saveAllTracking = async () => {
    const containerIds = Object.keys(trackingEdits).map(Number);
    if (containerIds.length === 0) return;
    setSavingAll(true);
    let savedCount = 0;
    let errorCount = 0;
    for (const id of containerIds) {
      const data = trackingEdits[id];
      if (!data || Object.keys(data).length === 0) continue;
      try {
        const res = await apiRequest("PATCH", `/api/containers/${id}/tracking`, data);
        const updatedContainer: Container = await res.json();
        // Patch the cache immediately so the row shows the new value.
        queryClient.setQueriesData({ queryKey: ["/api/containers/active"], exact: false }, (old: unknown) => {
          if (!Array.isArray(old)) return old;
          return (old as Container[]).map((c) => (c.id === id ? { ...c, ...updatedContainer } : c));
        });
        savedCount++;
      } catch (_e) {
        errorCount++;
      }
    }
    queryClient.invalidateQueries({ queryKey: ["/api/containers/active"] });
    setTrackingEdits({});
    setSavingAll(false);
    if (errorCount === 0) {
      toast({ title: "Saved", description: `${savedCount} container(s) updated` });
    } else {
      toast({
        title: "Partial save",
        description: `${savedCount} saved, ${errorCount} failed`,
        variant: "destructive",
      });
    }
  };

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent, containerId: number, fieldIndex: number) => {
      const containerIndex = filteredOtwContainers.findIndex((c) => c.id === containerId);
      if (containerIndex === -1) return;

      const getInputId = (cIdx: number, fIdx: number) => {
        const container = filteredOtwContainers[cIdx];
        if (!container) return null;
        const field = trackingFields[fIdx];
        if (!field) return null;
        return `tracking-${container.id}-${field}`;
      };

      const focusInput = async (inputId: string | null) => {
        if (!inputId) return false;
        const el = document.getElementById(inputId) as HTMLInputElement | null;
        if (el) {
          el.focus();
          el.select?.();
          return true;
        }
        return false;
      };

      if (e.key === "Enter") {
        e.preventDefault();
        if (hasChanges(containerId)) saveTracking(containerId);
        const nextId = getInputId(containerIndex + 1, fieldIndex);
        if (nextId) focusInput(nextId);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        focusInput(getInputId(containerIndex + 1, fieldIndex));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        focusInput(getInputId(containerIndex - 1, fieldIndex));
      } else if (e.key === "ArrowRight" && e.altKey) {
        e.preventDefault();
        focusInput(getInputId(containerIndex, fieldIndex + 1));
      } else if (e.key === "ArrowLeft" && e.altKey) {
        e.preventDefault();
        focusInput(getInputId(containerIndex, fieldIndex - 1));
      }
    },
    [filteredOtwContainers, hasChanges, saveTracking]
  );

  return {
    trackingEdits,
    savingIds,
    savingAll,
    getEditValue,
    setEditValue,
    hasChanges,
    saveTracking,
    hasAnyChanges,
    saveAllTracking,
    handleKeyDown,
    autoSizeStyle,
    trackingFields,
  };
}
