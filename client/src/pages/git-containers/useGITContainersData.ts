import type { ClientErrorLike } from "@/lib/clientError";
import { useEffect } from "react";
import { useMutation, type QueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { invalidateApiFamily } from "@/lib/frontendDataArchitecture";
import { BulkProgress } from "./gitContainerTypes";

interface UseGITContainersDataProps {
  isAllowed: boolean;
  refetch: () => void;
  toast: (opts: { title: string; description?: string; variant?: "destructive" | "default" }) => void;
  setImportResult: (
    v: { updated: number; skipped: number; notFound: number; errors: string[]; importId: string | null } | null
  ) => void;
  setShowProgressBanner: (v: boolean) => void;
  setBulkProgress: (v: BulkProgress) => void;
  queryClient: QueryClient;
  showProgressBanner: boolean;
}

export function useGITContainersData({
  isAllowed,
  refetch,
  toast,
  setImportResult,
  setShowProgressBanner,
  setBulkProgress,
  queryClient,
  showProgressBanner,
}: UseGITContainersDataProps) {
  const importMutation = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/git/containers/import-excel", {
        method: "POST",
        body: form,
        credentials: "include",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Import failed" }));
        throw new Error(err.message || "Import failed");
      }
      return res.json() as Promise<{
        updated: number;
        skipped: number;
        notFound: number;
        errors: string[];
        importId: string | null;
      }>;
    },
    onSuccess: (result) => {
      setImportResult(result);
      refetch();
      toast({
        title: `Import complete — ${result.updated} container${result.updated !== 1 ? "s" : ""} updated`,
        description: result.errors.length > 0 ? `${result.errors.length} row(s) had issues — see details.` : undefined,
      });
    },
    onError: (err: Error) => {
      toast({ title: "Import failed", description: err.message, variant: "destructive" });
    },
  });

  const undoImportMutation = useMutation({
    mutationFn: async (importId: string) => {
      const res = await apiRequest("POST", "/api/git/containers/import-excel/undo", { importId });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Undo failed" }));
        throw new Error(err.message || "Undo failed");
      }
      return res.json() as Promise<{ reverted: number }>;
    },
    onSuccess: (result) => {
      setImportResult(null);
      refetch();
      toast({ title: `Undo complete — ${result.reverted} container${result.reverted !== 1 ? "s" : ""} reverted` });
    },
    onError: (err: Error) => {
      toast({ title: "Undo failed", description: err.message, variant: "destructive" });
    },
  });

  const bulkEnableMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      const res = await apiRequest("POST", "/api/container-tracking/bulk-settings", { trackingEnabled: enabled });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Failed" }));
        throw new Error(err.message || "Failed");
      }
      return res.json() as Promise<{ updated: number; trackingEnabled: boolean }>;
    },
    onSuccess: (data) => {
      void invalidateApiFamily(queryClient, "/api/git/containers");
      toast({
        title: data.trackingEnabled
          ? `Auto-tracking enabled for ${data.updated} containers`
          : `Auto-tracking disabled for ${data.updated} containers`,
      });
    },
    onError: (err: ClientErrorLike) => toast({ title: "Failed", description: err.message, variant: "destructive" }),
  });

  const bulkTrackMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/container-tracking/bulk-track-now", {}, false, 120000);
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Failed" }));
        throw new Error(err.message || "Failed");
      }
      return res.json() as Promise<{ queued: number; message: string }>;
    },
    onSuccess: (data) => {
      toast({
        title: data.queued === 0 ? "No containers to track" : `Tracking started`,
        description: data.message,
      });
      if (data.queued > 0) {
        setShowProgressBanner(true);
      }
    },
    onError: (err: ClientErrorLike) =>
      toast({ title: "Track All failed", description: err.message, variant: "destructive" }),
  });

  const isBulkPending = bulkTrackMutation.isPending;

  useEffect(() => {
    if (!isAllowed) return;
    if (!isBulkPending && !showProgressBanner) return;

    let stopped = false;
    let intervalId: ReturnType<typeof setInterval> | null = null;
    let stopTimeoutId: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      if (stopped) return;
      try {
        const res = await fetch("/api/container-tracking/bulk-progress", { credentials: "include" });
        if (!res.ok || stopped) return;
        const data: BulkProgress = await res.json();
        setBulkProgress(data);
        if (data.running) setShowProgressBanner(true);
        if (!data.running && !stopTimeoutId && !bulkTrackMutation.isPending) {
          stopTimeoutId = setTimeout(() => {
            if (!stopped) {
              if (intervalId) {
                clearInterval(intervalId);
                intervalId = null;
              }
              void invalidateApiFamily(queryClient, "/api/git/containers");
            }
          }, 6000);
        }
      } catch {
        /* ignore transient network errors */
      }
    };

    poll();
    intervalId = setInterval(poll, 2000);

    return () => {
      stopped = true;
      if (intervalId) clearInterval(intervalId);
      if (stopTimeoutId) clearTimeout(stopTimeoutId);
    };
  }, [
    isBulkPending,
    showProgressBanner,
    isAllowed,
    queryClient,
    setBulkProgress,
    setShowProgressBanner,
    bulkTrackMutation.isPending,
  ]);

  return {
    importMutation,
    undoImportMutation,
    bulkEnableMutation,
    bulkTrackMutation,
  };
}
