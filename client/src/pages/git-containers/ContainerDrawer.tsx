import type { ClientErrorLike } from "@/lib/clientError";
import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { companyDataKey, frontendQueryPolicies, invalidateApiFamily } from "@/lib/frontendDataArchitecture";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { EnrichedContainerRow, DrawerForm, seedForm } from "./gitContainerTypes";
import { ContainerDrawerForm } from "./ContainerDrawerForm";
import {
  ContainerDrawerTracking,
  type TrackProgressStep,
  type TrackingEvent,
  type TrackingStatus,
} from "./ContainerDrawerTracking";

export function ContainerDrawer({
  container,
  open,
  onClose,
  sessionCompanyId,
}: {
  container: EnrichedContainerRow | null;
  open: boolean;
  onClose: () => void;
  sessionCompanyId: number | null;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<DrawerForm | null>(null);
  const [trackEnabled, setTrackEnabled] = useState(true);
  const [trackAutoUpdate, setTrackAutoUpdate] = useState(true);
  const [trackCarrierHint, setTrackCarrierHint] = useState("");
  const [showEvents, setShowEvents] = useState(false);

  useEffect(() => {
    if (open && container) {
      setForm(seedForm(container));
      setTrackEnabled(container.trackingEnabled ?? false);
      setTrackAutoUpdate(container.trackingAutoUpdate ?? true);
      setTrackCarrierHint(container.trackingCarrierHint ?? "");
    }
  }, [open, container]);

  const set = <K extends keyof DrawerForm>(field: K, val: DrawerForm[K]) =>
    setForm((prev) => (prev ? { ...prev, [field]: val } : prev));

  const canEdit = sessionCompanyId === null || !container || container.companyId === sessionCompanyId;

  const maxOffload = (() => {
    if (!form?.borderDate) return null;
    const d = new Date(form.borderDate);
    const t = (form.transporter ?? "").toUpperCase();
    const days = t.includes("FARHAT") || t.includes("CONTINENTAL") ? 11 : 14;
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  })();

  const daysDelayed = (() => {
    if ((form?.numberPlate ?? "").trim()) return null;
    if (!form?.eta) return null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const arrival = new Date(form.eta);
    if (isNaN(arrival.getTime())) return null;
    const diff = Math.floor((today.getTime() - arrival.getTime()) / 86400000);
    return diff > 0 ? diff : null;
  })();

  const mutation = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      apiRequest("PATCH", `/api/containers/${container!.id}/tracking`, data),
    onSuccess: () => {
      void invalidateApiFamily(queryClient, "/api/git/containers");
      toast({ title: "Saved", description: `\${container?.containerNumber} updated.` });
      onClose();
    },
    onError: (err: ClientErrorLike) => {
      toast({
        title: "Save failed",
        description: err?.message ?? "Unknown error",
        variant: "destructive",
      });
    },
  });

  const trackingSettingsMutation = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      apiRequest("PATCH", `/api/container-tracking/${container!.id}/settings`, data),
    onSuccess: () => {
      void invalidateApiFamily(queryClient, "/api/git/containers");
      toast({ title: "Tracking settings saved" });
    },
    onError: (err: ClientErrorLike) => {
      toast({ title: "Save failed", description: err?.message ?? "Unknown error", variant: "destructive" });
    },
  });

  type TrackNowResult = {
    success: boolean;
    containerNumber: string;
    provider: string | null;
    lastStatus: string | null;
    oldEta: string | null;
    newEta: string | null;
    etaChanged: boolean;
    attempts: Array<{ provider: string; status: string; error: string | null }>;
    error: string | null;
    quotaWarning?: string;
  };

  const trackNowMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/container-tracking/${container!.id}/track-now`, {}, false, 15000);
      return res.json() as Promise<{ started: true; containerNumber: string } | TrackNowResult>;
    },
    onSuccess: (data) => {
      const ALL_KEYS = ["/api/git/containers", "/api/containers", "/api/containers/active"];

      if ("started" in data && data.started) {
        toast({
          title: "Tracking started",
          description: "Results will refresh shortly.",
        });
        let polls = 0;
        const interval = setInterval(() => {
          polls++;
          ALL_KEYS.forEach((k) => queryClient.invalidateQueries({ queryKey: [k] }));
          if (polls >= 10) clearInterval(interval);
        }, 8000);
        return;
      }

      ALL_KEYS.forEach((k) => queryClient.invalidateQueries({ queryKey: [k] }));
      const result = data as TrackNowResult;
      if (result.success) {
        const etaLine = result.etaChanged
          ? `ETA: ${result.newEta ?? "—"} (was ${result.oldEta ?? "none"})`
          : result.newEta
            ? `ETA unchanged: ${result.newEta}`
            : "No ETA returned — previous ETA kept";
        toast({
          title: `Tracked: ${result.containerNumber}`,
          description: `${result.provider ?? "unknown"} — ${etaLine}`,
        });
      } else {
        const tried =
          result.attempts?.length > 0
            ? result.attempts.map((a) => `${a.provider}: ${a.status}`).join(" → ")
            : "No providers available";
        toast({
          title: "All providers failed",
          description: tried,
          variant: "destructive",
        });
      }
      if (result.quotaWarning) {
        setTimeout(() => toast({ title: "Quota low", description: result.quotaWarning, variant: "destructive" }), 400);
      }
    },
    onError: (err: ClientErrorLike) => {
      toast({ title: "Track Now failed", description: err?.message ?? "Unknown error", variant: "destructive" });
    },
  });

  const [trackProgress, setTrackProgress] = useState<TrackProgressStep[]>([]);
  const trackProgressIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (trackNowMutation.isPending && container?.id) {
      setTrackProgress([]);
      trackProgressIntervalRef.current = setInterval(async () => {
        try {
          const res = await fetch(`/api/container-tracking/${container.id}/progress`, { credentials: "include" });
          if (res.ok) setTrackProgress(await res.json());
        } catch {
          /* ignore */
        }
      }, 600);
    } else {
      if (trackProgressIntervalRef.current) {
        clearInterval(trackProgressIntervalRef.current);
        trackProgressIntervalRef.current = null;
        setTimeout(() => setTrackProgress([]), 20_000);
      }
    }
    return () => {
      if (trackProgressIntervalRef.current) clearInterval(trackProgressIntervalRef.current);
    };
  }, [trackNowMutation.isPending, container?.id]);

  const eventsQueryKey = container?.id ? `/api/container-tracking/${container.id}/events` : null;
  const trackingCompanyIdentity = sessionCompanyId ?? container?.companyId ?? "no-company";
  const { data: events, isLoading: eventsLoading } = useQuery<TrackingEvent[]>({
    queryKey: eventsQueryKey
      ? companyDataKey(eventsQueryKey, trackingCompanyIdentity, "container-tracking-events")
      : [],
    enabled: showEvents && !!eventsQueryKey,
    ...frontendQueryPolicies.operational,
  });

  const { data: trackingStatus } = useQuery<TrackingStatus>({
    queryKey: ["/api/container-tracking/status"],
    staleTime: 5 * 60_000,
  });

  function handleSave() {
    if (!container || !form) return;
    mutation.mutate({
      eta: form.eta || null,
      status: form.status,
      transporter: form.transporter || null,
      transportFee: form.transportFee || null,
      numberPlate: form.numberPlate || null,
      trackingLocation: form.trackingLocation || null,
      borderDate: form.borderDate || null,
      agent: form.agent || null,
      dutyFee: form.dutyFee || null,
      docReceived: form.docReceived,
      docsSentDate: form.docsSentDate || null,
      trackingLink: form.trackingLink || null,
      trackingDescription: form.trackingDescription || null,
      blDocs: form.blDocs || null,
      shopName: form.shopName || null,
    });
  }

  if (!container || !form) return null;

  return (
    <Sheet
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto">
        <SheetHeader className="pb-2">
          <SheetTitle className="text-base font-mono">{container.containerNumber}</SheetTitle>
          <SheetDescription className="text-xs">{container.companyName} — Container Logistics</SheetDescription>
        </SheetHeader>

        <ContainerDrawerForm
          form={form}
          set={set}
          container={container}
          canEdit={canEdit}
          maxOffload={maxOffload}
          daysDelayed={daysDelayed}
        />

        <ContainerDrawerTracking
          container={container}
          trackEnabled={trackEnabled}
          setTrackEnabled={setTrackEnabled}
          trackAutoUpdate={trackAutoUpdate}
          setTrackAutoUpdate={setTrackAutoUpdate}
          trackCarrierHint={trackCarrierHint}
          setTrackCarrierHint={setTrackCarrierHint}
          trackingSettingsMutation={trackingSettingsMutation}
          trackNowMutation={trackNowMutation}
          trackNowResult={trackNowMutation.data}
          trackProgress={trackProgress}
          trackingStatus={trackingStatus}
          showEvents={showEvents}
          setShowEvents={setShowEvents}
          events={events}
          eventsLoading={eventsLoading}
          canEdit={canEdit}
        />

        <div className="pt-4 sticky bottom-0 bg-background pb-2">
          <Button
            className="w-full"
            onClick={handleSave}
            disabled={!canEdit || mutation.isPending}
            data-testid="button-save-drawer"
          >
            {mutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save Changes
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
